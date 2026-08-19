/**
 * Rules that must hold after EVERY move, checked against a live game state.
 *
 * These exist because the audit tooling (`coverage-report.ts`, `attack-clause-audit.ts`,
 * `effect-trigger-audit.ts`) all answer the same question — "does a handler exist for this
 * card?" — and every bug reported from real play so far was of a different kind: a handler that
 * exists but corrupts state, or is offered when it can do nothing. Until now the only thing that
 * caught those was a human playing the game and noticing.
 *
 * Each invariant below is derived from a specific shipped bug, named in its comment. Used by
 * `scripts/playtest-soak.ts` (thousands of turns) and `tests/invariants.test.ts` (a small
 * deterministic slice that runs with `npm test`).
 */
import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { effectiveMaxHp } from './damage';
import { getLegalMoves } from './validation';
import { benchLimit } from './effects/stadiums';

export interface Violation {
  rule: string;
  detail: string;
}

/** Every card instance currently anywhere in play, including nested attachments. */
function allCardInstances(G: PtcgGameState): string[] {
  const ids: string[] = [];
  const visit = (card: GameCard | null | undefined) => {
    if (!card) return;
    ids.push(card.id);
    for (const pre of card.preEvolutions ?? []) visit(pre);
    if (card.attachedTool) visit(card.attachedTool);
    for (const e of card.attachedEnergy) ids.push(e.id);
  };
  for (const p of G.players) {
    for (const zone of [p.deck, p.hand, p.discardPile, p.prizes, p.exileZone]) {
      for (const c of zone) visit(c);
    }
    visit(p.active);
    for (const c of p.bench) visit(c);
  }
  if (G.activeStadium) visit(G.activeStadium);
  // A Tool being attached is spliced out of hand and parked in the pending choice's context
  // until the player picks a target — legitimately in no zone for that moment, so count it here
  // rather than reporting a card as lost on every Tool play. (It also means a pendingChoice that
  // ever got dropped without resolving would take the card with it; getLegalMoves only offers
  // resolve_choice/forfeit while one is standing, so there's no path to that today.)
  const parkedTool = (G.pendingChoice?.context as { toolCard?: GameCard } | undefined)?.toolCard;
  if (parkedTool) visit(parkedTool);
  return ids;
}

/**
 * Total card count across both sides. Cards move between zones constantly and a few effects move
 * them across sides, so this counts the whole board rather than per player — which is enough to
 * catch a card leaving the game entirely.
 *
 * Caught in review: setup() destroying a leftover Basic when the Bench filled, and
 * discardAttachedEnergy silently dropping energy that had no `cardData` behind it (39 attach
 * sites). Both showed up as the total quietly dropping mid-game.
 */
export function checkCardConservation(G: PtcgGameState, expectedTotal: number): Violation[] {
  const ids = allCardInstances(G);
  const violations: Violation[] = [];
  if (ids.length !== expectedTotal) {
    violations.push({ rule: 'card-conservation', detail: `${ids.length} cards in play, expected ${expectedTotal}` });
  }
  // A duplicated id means a card is in two zones at once — the mirror image of losing one, and
  // just as invisible without a check like this.
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) { if (seen.has(id)) dupes.add(id); else seen.add(id); }
  if (dupes.size > 0) {
    violations.push({ rule: 'card-uniqueness', detail: `ids in more than one place: ${[...dupes].slice(0, 5).join(', ')}` });
  }
  return violations;
}

/**
 * A standing `pendingChoice` must always have at least one legal way to resolve it.
 *
 * Caught in review: `combinations(pool, n)` returns [] for n > pool.length, so a fixed-count
 * choice raised against a board that couldn't satisfy it produced zero legal moves while the
 * choice stayed up — the client rendered a modal with nothing to click and the match was over.
 */
export function checkPendingChoiceResolvable(G: PtcgGameState): Violation[] {
  if (!G.pendingChoice || G.winner !== null) return [];
  const moves = getLegalMoves(G, G.pendingChoice.player).filter(m => m.type === 'resolve_choice');
  if (moves.length === 0) {
    return [{
      rule: 'pending-choice-resolvable',
      detail: `"${G.pendingChoice.prompt}" (${G.pendingChoice.effectKey}) has no legal resolution`,
    }];
  }
  return [];
}

/** Damage past a Pokémon's effective max HP means a KO check was missed somewhere. */
export function checkNoOverkillSurvivors(G: PtcgGameState): Violation[] {
  // A multi-step effect mid-resolution is allowed to leave the board transiently inconsistent —
  // real rules apply state-based checks between actions, and moves.ts runs its Knock Out sweep
  // on the move that finally clears the choice.
  if (G.pendingChoice) return [];
  const violations: Violation[] = [];
  for (const [idx, p] of G.players.entries()) {
    for (const card of [p.active, ...p.bench]) {
      if (!card) continue;
      const hp = effectiveMaxHp(G, card);
      if (hp > 0 && card.damage >= hp) {
        violations.push({
          rule: 'no-overkill-survivors',
          detail: `player ${idx}'s ${card.cardData.name} is at ${card.damage}/${hp} and still in play`,
        });
      }
    }
  }
  return violations;
}

/** Prizes taken plus prizes remaining is always 6 — a KO that pays the wrong side shows up here. */
export function checkPrizeAccounting(G: PtcgGameState): Violation[] {
  const violations: Violation[] = [];
  for (const [idx, p] of G.players.entries()) {
    const total = p.prizes.length + p.takenPrizes + p.exileZone.length;
    if (total !== 6) {
      violations.push({
        rule: 'prize-accounting',
        detail: `player ${idx}: ${p.prizes.length} left + ${p.takenPrizes} taken + ${p.exileZone.length} exiled = ${total}, expected 6`,
      });
    }
  }
  return violations;
}

/** The per-turn caps the rules impose, and the Bench size the board currently allows. */
export function checkPerTurnLimits(G: PtcgGameState): Violation[] {
  const violations: Violation[] = [];
  for (const [i, p] of G.players.entries()) {
    const idx = i as 0 | 1;
    if (p.energyAttachedThisTurn > 1) {
      violations.push({ rule: 'energy-per-turn', detail: `player ${idx} attached ${p.energyAttachedThisTurn} energy this turn` });
    }
    const benched = p.bench.filter(c => c !== null).length;
    const limit = benchLimit(G, idx);
    if (benched > limit) {
      violations.push({ rule: 'bench-limit', detail: `player ${idx} has ${benched} benched, limit is ${limit}` });
    }
    if (p.supporterNamesPlayedThisTurn.length > 1) {
      violations.push({ rule: 'supporter-per-turn', detail: `player ${idx} played ${p.supporterNamesPlayedThisTurn.length} Supporters this turn` });
    }
  }
  return violations;
}

/**
 * Things that must be true of the board's SHAPE, independent of any particular card's rules:
 * only Pokémon occupy Pokémon slots, only Energy is attached as energy, damage comes in
 * counters, and Special Conditions live only where the rules put them.
 *
 * These are the checks most likely to catch an effect that moves a card into the wrong place —
 * the kind of bug that produces a board no amount of coverage tooling would flag, because every
 * handler involved "exists".
 */
export function checkBoardShape(G: PtcgGameState): Violation[] {
  const violations: Violation[] = [];
  const isPokemon = (c: GameCard) => c.cardData.supertype === 'Pokémon' || c.cardData.isFossil;

  for (const [i, p] of G.players.entries()) {
    const idx = i as 0 | 1;
    const inPlay: [GameCard | null, string][] = [
      [p.active, 'active'],
      ...p.bench.map((c, n) => [c, `bench[${n}]`] as [GameCard | null, string]),
    ];

    for (const [card, where] of inPlay) {
      if (!card) continue;
      if (!isPokemon(card)) {
        violations.push({ rule: 'non-pokemon-in-play', detail: `player ${idx} ${where}: ${card.cardData.name} is a ${card.cardData.supertype}` });
      }
      if (card.damage < 0 || card.damage % 10 !== 0) {
        violations.push({ rule: 'damage-not-in-counters', detail: `player ${idx} ${where}: ${card.cardData.name} at ${card.damage}` });
      }
      if (card.attachedTool && !card.attachedTool.cardData.subtypes.includes('Pokémon Tool')) {
        violations.push({ rule: 'non-tool-attached', detail: `player ${idx} ${where}: ${card.attachedTool.cardData.name} attached as a Tool` });
      }
      for (const e of card.attachedEnergy) {
        if (e.cardData && e.cardData.supertype !== 'Energy') {
          violations.push({ rule: 'non-energy-attached', detail: `player ${idx} ${where}: ${e.cardData.name} attached as energy` });
        }
      }
      // Asleep / Paralyzed / Confused are mutually exclusive; only Burned and Poisoned stack.
      const exclusive = card.statusConditions.filter(c => ['Asleep', 'Paralyzed', 'Confused'].includes(c));
      if (exclusive.length > 1) {
        violations.push({ rule: 'conflicting-status', detail: `player ${idx} ${where}: ${exclusive.join('+')}` });
      }
      // Stacked lower Stages are inert markers — the top card owns every live attachment.
      for (const pre of card.preEvolutions ?? []) {
        if (pre.attachedEnergy.length > 0 || pre.attachedTool || pre.damage !== 0 || pre.statusConditions.length > 0) {
          violations.push({ rule: 'pre-evolution-not-inert', detail: `player ${idx} ${where}: stacked ${pre.cardData.name} still carries state` });
        }
      }
    }

    // Real rules: Special Conditions only ever apply to the Active Pokémon, and leaving the
    // Active spot clears them (clearStatusConditionsOnLeaveActive).
    for (const [n, card] of p.bench.entries()) {
      if (card && card.statusConditions.length > 0) {
        violations.push({ rule: 'status-on-bench', detail: `player ${idx} bench[${n}]: ${card.cardData.name} has ${card.statusConditions.join('+')}` });
      }
    }

    // Cards waiting in hand or deck are not in play and carry no board state.
    for (const [zone, name] of [[p.hand, 'hand'], [p.deck, 'deck']] as [GameCard[], string][]) {
      for (const card of zone) {
        if (card.damage !== 0 || card.attachedEnergy.length > 0 || card.attachedTool || card.statusConditions.length > 0) {
          violations.push({ rule: 'in-play-state-off-board', detail: `player ${idx} ${name}: ${card.cardData.name} carries damage/attachments` });
        }
      }
    }
  }

  if (G.activeStadium && !G.activeStadium.cardData.subtypes.includes('Stadium')) {
    violations.push({ rule: 'non-stadium-in-field-slot', detail: `${G.activeStadium.cardData.name} occupies the Stadium slot` });
  }
  return violations;
}

/** Every state-level invariant, for a board whose two decks total `expectedTotal` cards. */
export function checkAllInvariants(G: PtcgGameState, expectedTotal: number): Violation[] {
  return [
    ...checkCardConservation(G, expectedTotal),
    ...checkPendingChoiceResolvable(G),
    ...checkNoOverkillSurvivors(G),
    ...checkPrizeAccounting(G),
    ...checkPerTurnLimits(G),
    ...checkBoardShape(G),
  ];
}

/**
 * State minus the parts that legitimately change on every move, for "did this move actually do
 * anything?" comparisons.
 *
 * A legal move that leaves the board untouched is the shape of the whole `canPlay` bug family:
 * 高級球 played with fewer than 2 other cards in hand was discarded for nothing, and 腎上腺腦力
 * without a Darkness Energy attached burned its once-per-turn use doing nothing. Both were
 * offered by `getLegalMoves` and both looked, to the player, like the game ignoring them.
 */
export function boardFingerprint(G: PtcgGameState): string {
  return JSON.stringify({
    turn: G.turn,
    currentPlayer: G.currentPlayer,
    phase: G.phase,
    winner: G.winner,
    pendingChoice: G.pendingChoice ? { key: G.pendingChoice.effectKey, prompt: G.pendingChoice.prompt } : null,
    stadium: G.activeStadium?.id ?? null,
    players: G.players.map(p => ({
      deck: p.deck.map(c => c.id),
      hand: p.hand.map(c => c.id),
      discard: p.discardPile.map(c => c.id),
      prizes: p.prizes.length,
      taken: p.takenPrizes,
      exile: p.exileZone.map(c => c.id),
      active: p.active && { id: p.active.id, dmg: p.active.damage, st: [...p.active.statusConditions].sort(), e: p.active.attachedEnergy.map(e => e.id).sort(), tool: p.active.attachedTool?.id ?? null },
      bench: p.bench.map(c => c && { id: c.id, dmg: c.damage, st: [...c.statusConditions].sort(), e: c.attachedEnergy.map(e => e.id).sort(), tool: c.attachedTool?.id ?? null }),
      counters: [p.energyAttachedThisTurn, p.cardsPlayedThisTurn, p.abilitiesUsedThisTurn.length,
        p.retreatedThisTurn, p.supporterPlayedThisTurn, p.stadiumActionUsedThisTurn,
        p.pokemonPlayedThisTurn.length, p.usedBonusAttackThisTurn],
    })),
  });
}

/** Moves that are allowed to leave the board unchanged, with the reason. */
const NO_OP_ALLOWED = new Set([
  // Passing the turn with nothing else to do is a real choice; the turn counter only advances
  // after the caller reacts to ctx.events.endTurn, so the fingerprint can be identical here.
  'end_turn',
]);

/**
 * `attack` gets its own rule rather than being blanket-exempt: an attack may legitimately change
 * nothing when it misses (Confusion tails is handled before this by self-damage, but a
 * coin-flip attack with 0 heads really can do nothing), yet it must still say so in the log.
 */
export function checkMoveHadEffect(
  moveType: string,
  before: string,
  after: string,
  logGrew: boolean,
): Violation[] {
  if (before !== after) return [];
  if (NO_OP_ALLOWED.has(moveType)) return [];
  if (moveType === 'attack') {
    return logGrew ? [] : [{ rule: 'attack-silent-no-op', detail: 'attack changed nothing and logged nothing' }];
  }
  return [{ rule: 'move-had-no-effect', detail: `${moveType} was offered as legal but changed nothing` }];
}
