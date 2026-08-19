import { describe, it, expect } from 'vitest';
import {
  canAttachEnergy, canPlayPokemon, canRetreat, canPayEnergyCost, getLegalMoves,
} from '../src/game/validation';
import { BASIC_MON, BASIC_ENERGY, STAGE1_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const energyCard = (owner: 0 | 1 = 0) => makeGameCard(BASIC_ENERGY, owner);
const attached = (type: string, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: `e${type}${i}`, type, cardData: BASIC_ENERGY }));

describe('canPayEnergyCost', () => {
  it('a free attack is always payable', () => {
    expect(canPayEnergyCost([], [])).toBe(true);
  });

  it('matches specific types exactly', () => {
    expect(canPayEnergyCost(attached('Fire', 1), ['Fire'])).toBe(true);
    expect(canPayEnergyCost(attached('Water', 1), ['Fire'])).toBe(false);
  });

  it('lets any energy pay a Colorless cost', () => {
    expect(canPayEnergyCost(attached('Water', 2), ['Colorless', 'Colorless'])).toBe(true);
  });

  it('does not spend the same energy twice', () => {
    // One Fire cannot cover both a Fire and a Colorless requirement.
    expect(canPayEnergyCost(attached('Fire', 1), ['Fire', 'Colorless'])).toBe(false);
    expect(canPayEnergyCost(attached('Fire', 2), ['Fire', 'Colorless'])).toBe(true);
  });

  it('applies a Colorless-cost reduction', () => {
    expect(canPayEnergyCost(attached('Fire', 1), ['Fire', 'Colorless'], 1)).toBe(true);
  });

  it('a reduction never eats into a specific-type requirement', () => {
    expect(canPayEnergyCost([], ['Fire'], 3)).toBe(false);
  });
});

describe('canAttachEnergy', () => {
  function board() {
    const energy = energyCard();
    const active = makeGameCard(BASIC_MON, 0);
    const G = makeState({
      players: [makePlayer({ active, hand: [energy] }), makePlayer({ active: makeGameCard(BASIC_MON, 1) })],
    });
    return { G, energy, active };
  }

  it('allows one attachment per turn', () => {
    const { G, energy, active } = board();
    expect(canAttachEnergy(G, 0, energy.id, active.id)).toBe(true);
  });

  it('refuses a second attachment in the same turn', () => {
    const { G, energy, active } = board();
    G.players[0].energyAttachedThisTurn = 1;
    expect(canAttachEnergy(G, 0, energy.id, active.id)).toBe(false);
  });

  it('refuses a non-Energy card', () => {
    const { G, active } = board();
    const notEnergy = makeGameCard(BASIC_MON, 0);
    G.players[0].hand = [notEnergy];
    expect(canAttachEnergy(G, 0, notEnergy.id, active.id)).toBe(false);
  });

  it('refuses a target that is not in play', () => {
    const { G, energy } = board();
    expect(canAttachEnergy(G, 0, energy.id, 'not-on-the-board')).toBe(false);
  });

  it('refuses outside the main phase', () => {
    const { G, energy, active } = board();
    G.phase = 'draw';
    expect(canAttachEnergy(G, 0, energy.id, active.id)).toBe(false);
  });
});

describe('canRetreat', () => {
  function board(opts: { cost?: number; energy?: number; benched?: boolean } = {}) {
    const mon = makeCard({
      name: '撤退鼠', hp: '100', types: ['Colorless'], subtypes: ['Basic'],
      retreatCost: Array.from({ length: opts.cost ?? 1 }, () => 'Colorless' as any),
      convertedRetreatCost: opts.cost ?? 1,
    });
    const active = makeGameCard(mon, 0, { attachedEnergy: attached('Grass', opts.energy ?? 1) });
    const G = makeState({
      players: [
        makePlayer({ active, bench: [(opts.benched ?? true) ? makeGameCard(BASIC_MON, 0) : null, null, null, null, null] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, active };
  }

  it('allows a retreat when the cost is paid and a Benched Pokémon exists', () => {
    expect(canRetreat(board().G, 0)).toBe(true);
  });

  it('refuses without enough attached energy', () => {
    expect(canRetreat(board({ cost: 2, energy: 1 }).G, 0)).toBe(false);
  });

  it('allows a free retreat with no energy attached', () => {
    expect(canRetreat(board({ cost: 0, energy: 0 }).G, 0)).toBe(true);
  });

  it('refuses with an empty Bench — there is nowhere to retreat to', () => {
    expect(canRetreat(board({ benched: false }).G, 0)).toBe(false);
  });

  it('allows at most one retreat per turn', () => {
    // Without this an AI can ping-pong between Active and Bench until the turn safety cap fires.
    const { G } = board();
    G.players[0].retreatedThisTurn = true;
    expect(canRetreat(G, 0)).toBe(false);
  });

  it.each(['Asleep', 'Paralyzed'])('refuses while %s', condition => {
    const { G, active } = board();
    active.statusConditions = [condition] as any;
    expect(canRetreat(G, 0)).toBe(false);
  });

  it('still allows retreating while Poisoned or Burned', () => {
    const { G, active } = board();
    active.statusConditions = ['Poisoned', 'Burned'] as any;
    expect(canRetreat(G, 0)).toBe(true);
  });

  it('refuses for a Fossil, whose 0 retreat cost would otherwise let it slip through', () => {
    const { G, active } = board({ cost: 0, energy: 0 });
    (active.cardData as any).isFossil = true;
    expect(canRetreat(G, 0)).toBe(false);
  });
});

describe('canPlayPokemon', () => {
  function board(benchCount: number) {
    const basic = makeGameCard(BASIC_MON, 0);
    const bench = Array.from({ length: 5 }, (_, i) => (i < benchCount ? makeGameCard(BASIC_MON, 0) : null));
    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), hand: [basic], bench: bench as any }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, basic };
  }

  it('allows a Basic onto a Bench with room', () => {
    const { G, basic } = board(4);
    expect(canPlayPokemon(G, 0, basic.id)).toBe(true);
  });

  it('refuses once the Bench holds 5', () => {
    const { G, basic } = board(5);
    expect(canPlayPokemon(G, 0, basic.id)).toBe(false);
  });

  it('refuses a Stage 1 — evolutions are never played straight to the Bench', () => {
    const { G } = board(0);
    const stage1 = makeGameCard(STAGE1_MON, 0);
    G.players[0].hand = [stage1];
    expect(canPlayPokemon(G, 0, stage1.id)).toBe(false);
  });
});

describe('getLegalMoves', () => {
  it('offers nothing to the player whose turn it is not', () => {
    const G = makeState({ currentPlayer: 0 });
    expect(getLegalMoves(G, 1)).toEqual([]);
  });

  it('offers only the draw during the draw phase', () => {
    const G = makeState({ phase: 'draw' });
    G.players[0].deck = [makeGameCard(BASIC_MON, 0)];
    // forfeit is deliberately offered in every phase — conceding is always available.
    const types = [...new Set(getLegalMoves(G, 0).map(m => m.type))].filter(t => t !== 'forfeit');
    expect(types).toEqual(['draw_card']);
  });

  it('always offers end_turn in the main phase, so a turn can never deadlock', () => {
    const G = makeState({ phase: 'main' });
    expect(getLegalMoves(G, 0).some(m => m.type === 'end_turn')).toBe(true);
  });

  it.each(['choose_first', 'choose_active', 'draw', 'main'])('offers forfeit during %s', phase => {
    const G = makeState({ phase: phase as any, coinWinner: 0 });
    expect(getLegalMoves(G, 0).some(m => m.type === 'forfeit')).toBe(true);
  });
});
