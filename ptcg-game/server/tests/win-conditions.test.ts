import { describe, it, expect } from 'vitest';
import { checkGameOver } from '../src/game/PtcgGame';
import { checkEndCondition } from '../src/ai/battleRunner';
import { checkAndApplyWin } from '../src/routes/humanBattle';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_MON, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The win check is hand-copied into all three engines with three different signatures
 * (boardgame.io's endIf returns the winner, the other two mutate G). Normalize each to "who won,
 * or null" so they can be held to one table of cases — a rule only one copy gets right is the
 * documented failure mode here (see CLAUDE.md, "Two parallel battle engines").
 */
const ENGINES: [string, (G: PtcgGameState) => number | null][] = [
  ['PtcgGame.checkGameOver', G => checkGameOver({ G }) ?? null],
  ['battleRunner.checkEndCondition', G => { checkEndCondition(G); return G.winner; }],
  ['humanBattle.checkAndApplyWin', G => { checkAndApplyWin(G); return G.winner; }],
];

/** Each case builds a FRESH state per engine — two of the three mutate what they're given. */
const CASES: [string, () => PtcgGameState, number | null][] = [
  ['an ordinary mid-game board has no winner', () => makeState(), null],

  ['taking all 6 prizes wins', () => {
    const G = makeState();
    G.players[0].takenPrizes = 6;
    return G;
  }, 0],

  ['5 prizes taken is not yet a win', () => {
    const G = makeState();
    G.players[0].takenPrizes = 5;
    return G;
  }, null],

  ['wiping the opponent off the board wins', () => {
    const G = makeState();
    G.players[1].active = null;
    G.players[1].bench = [null, null, null, null, null];
    return G;
  }, 0],

  ['an empty Active with a Pokémon still benched is not a win', () => {
    const G = makeState();
    G.players[1].active = null;
    G.players[1].bench = [makeGameCard(BASIC_MON, 1), null, null, null, null];
    return G;
  }, null],

  ['drawing from an empty deck loses', () => {
    const G = makeState({ phase: 'draw', currentPlayer: 0 });
    G.players[0].deck = [];
    return G;
  }, 1],

  ['an empty deck outside the draw phase is not yet a loss', () => {
    const G = makeState({ phase: 'main', currentPlayer: 0 });
    G.players[0].deck = [];
    return G;
  }, null],

  ['an already-decided winner (e.g. forfeit) is honored', () => {
    const G = makeState();
    G.winner = 1;
    G.winReason = 'forfeit';
    return G;
  }, 1],

  // Regression: setup() deliberately leaves an interactive seat's Active null until they pick it.
  // Two of the three copies evaluated "opponent has no pokemon" anyway and ended the match before
  // the first move, handing the win to the other seat.
  ['a seat that has not chosen its Active yet during choose_first has not lost', () => {
    const G = makeState({ phase: 'choose_first' });
    G.players[0].active = null;
    G.players[0].bench = [null, null, null, null, null];
    return G;
  }, null],

  ['a seat that has not chosen its Active yet during choose_active has not lost', () => {
    const G = makeState({ phase: 'choose_active' });
    G.players[0].active = null;
    G.players[0].bench = [null, null, null, null, null];
    return G;
  }, null],
];

describe.each(ENGINES)('%s', (_name, check) => {
  it.each(CASES)('%s', (_label, build, expected) => {
    expect(check(build())).toBe(expected);
  });
});

describe('all three engines agree', () => {
  it.each(CASES)('%s', (_label, build) => {
    const verdicts = ENGINES.map(([name, check]) => [name, check(build())] as const);
    const distinct = new Set(verdicts.map(([, v]) => v));
    expect(distinct.size, `engines disagreed: ${JSON.stringify(verdicts)}`).toBe(1);
  });
});
