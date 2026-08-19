import { describe, it, expect } from 'vitest';
import {
  boardFingerprint, checkAllInvariants, checkCardConservation, checkMoveHadEffect,
  checkNoOverkillSurvivors, checkPendingChoiceResolvable, checkPerTurnLimits, checkPrizeAccounting,
  checkBoardShape,
} from '../src/game/invariants';
import { handleKo, resetCardForReentry, sweepKnockedOut } from '../src/game/damage';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Subtype } from '@ptcg/shared';

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });
const TOOL = makeCard({ name: '氣球', supertype: 'Trainer', subtypes: ['Pokémon Tool'] as Subtype[] });

/** A healthy two-card board: 1 Pokémon each, 6 prizes each — 7 cards per side. */
function healthyBoard() {
  return makeState({
    turn: 3, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({ active: makeGameCard(BASIC_MON, 0), prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)) }),
      makePlayer({ active: makeGameCard(BASIC_MON, 1), prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 1)) }),
    ],
  });
}
const HEALTHY_TOTAL = 14;

/**
 * Every invariant is checked BOTH ways: it must pass on a healthy board and it must fire on a
 * deliberately broken one. A check that can never fail is worse than no check — it reads as
 * coverage while catching nothing.
 */
describe('the invariants are not vacuous', () => {
  it('card conservation passes on a healthy board', () => {
    expect(checkAllInvariants(healthyBoard(), HEALTHY_TOTAL)).toEqual([]);
  });

  it('card conservation fires when a card vanishes', () => {
    const G = healthyBoard();
    G.players[0].prizes.pop();
    expect(checkCardConservation(G, HEALTHY_TOTAL).map(v => v.rule)).toContain('card-conservation');
  });

  it('card uniqueness fires when one card is in two places', () => {
    const G = healthyBoard();
    G.players[0].discardPile.push(G.players[0].active!);
    expect(checkCardConservation(G, HEALTHY_TOTAL + 1).map(v => v.rule)).toContain('card-uniqueness');
  });

  it('pending-choice resolvability passes for a choice the count clamp can answer', () => {
    // count 2 against an empty option list used to produce zero legal resolutions; the clamp in
    // legalMovesForPendingChoice degrades it to a single "(不選)", which always clears.
    const G = healthyBoard();
    G.pendingChoice = { player: 0, effectKey: 'test', prompt: 'x', choiceType: 'select_from_list', count: 2, options: [], context: {} } as any;
    expect(getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice')).toHaveLength(1);
    expect(checkPendingChoiceResolvable(G)).toEqual([]);
  });

  it('pending-choice resolvability fires when the choice belongs to a player who cannot act', () => {
    // getLegalMoves returns nothing for the off-turn seat, so a choice owned by that seat can
    // never be answered by anyone — a standing modal with no path out, which is the shape of
    // soft-lock this rule is here to catch.
    const G = healthyBoard();
    G.currentPlayer = 0;
    G.pendingChoice = { player: 1, effectKey: 'stuck', prompt: 'x', choiceType: 'select_from_list', count: 1, options: [{ id: 'a', label: 'a' }], context: {} } as any;
    expect(checkPendingChoiceResolvable(G).map(v => v.rule)).toContain('pending-choice-resolvable');
  });

  it('overkill survivors fire when damage passes max HP with the Pokémon still in play', () => {
    const G = healthyBoard();
    G.players[0].active!.damage = 999;
    expect(checkNoOverkillSurvivors(G).map(v => v.rule)).toContain('no-overkill-survivors');
  });

  it('prize accounting fires when the totals do not reach 6', () => {
    const G = healthyBoard();
    G.players[1].prizes.pop();
    expect(checkPrizeAccounting(G).map(v => v.rule)).toContain('prize-accounting');
  });

  it('per-turn limits fire on a second energy attachment', () => {
    const G = healthyBoard();
    G.players[0].energyAttachedThisTurn = 2;
    expect(checkPerTurnLimits(G).map(v => v.rule)).toContain('energy-per-turn');
  });

  it('per-turn limits fire on an over-full Bench', () => {
    const G = healthyBoard();
    G.players[0].bench = Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)) as any;
    expect(checkPerTurnLimits(G).map(v => v.rule)).toContain('bench-limit');
  });

  it('the no-op rule fires on a move that changed nothing, and spares end_turn', () => {
    expect(checkMoveHadEffect('play_trainer', 'a', 'a', true).map(v => v.rule)).toContain('move-had-no-effect');
    expect(checkMoveHadEffect('end_turn', 'a', 'a', true)).toEqual([]);
    expect(checkMoveHadEffect('play_trainer', 'a', 'b', true)).toEqual([]);
  });

  it('an attack that changes nothing must at least say so in the log', () => {
    expect(checkMoveHadEffect('attack', 'a', 'a', false).map(v => v.rule)).toContain('attack-silent-no-op');
    expect(checkMoveHadEffect('attack', 'a', 'a', true)).toEqual([]);
  });

  it('the fingerprint ignores the log but notices real board changes', () => {
    const G = healthyBoard();
    const before = boardFingerprint(G);
    G.turnLog.push({ player: 0, turn: 3, action: 'x', details: 'y', timestamp: 1 });
    expect(boardFingerprint(G)).toBe(before);
    G.players[0].active!.damage += 10;
    expect(boardFingerprint(G)).not.toBe(before);
  });
});

/** The three bugs the soak found on its first runs, each pinned individually. */
describe('regressions the playtest soak caught', () => {
  it('a KO puts an attached Tool in the discard pile exactly once', () => {
    const tool = makeGameCard(TOOL, 1);
    const victim = makeGameCard(BASIC_MON, 1, { attachedTool: tool, damage: 100 });
    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: victim, bench: [makeGameCard(BASIC_MON, 1), null, null, null, null], prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    handleKo(G, 1, victim.id);
    const discard = G.players[1].discardPile;
    expect(discard.filter(c => c.id === tool.id)).toHaveLength(1);
    expect(discard.filter(c => c.attachedTool?.id === tool.id)).toHaveLength(0);
  });

  it('retrieving a card from the discard pile leaves its attachments there, not nowhere', () => {
    // A KO'd Pokémon reaches the discard still carrying its energy; clearing the field outright
    // deleted those cards from the game when 夜間擔架 pulled the Pokémon back.
    const discardPile: any[] = [];
    const card = makeGameCard(BASIC_MON, 0, {
      attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
      attachedTool: makeGameCard(TOOL, 0),
      damage: 50,
    });
    resetCardForReentry(card, discardPile);
    expect(card.attachedEnergy).toEqual([]);
    expect(card.attachedTool).toBeNull();
    expect(card.damage).toBe(0);
    expect(discardPile).toHaveLength(2);
    expect(discardPile.map(c => c.cardData.name).sort()).toEqual([BASIC_ENERGY.name, TOOL.name].sort());
  });

  it('a Tool is not offered when every Pokémon already holds one', () => {
    // Offered-but-refunded meant the move changed nothing and could be picked again forever;
    // the soak watched one game spend all 2000 of its moves on 竹蘭的力量負重.
    const tool = makeGameCard(TOOL, 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0, { attachedTool: makeGameCard(TOOL, 0) }),
          hand: [tool],
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && m.payload?.cardId === tool.id)).toBe(false);

    // Same board with a free slot: offered again.
    G.players[0].bench[0] = makeGameCard(BASIC_MON, 0);
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && m.payload?.cardId === tool.id)).toBe(true);
  });

  it('KOs a Pokémon whose max HP drops below the damage already on it', () => {
    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1, { damage: 100 }), bench: [makeGameCard(BASIC_MON, 1), null, null, null, null], prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    // 100 damage on a 60 HP body: only an HP modifier could have kept it alive, and when that
    // modifier goes away nothing re-checks. Confirm the sweep resolves it instead.
    expect(checkNoOverkillSurvivors(G).length).toBeGreaterThan(0);
    sweepKnockedOut(G);
    expect(checkNoOverkillSurvivors(G)).toEqual([]);
    expect(G.players[0].takenPrizes).toBe(1);
  });

  it('every move runs the sweep, so a state-based KO cannot outlive the move that caused it', () => {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), deck: [makeGameCard(BASIC_MON, 0)], prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1, { damage: 999 }), bench: [makeGameCard(BASIC_MON, 1), null, null, null, null], prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    moves.endTurn({ G, ctx: ctxFor(G) } as any);
    expect(checkNoOverkillSurvivors(G)).toEqual([]);
  });
});

describe('board shape rules', () => {
  it('passes on a healthy board', () => {
    expect(checkBoardShape(healthyBoard())).toEqual([]);
  });

  it('fires when a non-Pokémon occupies a Pokémon slot', () => {
    const G = healthyBoard();
    G.players[0].bench[0] = makeGameCard(TOOL, 0);
    expect(checkBoardShape(G).map(v => v.rule)).toContain('non-pokemon-in-play');
  });

  it('fires on damage that is not a whole number of counters', () => {
    const G = healthyBoard();
    G.players[0].active!.damage = 15;
    expect(checkBoardShape(G).map(v => v.rule)).toContain('damage-not-in-counters');
  });

  it('fires when something that is not a Tool is attached as one', () => {
    const G = healthyBoard();
    G.players[0].active!.attachedTool = makeGameCard(BASIC_MON, 0);
    expect(checkBoardShape(G).map(v => v.rule)).toContain('non-tool-attached');
  });

  it('fires on mutually exclusive Special Conditions', () => {
    const G = healthyBoard();
    G.players[0].active!.statusConditions = ['Asleep', 'Confused'] as any;
    expect(checkBoardShape(G).map(v => v.rule)).toContain('conflicting-status');
  });

  it('allows Burned and Poisoned together', () => {
    const G = healthyBoard();
    G.players[0].active!.statusConditions = ['Burned', 'Poisoned'] as any;
    expect(checkBoardShape(G)).toEqual([]);
  });

  it('fires when a stacked pre-evolution still carries state', () => {
    const G = healthyBoard();
    const pre = makeGameCard(BASIC_MON, 0, { damage: 20 });
    G.players[0].active!.preEvolutions = [pre];
    expect(checkBoardShape(G).map(v => v.rule)).toContain('pre-evolution-not-inert');
  });

  it('fires when a card waiting in hand carries board state', () => {
    const G = healthyBoard();
    G.players[0].hand.push(makeGameCard(BASIC_MON, 0, { damage: 30 }));
    expect(checkBoardShape(G).map(v => v.rule)).toContain('in-play-state-off-board');
  });

  /**
   * Special Conditions belong to the Active Pokémon only. 43 sites reassign `.active` and each
   * has to clear them off whatever it displaces; the soak found several that don't, so the rule
   * is now enforced centrally rather than trusted to every call site.
   */
  it('fires when a Benched Pokémon carries a Special Condition', () => {
    const G = healthyBoard();
    G.players[0].bench[0] = makeGameCard(BASIC_MON, 0, { statusConditions: ['Poisoned'] as any });
    expect(checkBoardShape(G).map(v => v.rule)).toContain('status-on-bench');
  });

  it('every move sweeps Conditions off the Bench', () => {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          bench: [makeGameCard(BASIC_MON, 0, { statusConditions: ['Poisoned'] as any }), null, null, null, null],
          deck: [makeGameCard(BASIC_MON, 0)],
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    expect(checkBoardShape(G).map(v => v.rule)).toContain('status-on-bench');
    moves.endTurn({ G, ctx: ctxFor(G) } as any);
    expect(checkBoardShape(G)).toEqual([]);
  });
});
