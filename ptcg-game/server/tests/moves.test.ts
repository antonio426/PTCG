import { describe, it, expect, vi } from 'vitest';
import { moves } from '../src/game/moves';
import { PtcgGameState } from '../src/game/GameState';
import {
  BASIC_MON, STAGE1_MON, BASIC_ENERGY, makeCard, makeGameCard, makePlayer, makeState,
} from './fixtures';

/** The shared moves take boardgame.io's ctx shape; all three engines hand-build an equivalent. */
function ctxFor(G: PtcgGameState, onEndTurn = () => {}) {
  return { currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: onEndTurn } };
}

const call = (fn: any, G: PtcgGameState, ...args: any[]) => fn({ G, ctx: ctxFor(G) }, ...args);

describe('drawCard', () => {
  function board(deckSize: number) {
    const G = makeState({ phase: 'draw' });
    G.players[0].deck = Array.from({ length: deckSize }, () => makeGameCard(BASIC_MON, 0));
    return G;
  }

  it('moves the top card to hand and opens the main phase', () => {
    const G = board(3);
    call(moves.drawCard, G);
    expect(G.players[0].hand).toHaveLength(1);
    expect(G.players[0].deck).toHaveLength(2);
    expect(G.phase).toBe('main');
  });

  it('drawing from an empty deck loses on the spot', () => {
    // Decided here rather than left for the caller: every engine's post-move win check only
    // reads G.winner, and by the time it runs G.phase has already moved on to 'main'.
    const G = board(0);
    call(moves.drawCard, G);
    expect(G.winner).toBe(1);
    expect(G.winReason).toBe('deck empty at draw');
  });

  it('does nothing outside the draw phase', () => {
    const G = board(3);
    G.phase = 'main';
    call(moves.drawCard, G);
    expect(G.players[0].hand).toHaveLength(0);
  });

  it('does nothing when called by the player whose turn it is not', () => {
    const G = board(3);
    moves.drawCard({ G, ctx: { ...ctxFor(G), currentPlayer: '1' } } as any);
    expect(G.players[0].hand).toHaveLength(0);
  });
});

describe('playPokemon', () => {
  function board(benchCount = 0) {
    const basic = makeGameCard(BASIC_MON, 0);
    const G = makeState({
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          hand: [basic],
          bench: Array.from({ length: 5 }, (_, i) => (i < benchCount ? makeGameCard(BASIC_MON, 0) : null)) as any,
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, basic };
  }

  it('puts a Basic on the Bench and records it as played this turn', () => {
    const { G, basic } = board();
    call(moves.playPokemon, G, basic.id);
    expect(G.players[0].bench.filter(Boolean)).toHaveLength(1);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].pokemonPlayedThisTurn).toContain(basic.id);
  });

  it('honors an explicit bench slot', () => {
    const { G, basic } = board();
    call(moves.playPokemon, G, basic.id, 3);
    expect(G.players[0].bench[3]?.id).toBe(basic.id);
  });

  it('falls back to the first free slot when the requested one is taken', () => {
    const { G, basic } = board(1);
    call(moves.playPokemon, G, basic.id, 0);
    expect(G.players[0].bench[1]?.id).toBe(basic.id);
  });

  it('leaves the card in hand when the Bench is full', () => {
    const { G, basic } = board(5);
    call(moves.playPokemon, G, basic.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(basic.id);
  });
});

describe('evolvePokemon', () => {
  function board() {
    const active = makeGameCard(BASIC_MON, 0, {
      damage: 30,
      attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
      statusConditions: ['Asleep', 'Poisoned'] as any,
    });
    const evolution = makeGameCard(STAGE1_MON, 0);
    const G = makeState({
      players: [
        makePlayer({ active, hand: [evolution] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, active, evolution };
  }

  it('replaces the target and stacks the old card underneath', () => {
    const { G, active, evolution } = board();
    call(moves.evolvePokemon, G, evolution.id, active.id);
    expect(G.players[0].active?.id).toBe(evolution.id);
    expect(G.players[0].active?.preEvolutions?.map(c => c.id)).toEqual([active.id]);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('carries damage and attached energy over to the evolution', () => {
    const { G, active, evolution } = board();
    call(moves.evolvePokemon, G, evolution.id, active.id);
    expect(G.players[0].active?.damage).toBe(30);
    expect(G.players[0].active?.attachedEnergy).toHaveLength(1);
  });

  it('cures Special Conditions, per real rules', () => {
    const { G, active, evolution } = board();
    call(moves.evolvePokemon, G, evolution.id, active.id);
    expect(G.players[0].active?.statusConditions).toEqual([]);
  });

  it('records the NEW card as played this turn, blocking a second evolution the same turn', () => {
    // Without this, Basic -> Stage 1 -> Stage 2 in a single turn was possible.
    const { G, active, evolution } = board();
    call(moves.evolvePokemon, G, evolution.id, active.id);
    expect(G.players[0].pokemonPlayedThisTurn).toContain(evolution.id);
  });

  it('evolves a Benched Pokémon in place', () => {
    const { G, evolution } = board();
    const benched = makeGameCard(BASIC_MON, 0);
    G.players[0].bench[2] = benched;
    call(moves.evolvePokemon, G, evolution.id, benched.id);
    expect(G.players[0].bench[2]?.id).toBe(evolution.id);
    expect(G.players[0].bench[2]?.preEvolutions?.map(c => c.id)).toEqual([benched.id]);
  });

  it('does nothing on the first turn of the game', () => {
    const { G, active, evolution } = board();
    G.turn = 1;
    call(moves.evolvePokemon, G, evolution.id, active.id);
    expect(G.players[0].active?.id).toBe(active.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(evolution.id);
  });
});

describe('attachEnergy', () => {
  function board() {
    const energy = makeGameCard(BASIC_ENERGY, 0);
    const active = makeGameCard(BASIC_MON, 0);
    const G = makeState({
      players: [makePlayer({ active, hand: [energy] }), makePlayer({ active: makeGameCard(BASIC_MON, 1) })],
    });
    return { G, energy, active };
  }

  it('attaches with the energy card preserved for later discard effects', () => {
    const { G, energy, active } = board();
    call(moves.attachEnergy, G, energy.id, active.id);
    expect(active.attachedEnergy).toHaveLength(1);
    expect(active.attachedEnergy[0].type).toBe('Grass');
    // Without cardData, an effect that later discards this energy would erase it from the game.
    expect(active.attachedEnergy[0].cardData).toBeDefined();
    expect(G.players[0].hand).toHaveLength(0);
  });

  it('spends the one attachment for the turn', () => {
    const { G, energy, active } = board();
    call(moves.attachEnergy, G, energy.id, active.id);
    expect(G.players[0].energyAttachedThisTurn).toBe(1);
  });

  it('refuses a second attachment in the same turn', () => {
    const { G, energy, active } = board();
    G.players[0].energyAttachedThisTurn = 1;
    call(moves.attachEnergy, G, energy.id, active.id);
    expect(active.attachedEnergy).toHaveLength(0);
    expect(G.players[0].hand).toHaveLength(1);
  });
});

describe('retreat', () => {
  const RETREAT_MON = makeCard({
    name: '撤退鼠', hp: '100', types: ['Colorless'], subtypes: ['Basic'],
    retreatCost: ['Colorless'], convertedRetreatCost: 1,
  });

  function board(benchCount = 1, energyCount = 1) {
    const active = makeGameCard(RETREAT_MON, 0, {
      statusConditions: ['Poisoned'] as any,
      attachedEnergy: Array.from({ length: energyCount }, (_, i) => ({ id: `e${i}`, type: 'Grass', cardData: BASIC_ENERGY })),
    });
    const G = makeState({
      players: [
        makePlayer({
          active,
          bench: Array.from({ length: 5 }, (_, i) => (i < benchCount ? makeGameCard(BASIC_MON, 0) : null)) as any,
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, active };
  }

  it('swaps in the only Benched Pokémon without asking', () => {
    const { G, active } = board(1, 1);
    const benched = G.players[0].bench[0]!;
    call(moves.retreat, G);
    expect(G.players[0].active?.id).toBe(benched.id);
    expect(G.players[0].bench[0]?.id).toBe(active.id);
    expect(G.pendingChoice).toBeNull();
  });

  it('pays the retreat cost by discarding energy', () => {
    const { G } = board(1, 1);
    call(moves.retreat, G);
    expect(G.players[0].discardPile).toHaveLength(1);
  });

  it('clears Special Conditions on leaving the Active spot', () => {
    const { G, active } = board(1, 1);
    call(moves.retreat, G);
    expect(active.statusConditions).toEqual([]);
  });

  it('marks the turn as having retreated, so a second retreat is refused', () => {
    const { G } = board(1, 1);
    call(moves.retreat, G);
    expect(G.players[0].retreatedThisTurn).toBe(true);
  });

  it('asks which Benched Pokémon to bring up when there is a real choice', () => {
    const { G } = board(2, 1);
    call(moves.retreat, G);
    expect(G.pendingChoice?.effectKey).toBe('retreat');
    expect(G.pendingChoice?.options).toHaveLength(2);
  });

  it('asks which energy to discard when more is attached than the cost', () => {
    const { G } = board(1, 3);
    call(moves.retreat, G);
    expect(G.pendingChoice?.effectKey).toBe('retreat');
    expect((G.pendingChoice?.context as any)?.step).toBe('pick_energy');
  });
});

describe('endTurn and forfeit', () => {
  it('endTurn hands control back through ctx.events', () => {
    const G = makeState();
    const spy = vi.fn();
    moves.endTurn({ G, ctx: ctxFor(G, spy) } as any);
    expect(G.phase).toBe('end');
    expect(spy).toHaveBeenCalled();
  });

  it('forfeit hands the win to the opponent', () => {
    const G = makeState({ currentPlayer: 0 });
    call(moves.forfeit, G);
    expect(G.winner).toBe(1);
    expect(G.winReason).toBe('forfeit');
  });
});
