import { Attack, Card, GameCard, LegalAction } from '@ptcg/shared';
import type { PtcgGameState, PtcgPlayerState } from '../game/GameState';
import { canPayEnergyCost, usableAttacks, effectiveRetreatCost } from '../game/validation';
import { calculateDamageBreakdown, effectiveMaxHp, prizesForKo } from '../game/damage';
import { buildAttackBoard } from '../game/attackResolution';
import { resolveGenericAttackEffect, GenericAttackOutcome } from '../game/effects/genericAttacks';
import { getBonusPrizesForAttackKo } from '../game/effects/passiveAbilities';
import type { IAIPlayer } from './aiPlayer';

// Moves within this many points of the top score are treated as equally good and tie-broken
// randomly — keeps the AI from being a fully deterministic, memorizable opponent.
const TIE_EPSILON = 5;

// A move worth taking only if there is literally nothing else. Must sit MORE than TIE_EPSILON
// below end_turn, or the random tie-break turns "this does nothing" into a coin flip against
// passing — which is exactly what a flaky spec caught it doing.
const POINTLESS = -20;

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
  /** Max across branches — a KO that only the lucky branch reaches is worth a nudge, not the bank. */
  best: number;
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
  cache?: Map<string, AttackEvaluation>,
): AttackEvaluation {
  // decide() evaluates the same attacks repeatedly (retreat scoring, switch-in ranking, the
  // attack moves themselves) against a state that is frozen for the duration of the call — the
  // caller hands in a per-decide cache so a soak's thousands of decides stay cheap.
  const key = cache && `${attacker.id}|${attack.name}|${defender.id}|${defender.damage}`;
  if (cache && key) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  const result = evaluateAttackUncached(G, attackerIdx, attacker, defender, attack);
  if (cache && key) cache.set(key, result);
  return result;
}

function evaluateAttackUncached(
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
    return { expected: b.finalDamage, guaranteed: b.finalDamage, best: b.finalDamage, weaknessApplied: b.weaknessApplied, outcomes: [] };
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
    best: Math.max(...damages),
    weaknessApplied,
    outcomes: runs,
  };
}

/** Best attack `mon` can pay for right now against `defender` — expected damage, via the full
 * evaluator, over the same index-stable `usableAttacks` list the engine executes from. */
export function bestPayableAttack(
  G: PtcgGameState, ownerIdx: 0 | 1, mon: GameCard, defender: GameCard,
  cache?: Map<string, AttackEvaluation>,
): { attack: Attack; expected: number; guaranteed: number } | null {
  let best: { attack: Attack; expected: number; guaranteed: number } | null = null;
  for (const atk of usableAttacks(G, mon)) {
    if (!canPayAsHolder(G, mon, atk.cost)) continue;
    const ev = evaluateAttack(G, ownerIdx, mon, defender, atk, cache);
    if (!best || ev.expected > best.expected) best = { attack: atk, expected: ev.expected, guaranteed: ev.guaranteed };
  }
  return best;
}

/** The Benched Pokémon most worth promoting against the opponent's current Active: highest
 * payable expected damage, remaining HP as the tie-break. ONE definition, used both to justify a
 * retreat and to answer the bench-promotion choice that follows it — the old scorer used two
 * different notions of "best" for those two halves of the same decision. */
export function bestSwitchIn(
  G: PtcgGameState, idx: 0 | 1, cache?: Map<string, AttackEvaluation>,
): { card: GameCard; expected: number } | null {
  const player = G.players[idx];
  const defender = G.players[(1 - idx) as 0 | 1].active;
  let best: { card: GameCard; expected: number } | null = null;
  for (const c of player.bench) {
    if (!c) continue;
    const expected = defender ? (bestPayableAttack(G, idx, c, defender, cache)?.expected ?? 0) : 0;
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
 * Greedy, 0-ply move scorer — for each legal move, reads the real game state to assign a score,
 * then picks the best (random tie-break among near-equal top scores). Deliberately NOT a
 * game-tree search: no state cloning or simulation, just the engine's own evaluators
 * (evaluateAttack, canPayAsHolder) asked what-if questions.
 *
 * The scores live in NON-OVERLAPPING BANDS, because the one structural fact about a turn is that
 * ATTACKING ENDS IT (moves.ts finishAttack). The old scorer ranked attacks purely by damage, so
 * any hit above ~120 outbid evolving, attaching and every Trainer — the AI attacked first and
 * threw away its whole setup phase, every turn. Now:
 *
 *   WIN_NOW (10000)   the KO that takes the last prize / the last Pokémon — nothing outranks it
 *   SETUP (700-950)   everything that develops the board and does NOT end the turn
 *   ATTACK (100-600)  KOs above non-KOs, prizes weighted in
 *   FLOOR (~5)        end_turn, harmless unknowns
 *   HARMFUL (<0)      self-mill when the deck is thin, discarding own fossils, suicide
 *
 * Setup moves deplete on their own (one energy attach a turn, one Supporter, a bench cap), so the
 * greedy loop naturally converges to "set up, then attack" — a KO deliberately does NOT jump the
 * queue, because it is still there after the setup band empties. The one exception is the
 * game-winning KO.
 */
export class HeuristicAI implements IAIPlayer {
  name = 'HeuristicAI';

  /** Frozen-state memo for evaluateAttack, cleared per decide() — see evaluateAttack. */
  private cache = new Map<string, AttackEvaluation>();

  async decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]) {
    this.cache.clear();
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
      case 'draw_card': return 500;   // the only non-forfeit move in the draw phase anyway
      case 'end_turn': return 5;
      case 'resolve_choice': return this.scoreResolveChoice(G, playerIndex, move);
      case 'discard_fossil': return this.scoreDiscardFossil(G, playerIndex, move);
      case 'use_stadium_action': return this.scoreStadiumAction(G, playerIndex, move);
      case 'choose_active': return this.scoreChooseActive(G, playerIndex, move);
      // Harmless unknowns sit BELOW end_turn — the old default of 10 sat above it, which is how
      // the AI came to discard its own fossils and mill itself on stadium actions for no reason.
      default: return POINTLESS;
    }
  }

  /** Draw/search moves spend the player's own deck; once it is thin that is how the AI decks
   * itself out of games it was winning. Below 8 cards they drop under end_turn outright. */
  private deckDepletionAdjust(player: PtcgPlayerState, base: number): number {
    if (player.deck.length < 8) return -50;
    if (player.deck.length < 16) return base - 60;
    return base;
  }

  private scoreAttack(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const opponent = G.players[(1 - playerIndex) as 0 | 1];
    const attacker = player.active;
    const defender = opponent.active;
    if (!attacker || !defender) return 0;
    const attackIndex = move.payload?.attackIndex as number;
    // The same index-stable list the engine generates, validates and executes this index against —
    // reading cardData.attacks here made every 潛入記憶-borrowed attack score 0.
    const attack = usableAttacks(G, attacker)[attackIndex];
    if (!attack) return 0;
    const ev = evaluateAttack(G, playerIndex, attacker, defender, attack, this.cache);
    const defenderRemaining = remainingHp(G, defender);

    if (defenderRemaining > 0 && ev.guaranteed >= defenderRemaining) {
      // How many prizes this KO is actually worth — an ex is 2, a 超級…ex is 3, plus any standing
      // bonus, never more than are left to take.
      const prizes = Math.min(
        prizesForKo(defender) + getBonusPrizesForAttackKo(G, playerIndex, attacker, defender) + player.bonusPrizeNextKo,
        player.prizes.length,
      );
      const wipesBoard = !opponent.bench.some(c => c !== null);
      if (player.takenPrizes + prizes >= 6 || wipesBoard) return 10000;   // WIN_NOW
      return 450 + 40 * prizes;
    }

    let score = 100 + Math.min(150, ev.expected / 2);
    if (ev.weaknessApplied) score += 10;
    // A KO only the lucky coin branch reaches is a nudge, not a promise.
    if (defenderRemaining > 0 && ev.best >= defenderRemaining) score += 30;
    score += this.attackSideEffects(G, playerIndex, attacker, ev);
    return score;
  }

  /** Bonuses/penalties for what the attack DOES besides damage, read off the resolved outcomes.
   * Capped small: they order attacks within the band, they must not outbid raw damage 2:1. */
  private attackSideEffects(G: PtcgGameState, playerIndex: 0 | 1, attacker: GameCard, ev: AttackEvaluation): number {
    let bonus = 0;
    let penalty = 0;
    for (const o of ev.outcomes) {
      let b = 0;
      for (const st of o.statusToInflict ?? []) b += (st === 'Paralyzed' || st === 'Asleep') ? 12 : 8;
      b += (o.discardOpponentEnergyCount ?? 0) * 6;
      b += ((o.benchSplashDamage ?? 0) + (o.opponentAllBenchSplashDamage ?? 0)) / 10;
      b += (o.healSelfAmount ?? 0) / 10;
      if (o.healSelfByDamageDealt) b += ev.expected / 10;
      bonus = Math.max(bonus, b);

      let pen = 0;
      if (o.selfDamage) {
        pen += o.selfDamage / 10;
        if (o.selfDamage >= remainingHp(G, attacker)) pen += 300;   // do not KO yourself
      }
      if (o.discardAllSelfEnergy) pen += 15;
      penalty = Math.max(penalty, pen);
    }
    return Math.min(40, bonus) - penalty;
  }

  private scoreEvolve(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const targetId = move.payload?.targetId as string;
    const cardId = move.payload?.cardId as string;
    const target = findPokemon(player, targetId);
    let score = player.active?.id === targetId ? 850 : 830;
    const evolvedCard = player.hand.find(c => c.id === cardId);
    if (evolvedCard && target) {
      const unlocks = (evolvedCard.cardData.attacks || []).some(a =>
        canPayEnergyCost(target.attachedEnergy, a.cost, 0, target, G));
      if (unlocks) score += 20;
    }
    return score;
  }

  private scoreAttachEnergy(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const targetId = move.payload?.targetId as string;
    const cardId = move.payload?.cardId as string;
    const target = findPokemon(player, targetId);
    if (!target) return 760;
    const isActive = player.active?.id === targetId;
    const attacks = usableAttacks(G, target);
    if (attacks.length === 0) return isActive ? 780 : 760;
    const energyCard = player.hand.find(c => c.id === cardId);
    // The hypothetical carries the real cardData so Special Energy resolves into its printed
    // units — the engine's asAttachedEnergy will do exactly this on the real attach.
    const hypothetical = [
      ...target.attachedEnergy,
      { type: energyCard?.cardData.types?.[0] ?? 'Colorless', cardData: energyCard?.cardData },
    ];
    const unlocks = attacks.some(a =>
      !canPayEnergyCost(target.attachedEnergy, a.cost, 0, target, G)
      && canPayEnergyCost(hypothetical, a.cost, 0, target, G));
    if (unlocks) return isActive ? 860 : 820;
    if (attacks.every(a => canPayEnergyCost(target.attachedEnergy, a.cost, 0, target, G))) return 730;
    return isActive ? 780 : 760;
  }

  private scorePlayTrainer(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const card = player.hand.find(c => c.id === (move.payload?.cardId as string));
    if (!card) return 770;
    const subtypes = card.cardData.subtypes || [];
    const score = subtypes.includes('Supporter') ? 790 : subtypes.includes('Stadium') ? 740 : 770;
    const text = (card.cardData.rules || []).join(' ');
    // Same trap as the swap abilities: 寶可夢交替 (「將自己的戰鬥寶可夢與備戰寶可夢互換」) scored a
    // flat 770, so the AI spent the card to switch and THEN retreated in the same turn, the two
    // undoing each other. A switch is only worth a card when it is an upgrade.
    if (/將自己的戰鬥寶可夢與備戰寶可夢互換/.test(text) && !this.switchIsAnUpgrade(G, playerIndex)) return POINTLESS;
    // 從自己的牌庫, not 從牌庫: the printed phrasing is 「從自己的牌庫選擇…」, and the shorter form
    // also matched opponent-deck mill cards, which must NOT be penalized for our thin deck.
    if (/抽\S*張|從自己的牌庫/.test(text)) return this.deckDepletionAdjust(player, score);
    return score;
  }

  private scoreUseAbility(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const cardId = move.payload?.cardId as string;
    // From-hand abilities (FROM_HAND_ABILITY_NAMES) name a card in HAND, not in play — the old
    // lookup missed those entirely, so their text (and the self-bounce guard) never applied.
    const holder = findPokemon(player, cardId) ?? player.hand.find(c => c.id === cardId) ?? null;
    const text = holder?.cardData.abilities?.[0]?.text ?? '';
    // Self-bounce with an empty bench removes the player's last Pokémon from play — instant loss.
    if (/放回自己的牌庫|放回手牌/.test(text) && player.bench.every(c => c === null)
      && player.active?.id === cardId) return -1000;
    // An ability that swaps the Active (支配鎖鏈 「與戰鬥寶可夢互換」) is not free when the Active
    // is already the best attacker we have — and every ability scoring a flat 750 meant the AI
    // used it anyway, every turn, undoing the retreat it had just paid for and never attacking.
    // Watched as a multi-turn retreat/swap loop in a real game.
    if (/與戰鬥寶可夢互換|換上場/.test(text) && !this.switchIsAnUpgrade(G, playerIndex)) return POINTLESS;
    let score = 750;
    if (/恢復|傷害|能量/.test(text)) score += 30;
    if (/抽\S*張|從自己的牌庫/.test(text)) return this.deckDepletionAdjust(player, score);
    return score;
  }

  /** Would putting our best Benched Pokémon in the Active spot actually improve things?
   *
   * Shared by every effect that swaps our own Active — the Trainers and the abilities alike —
   * because "replace the Active" is worth exactly nothing when the Active is already the best
   * attacker we have, and both were scoring a flat several-hundred and being taken every turn. */
  private switchIsAnUpgrade(G: PtcgGameState, playerIndex: 0 | 1): boolean {
    const player = G.players[playerIndex];
    const defender = G.players[(1 - playerIndex) as 0 | 1].active;
    const active = player.active;
    if (!defender || !active) return true;   // nothing to compare against: leave the card alone
    const mine = bestPayableAttack(G, playerIndex, active, defender, this.cache)?.expected ?? 0;
    const sw = bestSwitchIn(G, playerIndex, this.cache)?.expected ?? 0;
    return sw > mine;
  }

  private scorePlayPokemon(G: PtcgGameState, playerIndex: 0 | 1): number {
    const benchCount = G.players[playerIndex].bench.filter(Boolean).length;
    // An empty bench is one KO away from losing the game — filling it is board-wipe insurance.
    if (benchCount === 0) return 890;
    return 800 - 15 * benchCount;
  }

  private scoreRetreat(G: PtcgGameState, playerIndex: 0 | 1): number {
    const player = G.players[playerIndex];
    const opponent = G.players[(1 - playerIndex) as 0 | 1];
    const active = player.active;
    const defender = opponent.active;
    if (!active || !defender) return -10;
    const sw = bestSwitchIn(G, playerIndex, this.cache);
    if (!sw) return -10;

    const mine = bestPayableAttack(G, playerIndex, active, defender, this.cache);
    const defenderRemaining = remainingHp(G, defender);
    // Never retreat away a kill we can take right now.
    if (mine && defenderRemaining > 0 && mine.guaranteed >= defenderRemaining) return -10;

    const cost = 25 * effectiveRetreatCost(G, active);
    const incoming = bestPayableAttack(G, (1 - playerIndex) as 0 | 1, defender, active, this.cache);
    if (incoming && incoming.expected >= remainingHp(G, active)) {
      // Lethal danger: swap only for a replacement that actually improves the position — better
      // output, or the same output on a body that survives. "More absolute HP" alone traded a
      // loaded attacker for an empty 60 HP Basic.
      const myOut = mine?.expected ?? 0;
      if (sw.expected > myOut
        || (sw.expected === myOut && remainingHp(G, sw.card) > remainingHp(G, active))) {
        return 950 - cost;
      }
      return -5;
    }
    // Proactive upgrade: a bench attacker that clearly outdamages the current Active.
    if (sw.expected >= (mine?.expected ?? 0) + 30) return 900 - cost;
    return -10;
  }

  /** Voluntarily discarding an own in-play fossil is almost always self-harm — the ONE good case
   * is clearing a do-nothing fossil out of the Active spot for a real attacker. The old flat
   * default of 10 beat end_turn(1), so the AI shed its fossils for fun. */
  private scoreDiscardFossil(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const cardId = move.payload?.cardId as string;
    if (player.active?.id === cardId) {
      const sw = bestSwitchIn(G, playerIndex, this.cache);
      if (sw && sw.expected > 0) return 710;
    }
    return -50;
  }

  private scoreStadiumAction(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const field = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
    switch (move.payload?.effectKey as string) {
      case 'rocket_factory_draw':   // draw 2, no cost
        return this.deckDepletionAdjust(player, 780);
      case 'spike_town_gym_search':
        return this.deckDepletionAdjust(player, 760);
      case 'resident_hall_heal':
        return field.some(c => c.damage > 0) ? 750 : POINTLESS;
      case 'mystery_garden_draw':   // pays 1 energy, draws to the Psychic count
        return field.filter(c => (c.cardData.types || []).includes('Psychic')).length >= 2
          ? this.deckDepletionAdjust(player, 730) : POINTLESS;
      case 'surf_beach_swap': {
        const sw = bestSwitchIn(G, playerIndex, this.cache);
        const defender = G.players[(1 - playerIndex) as 0 | 1].active;
        const mine = player.active && defender
          ? bestPayableAttack(G, playerIndex, player.active, defender, this.cache) : null;
        return sw && sw.expected >= (mine?.expected ?? 0) + 30 ? 720 : POINTLESS;
      }
      // 稜鏡塔 (discard 2 to draw 1) and 夜間學院 (hand card to the top of the deck) are card
      // disadvantage — the old default of 10 made the AI take them every turn, for nothing.
      default: return POINTLESS;
    }
  }

  /** The opening Active pick used to fall to default:10 — a pure coin toss among the hand's
   * Basics. Prefer a body that can fight and doesn't cost the world to retreat off later. */
  private scoreChooseActive(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const player = G.players[playerIndex];
    const card = player.hand.find(c => c.id === (move.payload?.cardId as string));
    if (!card) return 10;
    const hp = parseInt(card.cardData.hp || '0', 10);
    return hp / 10
      + ((card.cardData.attacks?.length ?? 0) > 0 ? 20 : 0)
      - 5 * (card.cardData.retreatCost?.length ?? 0);
  }

  /**
   * Answering a pendingChoice. The old scorer never read `context.kind` — its select_pokemon
   * branch picked the HEALTHIEST candidate even when the question was "which of the opponent's
   * Pokémon takes the damage", which is precisely the worst answer. Now the kind names the
   * question, so the answer can be about the question:
   *
   *   hurting the opponent   → KO if possible, else the weakest / most invested target
   *   picking a promotion    → the same bestSwitchIn that justifies retreats
   *   taking a reward        → the most useful cards (cardValue)
   *   paying a cost          → the least useful cards
   *
   * Choices raised mid-effect by named trainer/ability handlers ('trainer:X' / 'ability:X') have
   * no kind — those fall to the prompt classifier at the bottom, deliberately: hundreds of cards,
   * no per-card table.
   */
  private scoreResolveChoice(G: PtcgGameState, playerIndex: 0 | 1, move: LegalAction): number {
    const choice = G.pendingChoice;
    const selection = (move.payload?.selection as string[] | undefined) ?? [];
    if (!choice) return 10;
    const me = G.players[playerIndex];
    const opp = G.players[(1 - playerIndex) as 0 | 1];
    const ctx = (choice.context ?? {}) as Record<string, unknown>;
    const kind = ctx.kind as string | undefined;

    const findAnywhere = (id: string): GameCard | null =>
      findPokemon(me, id) ?? findPokemon(opp, id)
      ?? me.hand.find(c => c.id === id) ?? opp.hand.find(c => c.id === id)
      ?? me.deck.find(c => c.id === id)
      ?? me.discardPile.find(c => c.id === id) ?? opp.discardPile.find(c => c.id === id) ?? null;

    // ---- Hurting the opponent: KO first, then finish the weakest. -----------------------------
    if (kind === 'damage_targets') {
      const amount = (ctx.amount as number) ?? 0;
      const hits = new Map<string, number>();
      for (const id of selection) hits.set(id, (hits.get(id) ?? 0) + 1);
      let score = 10;
      for (const [id, times] of hits) {
        const target = findPokemon(opp, id);
        if (!target) continue;
        const dealt = amount * times;
        if (dealt >= remainingHp(G, target)) score += 100 * prizesForKo(target) + 20;
        else score += dealt / 10 + Math.max(0, 50 - remainingHp(G, target) / 10);
      }
      return score;
    }
    if (kind === 'ko_target' || kind === 'devolve_targets') {
      let score = 10;
      for (const id of selection) {
        const target = findPokemon(opp, id);
        if (!target) continue;
        score += 100 * prizesForKo(target) + targetValue(G, target) / 10;
      }
      return score;
    }
    if (kind === 'keep_opponent_bench') {
      // The picked Pokémon SURVIVE — keep their worst, so the score is what gets removed.
      let kept = 0;
      for (const id of selection) {
        const target = findPokemon(opp, id);
        if (target) kept += targetValue(G, target);
      }
      return 200 - kept;
    }
    if (kind === 'opponent_energy_discard') {
      const holder = [opp.active, ...opp.bench].find(c => c?.id === (ctx.targetId as string)) ?? opp.active;
      let score = 10 + selection.length * 8;
      for (const id of selection) {
        const e = holder?.attachedEnergy.find(x => x.id === id);
        if (e?.cardData?.subtypes?.includes('Special Energy')) score += 10;   // rip the good ones
      }
      return score;
    }
    if (kind === 'discard_opponent_hand' || kind === 'opponent_hand_to_deck_bottom') {
      // Take their engine: Supporters and Pokémon over Items over Energy.
      let score = 10;
      for (const id of selection) {
        const card = opp.hand.find(c => c.id === id)?.cardData;
        if (!card) continue;
        score += card.subtypes?.includes('Supporter') ? 25 : card.supertype === 'Pokémon' ? 20
          : card.supertype === 'Trainer' ? 12 : 8;
      }
      return score;
    }
    if (kind === 'opponent_discard_attach_spread' && ctx.phase === 'target') {
      // Attaching to THEIR board: dump it on the least valuable body.
      const target = findPokemon(opp, selection[0] ?? '');
      return target ? 60 - targetValue(G, target) / 10 : 5;
    }

    // ---- Copying an attack: evaluate each candidate for real. ---------------------------------
    if (kind === 'copy_revealed_attack' || kind === 'copy_defender_attack') {
      if (selection.length === 0) return 5;   // declining is legal, but usually weak
      const idxPicked = parseInt(selection[0] ?? '', 10);
      const candidates = kind === 'copy_revealed_attack'
        ? (ctx.attacks as Attack[] | undefined) ?? []
        : opp.active?.cardData.attacks ?? [];
      const borrowed = candidates[idxPicked];
      if (!borrowed || !me.active || !opp.active) return 5;
      const ev = evaluateAttack(G, playerIndex, me.active, opp.active, borrowed, this.cache);
      return 20 + ev.expected / 2;
    }

    // ---- Promotions and switches: one definition of "who should come in". ---------------------
    // No choiceType filter here: raiseAttackPick labels EVERYTHING select_from_list, including
    // opponent_switch/self_switch — an earlier guard on the choiceType excluded exactly the two
    // kinds this branch is named after, and they fell through to the generic prompt classifier.
    // Every non-promotion select_from_list choice is already routed by its own kind/step above
    // and below, so the kind/effectKey tests alone are the discriminator.
    // mulligan_bonus_bench is NOT a promotion — its options are hand cards going to a free bench
    // slot for nothing, so the only question is "how many", and the answer is "all of them".
    if (choice.effectKey === 'mulligan_bonus_bench') return 20 + 10 * selection.length;
    // "Which of my Benched Pokémon becomes Active" has one right way to be answered no matter
    // which card asked it. Named ability/trainer handlers raise it with no kind at all (支配鎖鏈:
    // choiceType select_pokemon, empty context), so those fell to the generic card-value
    // classifier and swapped in whatever — watched undoing the AI's own retreat, turn after turn.
    const asksWhoComesIn = /換上場|上場|互換/.test(choice.prompt)
      && selection.length === 1
      && G.players[playerIndex].bench.some(c => c?.id === selection[0]);
    const isPromotion = kind === 'opponent_switch' || kind === 'self_switch'
      || choice.effectKey === 'ko_promotion' || choice.effectKey === 'attack_self_return_promotion'
      || (choice.effectKey === 'retreat' && ctx.step === 'pick_bench')
      || asksWhoComesIn;
    if (isPromotion) {
      const mon = findPokemon(me, selection[0] ?? '');
      if (!mon) return 5;
      const defender = opp.active;
      const output = defender ? (bestPayableAttack(G, playerIndex, mon, defender, this.cache)?.expected ?? 0) : 0;
      return 20 + output / 2 + remainingHp(G, mon) / 50;
    }

    // ---- Paying a cost: give up the least. ----------------------------------------------------
    const energyCostKinds = new Set(['self_energy_discard', 'self_energy_to_deck']);
    if (energyCostKinds.has(kind ?? '')
      || (choice.effectKey === 'retreat' && ctx.step === 'pick_energy')
      || choice.effectKey === 'attack_self_energy_discard') {
      // All options are energy on one of our Pokémon: prefer shedding Basic energy whose type
      // none of the holder's attacks even ask for; hold on to Special Energy.
      const holderId = (ctx.attackerId as string) ?? me.active?.id ?? '';
      const holder = findPokemon(me, holderId) ?? me.active;
      const wantedTypes = new Set((holder ? usableAttacks(G, holder) : []).flatMap(a => a.cost));
      let score = 60;
      for (const id of selection) {
        const e = holder?.attachedEnergy.find(x => x.id === id);
        if (!e) continue;
        if (e.cardData?.subtypes?.includes('Special Energy')) score -= 12;
        else if (wantedTypes.has(e.type as never) || wantedTypes.has('Colorless' as never)) score -= 5;
        else score += 3;   // an off-type energy is exactly the one to pay with
      }
      return score;
    }
    const handCostKinds = new Set(['self_hand_discard', 'hand_to_deck']);
    if (handCostKinds.has(kind ?? '')) {
      let score = 60;
      for (const id of selection) {
        const card = me.hand.find(c => c.id === id)?.cardData;
        if (card) score -= cardValue(G, playerIndex, card) / 2;
      }
      return score;
    }

    // ---- Taking a reward: pick the most useful cards, and more of them. -----------------------
    const rewardKinds = new Set([
      'deck_to_hand', 'deck_to_bench', 'deck_attach', 'deck_attach_spread', 'hand_attach_spread',
      'discard_to_hand', 'discard_to_bench', 'discard_attach', 'attach_from_hand_heal',
      'deck_evolve', 'deck_to_top', 'move_energy',
    ]);
    if (kind && rewardKinds.has(kind)) {
      if (ctx.phase === 'target' || (kind === 'move_energy' && ctx.phase !== 'energy')) {
        // Destination step of a multi-part pick: our most invested body, active first.
        const mon = findPokemon(me, selection[0] ?? '');
        if (!mon) return 5;
        return 20 + targetValue(G, mon) / 10 + (me.active?.id === mon.id ? 10 : 0);
      }
      let score = 20 + selection.length * 5;
      for (const id of selection) {
        const card = findAnywhere(id);
        if (card) score += cardValue(G, playerIndex, card.cardData) / 2;
      }
      return score;
    }

    // ---- mulligan compensation: free cards, unless the deck can't afford them. ----------------
    if (choice.effectKey === 'mulligan_bonus') {
      const n = parseInt(selection[0] ?? '0', 10) || 0;
      // Amplified past the tie band, same reason as the classifier below.
      return me.deck.length < 8 ? 20 - 6 * n : 20 + 6 * n;
    }

    // ---- Everything else (named trainer/ability resume steps). --------------------------------
    // Cost or reward? The prompt's verb alone is not enough, because a prompt routinely describes
    // what happens to the cards NOT selected: 偵查指令 reads 「選1張加手牌，其餘放回牌庫下方」 and
    // the 放回 made the AI minimize — it picked the WORST of the two cards it was being handed.
    // 枇琶 (「查看對手手牌，選最多2張物品卡丟棄」) failed the mirror way and declined entirely.
    //
    // The ZONE the options come from settles it: giving up something already ours (hand, board)
    // is a cost; anything pulled out of a deck, a discard pile, or the opponent's side is a gain,
    // whatever the sentence says about the leftovers.
    const myField = [me.active, ...me.bench].filter((c): c is GameCard => c !== null);
    const isOwnedZone = (id: string) =>
      me.hand.some(c => c.id === id)
      || findPokemon(me, id) !== null
      // Energy already attached to one of ours is just as much "already ours" as a hand card —
      // without this, a named handler's energy-discard prompt reads as a reward and the AI hands
      // over its most valuable Energy.
      || myField.some(c => c.attachedEnergy.some(e => e.id === id));
    const isCost = /丟棄|棄置|放回/.test(choice.prompt)
      && selection.length > 0 && selection.every(isOwnedZone);
    // Full cardValue, not a fraction of it: with TIE_EPSILON at 5, a damped value term put
    // "take the free Pokémon" and "take nothing" 4-5 points apart — inside the random tie band —
    // so the AI declined about half of its deck searches. Watched happening in real games
    // (高級球 and 集客 both answered 「(不選)」 with picks on offer). The gap has to clear the
    // band, and choice scores only ever compete with each other, so scaling up is free.
    let score = 10 + (isCost ? 0 : 3 * selection.length);
    for (const id of selection) {
      const card = findAnywhere(id);
      if (!card) continue;
      const v = cardValue(G, playerIndex, card.cardData);
      score += isCost ? -v : v;
    }
    return score;
  }
}
