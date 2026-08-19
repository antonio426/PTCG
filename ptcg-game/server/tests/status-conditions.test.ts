import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  processBetweenTurns, processWakeUpCheck, clearStatusConditionsOnLeaveActive,
} from '../src/game/statusConditions';
import { BASIC_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const TOUGH = makeCard({ name: '耐打鼠', hp: '200', types: ['Colorless'], subtypes: ['Basic'] });

/** `currentPlayer` is the player whose turn is STARTING — the other one just finished. */
function boardWith(status: string[], opts: { currentPlayer?: 0 | 1; damage?: number } = {}) {
  const afflicted = makeGameCard(TOUGH, 0, { statusConditions: status as any, damage: opts.damage ?? 0 });
  const G = makeState({
    currentPlayer: opts.currentPlayer ?? 1,
    players: [
      makePlayer({ active: afflicted, bench: [makeGameCard(BASIC_MON, 0), null, null, null, null] }),
      makePlayer({
        active: makeGameCard(TOUGH, 1),
        // Prizes must actually be present: handleKo increments takenPrizes only when it pops a
        // real prize card, so a board built without them silently records no prize taken.
        prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 1)),
      }),
    ],
  });
  return { G, afflicted };
}

afterEach(() => vi.restoreAllMocks());

describe('processBetweenTurns', () => {
  it('Poisoned deals 10 damage', () => {
    const { G, afflicted } = boardWith(['Poisoned']);
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(10);
  });

  it('Burned deals 20 damage', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // tails — not cured
    const { G, afflicted } = boardWith(['Burned']);
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(20);
    expect(afflicted.statusConditions).toContain('Burned');
  });

  it('Burned is cured on a winning coin flip, after the damage lands', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // heads — cured
    const { G, afflicted } = boardWith(['Burned']);
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(20);
    expect(afflicted.statusConditions).not.toContain('Burned');
  });

  it('Poisoned and Burned stack to 30', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { G, afflicted } = boardWith(['Poisoned', 'Burned']);
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(30);
  });

  it('ticks BOTH players, not just the one whose turn is starting', () => {
    const { G } = boardWith(['Poisoned'], { currentPlayer: 1 });
    G.players[1].active!.statusConditions = ['Poisoned'] as any;
    processBetweenTurns(G);
    expect(G.players[0].active!.damage).toBe(10);
    expect(G.players[1].active!.damage).toBe(10);
  });

  it('does nothing to a Pokémon with no special condition', () => {
    const { G, afflicted } = boardWith([]);
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(0);
  });

  it('KOs a Pokémon whose between-turns damage reaches its HP', () => {
    // 190 damage on a 200 HP body: Poison's 10 is exactly lethal.
    const { G, afflicted } = boardWith(['Poisoned'], { damage: 190 });
    processBetweenTurns(G);
    expect(G.players[0].active?.id).not.toBe(afflicted.id);
    expect(G.players[0].discardPile.map(c => c.id)).toContain(afflicted.id);
    expect(G.players[1].takenPrizes).toBe(1);
    expect(G.players[1].prizes).toHaveLength(5);
  });

  it('awards the prize into the attacker\'s hand', () => {
    const { G } = boardWith(['Poisoned'], { damage: 190 });
    processBetweenTurns(G);
    expect(G.players[1].hand).toHaveLength(1);
  });

  it('does not KO while damage is still below max HP', () => {
    const { G, afflicted } = boardWith(['Poisoned'], { damage: 180 });
    processBetweenTurns(G);
    expect(G.players[0].active?.id).toBe(afflicted.id);
    expect(G.players[1].takenPrizes).toBe(0);
  });
});

describe('Paralyzed', () => {
  it('clears as the turn passes off the paralyzed player, not before', () => {
    // currentPlayer 1 is starting their turn, so player 0 just finished their locked-out turn.
    const { G, afflicted } = boardWith(['Paralyzed'], { currentPlayer: 1 });
    processBetweenTurns(G);
    expect(afflicted.statusConditions).not.toContain('Paralyzed');
  });

  it('survives the transition INTO the paralyzed player\'s locked turn', () => {
    // currentPlayer 0 is starting their own turn — clearing here would undo the lockout.
    const { G, afflicted } = boardWith(['Paralyzed'], { currentPlayer: 0 });
    processBetweenTurns(G);
    expect(afflicted.statusConditions).toContain('Paralyzed');
  });

  it('deals no damage of its own', () => {
    const { G, afflicted } = boardWith(['Paralyzed'], { currentPlayer: 0 });
    processBetweenTurns(G);
    expect(afflicted.damage).toBe(0);
  });
});

describe('processWakeUpCheck', () => {
  it('wakes on a winning coin flip', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { G, afflicted } = boardWith(['Asleep']);
    processWakeUpCheck(G, 0);
    expect(afflicted.statusConditions).not.toContain('Asleep');
  });

  it('stays asleep on a losing flip', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { G, afflicted } = boardWith(['Asleep']);
    processWakeUpCheck(G, 0);
    expect(afflicted.statusConditions).toContain('Asleep');
  });

  it('leaves other conditions alone', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { G, afflicted } = boardWith(['Asleep', 'Poisoned']);
    processWakeUpCheck(G, 0);
    expect(afflicted.statusConditions).toEqual(['Poisoned']);
  });

  it('is a no-op with no Active', () => {
    const G = makeState({ players: [makePlayer(), makePlayer()] });
    expect(() => processWakeUpCheck(G, 0)).not.toThrow();
  });
});

describe('clearStatusConditionsOnLeaveActive', () => {
  it('clears everything when a Pokémon leaves the Active spot', () => {
    const card = makeGameCard(TOUGH, 0, { statusConditions: ['Asleep', 'Poisoned', 'Burned'] as any });
    clearStatusConditionsOnLeaveActive(card);
    expect(card.statusConditions).toEqual([]);
  });

  it('tolerates a null/undefined card', () => {
    expect(() => clearStatusConditionsOnLeaveActive(null)).not.toThrow();
    expect(() => clearStatusConditionsOnLeaveActive(undefined)).not.toThrow();
  });
});
