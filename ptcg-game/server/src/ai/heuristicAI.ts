import { Attack, Card, GameCard, LegalAction } from '@ptcg/shared';
import type { PtcgGameState, PtcgPlayerState } from '../game/GameState';
import { canPayEnergyCost, usableAttacks } from '../game/validation';
import { calculateDamageBreakdown, effectiveMaxHp } from '../game/damage';
import { buildAttackBoard } from '../game/attackResolution';
import { resolveGenericAttackEffect, GenericAttackOutcome } from '../game/effects/genericAttacks';
import type { IAIPlayer } from './aiPlayer';

// Moves within this many points of the top score are treated as equally good and tie-broken
// randomly — keeps the AI from being a fully deterministic, memorizable opponent.
const TIE_EPSILON = 5;

export function remainingHp(G: PtcgGameState, card: GameCard): number {
  return Math.max(0, effectiveMaxHp(G, card) - card.damage);
}

function findPokemon(player: PtcgPlayerState, id: string): GameCard | null {
  if (player.active?.id === id) return player.active;
  return player.bench.find(c => c?.id === id) ?? null;
}

/** The engine's REAL payability question, not the flattened 2-arg one. Passing the holder and `G`
 * is what makes Special Energy resolve into its printed units (火箭隊能量's two, 古舊能量's
 * wildcard) instead of collapsing to one Colorless — see canPayEnergyCost's own comment. The
 * passive Colorless reductions still aren't threaded through (they need the specific attack's
 * name), which under-estimates: the documented safe direction for what-if scoring. */
export function canPayAsHolder(G: PtcgGameState, mon: GameCard, cost: Attack['cost']): boolean {
  return canPayEnergyCost(mon.attachedEnergy, cost, 0, mon, G);
}

export interface AttackEvaluation {
  /** Mean finalDamage across the bounded coin branches — the number a non-KO attack is worth. */
  expected: number;
  /** Min across branches — only this may claim a KO, so a coin-gated kill is never banked on. */
  guaranteed: number;
  /** Whether any branch applied weakness (already inside the damage — informational only). */
  weaknessApplied: boolean;
  /** The resolved outcomes, for reading side-effects (status, bench damage, recoil…). */
  outcomes: GenericAttackOutcome[];
}

/** Mirrors the handful of scaled-damage fields `applyAttackOutcome` computes at apply time from
 * PURE reads of the board (attackResolution.ts's pre-breakdown phase). The destructive/random
 * ones (self-mill counts, reveal-and-discard) are left at the resolver's own baseDamage — a
 * conservative under-estimate, which for scoring is the safe direction. */
export function scaledOutcomeDamage(o: GenericAttackOutcome, player: PtcgPlayerState, attacker: GameCard): number {
  const field = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
  if (o.familyScaledDamage) {
    const { name, amount } = o.familyScaledDamage;
    return field.filter(c => c.cardData.name.includes(name)).length * amount;
  }
  if (o.ownBenchFamilyScaledDamage) {
    const { name, amount } = o.ownBenchFamilyScaledDamage;
    return player.bench.filter(c => c?.cardData.name.includes(name)).length * amount;
  }
  if (o.ownFieldAttackScaledDamage) {
    const { attackName, amount } = o.ownFieldAttackScaledDamage;
    return field.filter(c => c.cardData.attacks?.some(a => a.name === attackName)).length * amount;
  }
  if (o.discardPileAttackScaledDamage) {
    const { attackName, amount } = o.discardPileAttackScaledDamage;
    return player.discardPile.filter(c => c.cardData.attacks?.some(a => a.name === attackName)).length * amount;
  }
  if (o.discardOwnFieldTypedEnergyForDamage) {
    const { type, per } = o.discardOwnFieldTypedEnergyForDamage;
    return field.reduce((n, c) => n + c.attachedEnergy.filter(e => e.type === type).length, 0) * per;
  }
  if (o.selfEnergyDiscardScaledDamage) {
    const { type, max, amount } = o.selfEnergyDiscardScaledDamage;
    const eligible = attacker.attachedEnergy.filter(e => !type || e.type === type).length;
    return Math.min(eligible, max ?? eligible) * amount;
  }
  if (o.handDiscardScaledDamage) {
    const { filter, max, amount } = o.handDiscardScaledDamage;
    const eligible = player.hand.filter(c => {
      if (filter.kind === 'anyEnergy') return c.cardData.supertype === 'Energy';
      if (filter.kind === 'energyType') return c.cardData.supertype === 'Energy' && (c.cardData.types || []).includes(filter.type as never);
      return c.cardData.name.includes(filter.name);
    }).length;
    return Math.min(eligible, max ?? eligible) * amount;
  }
  return o.baseDamage;
}

/**
 * What is this attack actually worth against this defender, effects included?
 *
 * The engine's own text resolver answers that — `resolveGenericAttackEffect` is a pure
 * computation of the outcome, exactly what `applyAttackOutcome` executes — so the scorer calls
 * it rather than re-reading the printed damage field, which is 0 for every 「40×」 multiplier
 * form and every effect-only attack (22.5% of printed attacks; the old scorer let `end_turn`
 * beat all of them).
 *
 * Coin texts call Math.random inline, so the resolver runs under two BOUNDED stubs — a run of
 * one face then the other, never a constant (「擲硬幣直到出現反面為止」 is a
 * `while (Math.random() < 0.5)` loop that never terminates against all-heads; same pattern as
 * attack-clause-audit.ts). The real Math.random is restored in a `finally`: a leak here would
 * silently break every seeded measurement and soak.
 */
export function evaluateAttack(
  G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard, attack: Attack,
): AttackEvaluation {
  const player = G.players[attackerIdx];
  const opponent = G.players[(1 - attackerIdx) as 0 | 1];
  const runs: GenericAttackOutcome[] = [];
  if (attack.text) {
    const board = buildAttackBoard(G, player, opponent, attacker, defender, attack);
    const real = Math.random;
    const seq = (first: number, other: number, n = 8) => {
      let i = 0;
      return () => (i++ < n ? first : other);
    };
    try {
      for (const stub of [seq(0.99, 0), seq(0, 0.99)]) {
        Math.random = stub as typeof Math.random;
        try {
          const o = resolveGenericAttackEffect(attack.text, attack.damage, board);
          if (o) runs.push(o);
        } catch { /* a recognized-but-throwing branch: fall through to the plain breakdown */ }
      }
    } finally {
      Math.random = real;
    }
  }
  if (runs.length === 0) {
    const b = calculateDamageBreakdown(G, attackerIdx, attacker, attack, defender);
    return { expected: b.finalDamage, guaranteed: b.finalDamage, weaknessApplied: b.weaknessApplied, outcomes: [] };
  }
  let weaknessApplied = false;
  const damages = runs.map(o => {
    const base = scaledOutcomeDamage(o, player, attacker);
    const b = calculateDamageBreakdown(
      G, attackerIdx, attacker, { ...attack, damage: String(base) }, defender, o.ignoreResistance, o.ignoreWeakness,
    );
    if (b.weaknessApplied) weaknessApplied = true;
    return b.finalDamage;
  });
  return {
    expected: damages.reduce((a, d) => a + d, 0) / damages.length,
    guaranteed: Math.min(...damages),
    weaknessApplied,
    outcomes: runs,
  };
}

/** Best attack `mon` can pay for right now against `defender` — expected damage, via the full
 * evaluator, over the same index-stable `usableAttacks` list the engine executes from. */
export function bestPayableAttack(
  G: PtcgGameState, ownerIdx: 0 | 1, mon: GameCard, defender: GameCard,
): { attack: Attack; expected: number; guaranteed: number } | null {
  let best: { attack: Attack; expected: number; guaranteed: number } | null = null;
  for (const atk of usableAttacks(G, mon)) {
    if (!canPayAsHolder(G, mon, atk.cost)) continue;
    const ev = evaluateAttack(G, ownerIdx, mon, defender, atk);
    if (!best || ev.expected > best.expected) best = { attack: atk, expected: ev.expected, guaranteed: ev.guaranteed };
  }
  return best;
}

/** The Benched Pokémon most worth promoting against the opponent's current Active: highest
 * payable expected damage, remaining HP as the tie-break. ONE definition, used both to justify a
 * retreat and to answer the bench-promotion choice that follows it — the old scorer used two
 * different notions of "best" for those two halves of the same decision. */
export function bestSwitchIn(G: PtcgGameState, idx: 0 | 1): { card: GameCard; expected: number } | null {
  const player = G.players[idx];
  const defender = G.players[(1 - idx) as 0 | 1].active;
  let best: { card: GameCard; expected: number } | null = null;
  for (const c of player.bench) {
    if (!c) continue;
    const expected = defender ? (bestPayableAttack(G, idx, c, defender)?.expected ?? 0) : 0;
    if (!best || expected > best.expected
      || (expected === best.expected && remainingHp(G, c) > remainingHp(G, best.card))) {
      best = { card: c, expected };
    }
  }
  return best;
}

/** How much board presence a Pokémon represents — used to pick KO/disruption targets on the
 * opponent's side and to protect investments on our own. */
export function targetValue(G: PtcgGameState, mon: GameCard): number {
  const stage = mon.cardData.subtypes.includes('Stage 2') ? 2 : mon.cardData.subtypes.includes('Stage 1') ? 1 : 0;
  return remainingHp(G, mon) + 10 * mon.attachedEnergy.length + 15 * stage;
}

/** Rough worth of a card OUT of play (hand/deck/discard picks): what would taking it do for us? */
export function cardValue(G: PtcgGameState, idx: 0 | 1, card: Card): number {
  const player = G.players[idx];
  const field = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
  if (card.supertype === 'Pokémon') {
    // An evolution of something we already have in play is the best pick there is.
    if (card.evolvesFrom && field.some(c => c.cardData.name === card.evolvesFrom)) return 35;
    if (card.subtypes.includes('Basic') && player.bench.filter(Boolean).length <= 1) return 25;
    return 12;
  }
  if (card.supertype === 'Energy') {
    // Energy an in-play attacker's costs can actually spend beats generic Energy.
    const types = card.types || [];
    const wanted = field.some(c => (c.cardData.attacks || []).some(a =>
      a.cost.some(sym => sym === 'Colorless' || types.includes(sym))));
    return wanted ? 15 : 8;
  }
  if (card.subtypes.includes('Supporter')) return 10;
  return 5;
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
