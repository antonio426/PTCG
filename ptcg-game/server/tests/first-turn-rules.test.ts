import { describe, it, expect } from 'vitest';
import { canAttack, canEvolve, getLegalMoves, FIRST_TURN_SUPPORTER_EXCEPTIONS } from '../src/game/validation';
import {
  BASIC_MON, STAGE1_MON, SUPPORTER, EXEMPT_SUPPORTER, BASIC_ENERGY,
  makeGameCard, makePlayer, makeState,
} from './fixtures';

/** An Active with enough energy to pay for its 1-Colorless attack. */
function armedActive(owner: 0 | 1 = 0) {
  return makeGameCard(BASIC_MON, owner, {
    attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
  });
}

function stateOnTurn(turn: number) {
  const active = armedActive(0);
  const evolution = makeGameCard(STAGE1_MON, 0);
  const supporter = makeGameCard(SUPPORTER, 0);
  const exempt = makeGameCard(EXEMPT_SUPPORTER, 0);
  const G = makeState({
    turn,
    currentPlayer: 0,
    phase: 'main',
    players: [
      makePlayer({ active, hand: [evolution, supporter, exempt] }),
      makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
    ],
  });
  return { G, active, evolution, supporter, exempt };
}

describe('first turn of the game (G.turn === 1)', () => {
  it('cannot attack', () => {
    expect(canAttack(stateOnTurn(1).G, 0, 0)).toBe(false);
  });

  it('cannot evolve', () => {
    const { G, active, evolution } = stateOnTurn(1);
    expect(canEvolve(G, 0, evolution.id, active.id)).toBe(false);
  });

  it('cannot play an ordinary Supporter', () => {
    const { G, supporter } = stateOnTurn(1);
    const moves = getLegalMoves(G, 0);
    expect(moves.some(m => m.type === 'play_trainer' && m.payload?.cardId === supporter.id)).toBe(false);
  });

  it('CAN play a Supporter printed with an explicit first-turn override', () => {
    const { G, exempt } = stateOnTurn(1);
    expect(FIRST_TURN_SUPPORTER_EXCEPTIONS.has(exempt.cardData.name)).toBe(true);
    const moves = getLegalMoves(G, 0);
    expect(moves.some(m => m.type === 'play_trainer' && m.payload?.cardId === exempt.id)).toBe(true);
  });

  it('still draws — the first turn is paid for by the restrictions above, not by skipping the draw', () => {
    // Guards the rule at the validation layer; turn-lifecycle.test.ts guards the three engines
    // that actually perform the draw.
    const { G } = stateOnTurn(1);
    G.phase = 'draw';
    G.players[0].deck = [makeGameCard(BASIC_MON, 0)];
    expect(getLegalMoves(G, 0).some(m => m.type === 'draw_card')).toBe(true);
  });
});

describe('turn 3 (the same player, one full round later)', () => {
  it('can attack, evolve, and play a Supporter', () => {
    const { G, active, evolution, supporter } = stateOnTurn(3);
    expect(canAttack(G, 0, 0)).toBe(true);
    expect(canEvolve(G, 0, evolution.id, active.id)).toBe(true);
    const moves = getLegalMoves(G, 0);
    expect(moves.some(m => m.type === 'play_trainer' && m.payload?.cardId === supporter.id)).toBe(true);
  });

  it('cannot attack without enough energy', () => {
    const { G, active } = stateOnTurn(3);
    active.attachedEnergy = [];
    expect(canAttack(G, 0, 0)).toBe(false);
  });

  it('cannot evolve a Pokémon that was played this turn', () => {
    const { G, active, evolution } = stateOnTurn(3);
    G.players[0].pokemonPlayedThisTurn = [active.id];
    expect(canEvolve(G, 0, evolution.id, active.id)).toBe(false);
  });

  it('only allows one Supporter per turn', () => {
    const { G, supporter } = stateOnTurn(3);
    G.players[0].supporterPlayedThisTurn = true;
    const moves = getLegalMoves(G, 0);
    expect(moves.some(m => m.type === 'play_trainer' && m.payload?.cardId === supporter.id)).toBe(false);
  });
});
