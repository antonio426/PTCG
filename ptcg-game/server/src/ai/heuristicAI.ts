import { GameCard, LegalAction } from '@ptcg/shared';
import type { PtcgGameState, PtcgPlayerState } from '../game/GameState';
import { canPayEnergyCost } from '../game/validation';
import { calculateDamageBreakdown, effectiveMaxHp } from '../game/damage';
import type { IAIPlayer } from './aiPlayer';

// Moves within this many points of the top score are treated as equally good and tie-broken
// randomly — keeps the AI from being a fully deterministic, memorizable opponent.
const TIE_EPSILON = 5;

function remainingHp(G: PtcgGameState, card: GameCard): number {
  return Math.max(0, effectiveMaxHp(G, card) - card.damage);
}

function findPokemon(player: PtcgPlayerState, id: string): GameCard | null {
  if (player.active?.id === id) return player.active;
  return player.bench.find(c => c?.id === id) ?? null;
}

/**
 * Greedy, 0-ply move scorer — for each legal move, reads the real game state (damage numbers,
 * HP, energy payability) to assign a score, then picks the best (random tie-break among
 * near-equal top scores). Deliberately NOT a game-tree search: no state cloning/simulation,
 * except one narrow allowance in `scoreRetreat` (a single reverse damage-breakdown query against
 * the opponent's active, since "am I about to die" is cheap to check and unusually high-value).
 * This replaces MockAI, whose entire "logic" was a hardcoded move-TYPE priority list that never
 * read gameState at all (blind to damage, HP, lethality, or payability).
 */
export class HeuristicAI implements IAIPlayer {
  name = 'HeuristicAI';

  async decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]) {
    const idx = playerIndex as 0 | 1;
    const usable = legalMoves.filter(m => m.type !== 'forfeit');
    const pool = usable.length > 0 ? usable : legalMoves;
    const scored = pool.map(move => ({ move, score: this.scoreMove(gameState, idx, move) }));
    const maxScore = Math.max(...scored.map(s => s.score));
    const top = scored.filter(s => s.score >= maxScore - TIE_EPSILON);
    const pick = (top.length > 0 ? top : scored)[Math.floor(Math.random() * (top.length > 0 ? top.length : scored.length))] ?? { move: legalMoves[0], score: 0 };
    return { action: pick.move, thought: `評分 ${pick.score.toFixed(1)}：${pick.move.description}` };
  }

  private scoreMove(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    switch (move.type) {
      case 'attack': return this.scoreAttack(G, playerIndex, move);
      case 'evolve_pokemon': return this.scoreEvolve(G, playerIndex, move);
      case 'attach_energy': return this.scoreAttachEnergy(G, playerIndex, move);
      case 'play_pokemon': return this.scorePlayPokemon(G, playerIndex);
      case 'play_trainer': return this.scorePlayTrainer(G, playerIndex, move);
      case 'use_ability': return this.scoreUseAbility(G, playerIndex, move);
      case 'retreat': return this.scoreRetreat(G, playerIndex);
      case 'draw_card': return 20;
      case 'end_turn': return this.scoreEndTurn(G, playerIndex);
      case 'resolve_choice': return this.scoreResolveChoice(G, playerIndex, move);
      default: return 10;
    }
  }

  private scoreAttack(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const opponent = G.players[(1 - playerIndex) as 0 | 1];
    const attacker = player.active;
    const defender = opponent.active;
    if (!attacker || !defender) return 0;
    const attackIndex = move.payload?.attackIndex as number;
    const attack = attacker.cardData.attacks?.[attackIndex];
    if (!attack) return 0;
    const breakdown = calculateDamageBreakdown(G, playerIndex, attacker, attack, defender);
    let score = breakdown.finalDamage;
    const defenderRemaining = remainingHp(G, defender);
    // A guaranteed KO always wins out over any other candidate move this turn.
    if (defenderRemaining > 0 && breakdown.finalDamage >= defenderRemaining) score += 1000;
    if (breakdown.weaknessApplied) score += 30;
    return score;
  }

  private scoreEvolve(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const targetId = move.payload?.targetId as string;
    const cardId = move.payload?.cardId as string;
    const target = findPokemon(player, targetId);
    const isActiveTarget = player.active?.id === targetId;
    let score = isActiveTarget ? 100 : 75;
    const evolvedCard = player.hand.find(c => c.id === cardId);
    if (evolvedCard && target) {
      const unlocksAttack = (evolvedCard.cardData.attacks || []).some(a => canPayEnergyCost(target.attachedEnergy, a.cost));
      if (unlocksAttack) score += 20;
    }
    return score;
  }

  private scoreAttachEnergy(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const targetId = move.payload?.targetId as string;
    const cardId = move.payload?.cardId as string;
    const target = findPokemon(player, targetId);
    if (!target) return 45;
    const isActive = player.active?.id === targetId;
    let score = isActive ? 55 : 45;
    const attacks = target.cardData.attacks || [];
    if (attacks.length === 0) return score;
    const energyCard = player.hand.find(c => c.id === cardId);
    const energyType = energyCard?.cardData.types?.[0] ?? 'Colorless';
    const hypotheticalEnergy = [...target.attachedEnergy, { type: energyType }];
    const unlocksAttack = attacks.some(a => !canPayEnergyCost(target.attachedEnergy, a.cost) && canPayEnergyCost(hypotheticalEnergy, a.cost));
    if (unlocksAttack) score += 40;
    else if (attacks.every(a => canPayEnergyCost(target.attachedEnergy, a.cost))) score -= 25;
    return score;
  }

  /** Draw/search effects (Supporters, deck-search abilities like a repeatable "trade" ability)
   * consume the player's own deck to gain card advantage — real value early, but worthless-to-
   * actively-harmful once the deck is thin, since drawing/searching it down further is exactly
   * what causes a self-inflicted "deck empty at draw" loss. Confirmed via BattleLab testing:
   * without this, HeuristicAI would repeatedly favor draw/search moves turn after turn (each one
   * scoring higher than attacking) and deck itself out in games it was otherwise winning. */
  private deckDepletionKeywordBonus(player: PtcgPlayerState): number {
    const deckLeft = player.deck.length;
    if (deckLeft < 8) return -20;
    if (deckLeft < 20) return 0;
    return 20;
  }

  private scorePlayTrainer(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const cardId = move.payload?.cardId as string;
    const card = player.hand.find(c => c.id === cardId);
    if (!card) return 50;
    const subtypes = card.cardData.subtypes || [];
    // Supporters are once-per-turn (scarcer, usually the highest-impact effect a hand offers);
    // Tools/Items are unrestricted; Stadiums affect the whole board but are often more situational.
    let score = subtypes.includes('Supporter') ? 60 : subtypes.includes('Stadium') ? 45 : 50;
    const text = (card.cardData.rules || []).join(' ');
    if (/抽\S*張|搜尋|從牌庫/.test(text)) score += this.deckDepletionKeywordBonus(player);
    return score;
  }

  private scoreUseAbility(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const cardId = move.payload?.cardId as string;
    const target = findPokemon(player, cardId);
    const text = target?.cardData.abilities?.[0]?.text ?? '';
    // Self-bounce abilities (e.g. 瞬間移動者: shuffle self + attached cards back into the deck)
    // auto-promote a benched Pokémon to replace themselves — but with an EMPTY bench there's
    // nothing to promote, so using it removes the player's last Pokémon from play and is an
    // immediate loss ("opponent has no Pokémon"). Confirmed via BattleLab testing: with no
    // safeguard, HeuristicAI would pick this move (nothing else scored higher in a stalled-out
    // matchup) and instantly forfeit an otherwise-normal game.
    const isSelfBounce = /放回自己的牌庫|放回手牌/.test(text);
    if (isSelfBounce && player.bench.every(c => c === null)) return -1000;
    let score = 40;
    if (/恢復|傷害|能量/.test(text)) score += 20;
    if (/抽\S*張|搜尋/.test(text)) score += this.deckDepletionKeywordBonus(player);
    return score;
  }

  /** Once the deck is critically low, passing must be able to outscore a merely-generic trainer
   * play (base ~45-60 with no keyword bonus) — otherwise the AI keeps burning hand cards on
   * marginal/no-op plays it can't actually evaluate the effect of, purely because "play a card"
   * always beats a flat score of 1, and decks itself out. Confirmed via BattleLab testing: this
   * was the dominant cause of HeuristicAI losing otherwise-fine games via "deck empty at draw". */
  private scoreEndTurn(G: PtcgGameState, playerIndex: 0 | 1): number {
    const deckLeft = G.players[playerIndex].deck.length;
    if (deckLeft < 8) return 65;
    if (deckLeft < 16) return 25;
    return 1;
  }

  private scorePlayPokemon(G: PtcgGameState, playerIndex: 0 | 1): number {
    const benchCount = G.players[playerIndex].bench.filter(Boolean).length;
    return Math.max(10, 45 - 8 * benchCount);
  }

  /** Highest damage `attacker` can currently deal to `defender` among attacks it can actually
   * pay for right now with its own attached energy (0 if none are payable). */
  private bestPayableDamage(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard): number {
    let best = 0;
    for (const atk of attacker.cardData.attacks || []) {
      if (!canPayEnergyCost(attacker.attachedEnergy, atk.cost)) continue;
      const breakdown = calculateDamageBreakdown(G, attackerIdx, attacker, atk, defender);
      if (breakdown.finalDamage > best) best = breakdown.finalDamage;
    }
    return best;
  }

  private scoreRetreat(G: PtcgGameState, playerIndex: 0 | 1): number {
    const player = G.players[playerIndex];
    const opponent = G.players[(1 - playerIndex) as 0 | 1];
    const active = player.active;
    if (!active) return -10;
    const opponentActive = opponent.active;
    const benchMons = player.bench.filter((c): c is GameCard => c !== null);

    if (opponentActive) {
      const activeRemaining = remainingHp(G, active);
      const incomingBest = this.bestPayableDamage(G, (1 - playerIndex) as 0 | 1, opponentActive, active);
      if (activeRemaining > 0 && incomingBest >= activeRemaining) {
        // Lethal danger — swap out if a healthier replacement exists, otherwise nothing helps.
        if (benchMons.length === 0) return -10;
        const bestBench = benchMons.reduce((best, c) => (remainingHp(G, c) > remainingHp(G, best) ? c : best));
        return remainingHp(G, bestBench) > remainingHp(G, active) ? 200 : -5;
      }

      // Not in danger — still worth proactively swapping in a benched Pokémon that can
      // clearly hit harder right now, as long as the current Active can't already win the
      // exchange outright (in which case attacking beats retreating).
      const opponentRemaining = remainingHp(G, opponentActive);
      const myBest = this.bestPayableDamage(G, playerIndex, active, opponentActive);
      if (myBest < opponentRemaining) {
        let bestUpgrade = 0;
        for (const c of benchMons) {
          const candidateBest = this.bestPayableDamage(G, playerIndex, c, opponentActive);
          if (candidateBest > bestUpgrade) bestUpgrade = candidateBest;
        }
        if (bestUpgrade >= myBest + 30) return 60;
      }
    }
    return -10;
  }

  /** Ultra-Ball-style discard/search steps, retreat/KO bench-promotion, bench-distribution
   * damage picks, etc. all resolve through here — approximated, not a per-effect evaluator
   * (see plan doc's explicit scope note). */
  private scoreResolveChoice(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const choice = G.pendingChoice;
    const selection = (move.payload?.selection as string[] | undefined) ?? [];
    if (!choice) return 10;
    const player = G.players[playerIndex];

    // Board-target choices (bench promotion, damage distribution, etc.) — prefer the
    // healthiest/most-invested Pokémon among the candidates actually offered.
    if (choice.choiceType === 'select_pokemon' || choice.choiceType === 'select_bench_pokemon') {
      if (selection.length === 0) return 5;
      let total = 0;
      for (const id of selection) {
        const target = findPokemon(player, id) ?? findPokemon(G.players[(1 - playerIndex) as 0 | 1], id);
        if (!target) continue;
        total += (remainingHp(G, target) / Math.max(1, effectiveMaxHp(G, target))) * 50 + target.attachedEnergy.length * 10;
      }
      return 10 + total;
    }

    // Hand-card / deck-search-style choices: cheap keyword heuristic. A prompt mentioning
    // "丟棄" is a cost being paid (prefer discarding LOW-value cards); anything else is a
    // reward pick (prefer HIGH-value cards).
    const isDiscardCost = /丟棄|discard/i.test(choice.prompt);
    const labelFor = (id: string): string => {
      if (choice.choiceType === 'select_hand_cards') return player.hand.find(c => c.id === id)?.cardData.name ?? '';
      return choice.options?.find(o => o.id === id)?.label ?? '';
    };
    const isValuableLabel = (label: string) => /基礎|Basic|能量|Energy/.test(label);
    let score = 10 + selection.length;
    for (const id of selection) {
      const valuable = isValuableLabel(labelFor(id));
      score += (isDiscardCost ? !valuable : valuable) ? 15 : -5;
    }
    return score;
  }
}
