import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGameOver } from '../src/game/PtcgGame';
import { checkEndCondition } from '../src/ai/battleRunner';
import { checkAndApplyWin } from '../src/routes/humanBattle';
import { evaluateWinner } from '../src/game/winConditions';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_MON, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The win check used to be hand-copied into every engine, and the copies were NOT identical:
 * routes/battles.ts — the engine behind BattleLab — had no G.winner early-out, no setup-phase
 * guard, and never wrote winReason. It was invisible here because this table listed three engines
 * and there were four. Same blind spot turnLifecycle.ts exists to close: a guard that only checks
 * the copies it knows about cannot see the copy it does not.
 *
 * So the rule is now the same one move-dispatch.test.ts enforces: ONE implementation
 * (game/winConditions.ts), every engine calls it, and no engine may spell the conditions itself.
 * The behavioural table below still runs, against every engine's public entry point.
 */
const ENGINES: [string, (G: PtcgGameState) => number | null][] = [
  ['PtcgGame.checkGameOver', G => checkGameOver({ G }) ?? null],
  ['battleRunner.checkEndCondition', G => { checkEndCondition(G); return G.winner; }],
  ['humanBattle.checkAndApplyWin', G => { checkAndApplyWin(G); return G.winner; }],
  // evaluateWinner is the pure one: it reports a NEW outcome, so an already-recorded winner
  // (forfeit) reads off G — that is what applyWinner does for the three mutating engines too.
  ['winConditions.evaluateWinner', G => (G.winner !== null ? G.winner : evaluateWinner(G)?.winner ?? null)],
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

describe('all four engines agree', () => {
  it.each(CASES)('%s', (_label, build) => {
    const verdicts = ENGINES.map(([name, check]) => [name, check(build())] as const);
    const distinct = new Set(verdicts.map(([, v]) => v));
    expect(distinct.size, `engines disagreed: ${JSON.stringify(verdicts)}`).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Source guard: one implementation, four callers                     */
/* ------------------------------------------------------------------ */

const SRC = join(__dirname, '..', 'src');
const DRIVERS = {
  'PtcgGame.ts': join(SRC, 'game', 'PtcgGame.ts'),
  'battleRunner.ts': join(SRC, 'ai', 'battleRunner.ts'),
  'humanBattle.ts': join(SRC, 'routes', 'humanBattle.ts'),
  'battles.ts': join(SRC, 'routes', 'battles.ts'),
};

const stripComments = (src: string) =>
  src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The three conditions that make up the win check. Spelling any of them outside
 * winConditions.ts is how battles.ts came to have a fourth, subtly different copy. */
const CONDITIONS: [string, RegExp][] = [
  ['taking all 6 prizes', /takenPrizes\s*>=\s*6/],
  ['an emptied board', /bench\.every\(/],
  ['drawing from an empty deck', /deck\.length\s*===\s*0/],
];

describe('the win check has exactly one implementation', () => {
  it.each(Object.entries(DRIVERS))('%s spells none of the conditions itself', (_name, file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    const owned = CONDITIONS.filter(([, re]) => re.test(src)).map(([label]) => label);
    expect(owned).toEqual([]);
  });

  it.each(Object.entries(DRIVERS))('%s goes through winConditions.ts', (_name, file) => {
    expect(stripComments(readFileSync(file, 'utf8'))).toMatch(/applyWinner\(/);
  });

  it('and that implementation actually contains them', () => {
    const src = stripComments(readFileSync(join(SRC, 'game', 'winConditions.ts'), 'utf8'));
    const missing = CONDITIONS.filter(([, re]) => !re.test(src)).map(([label]) => label);
    expect(missing).toEqual([]);
  });
});
