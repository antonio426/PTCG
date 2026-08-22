import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Move dispatch was the second thing hand-copied into every engine, and it drifted exactly the way
 * the turn-begin block did before `game/turnLifecycle.ts` unified it: `getLegalMoves` produces 15
 * move types, humanBattle dispatched 15, battleRunner 13, and routes/battles.ts — the engine behind
 * BattleLab — only 11. A move it doesn't recognise is a silent no-op: the AI picks it, nothing
 * happens, and the loop keeps going until the 500-move safety cap. Win rates were being measured
 * with two of the game's actions quietly missing.
 *
 * So the rule here is the same one turn-lifecycle.test.ts enforces: ONE implementation, everyone
 * calls it, and it covers every type validation can emit.
 */
const SRC = join(__dirname, '..', 'src');
const DISPATCH = join(SRC, 'game', 'moveDispatch.ts');
const VALIDATION = join(SRC, 'game', 'validation.ts');

const ENGINES = {
  'battleRunner.ts': join(SRC, 'ai', 'battleRunner.ts'),
  'humanBattle.ts': join(SRC, 'routes', 'humanBattle.ts'),
  'battles.ts': join(SRC, 'routes', 'battles.ts'),
};

const stripComments = (src: string) =>
  src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every move type getLegalMoves can hand back, read from the source rather than hardcoded so a
 * newly added one fails here until the shared dispatcher learns it. */
const moveTypes = [...new Set(
  [...readFileSync(VALIDATION, 'utf8').matchAll(/type: '([a-z_]+)'/g)].map(m => m[1]),
)].sort();

describe('move dispatch has exactly one implementation', () => {
  it('reads a plausible set of move types out of validation.ts', () => {
    expect(moveTypes.length).toBeGreaterThan(10);
    expect(moveTypes).toContain('use_stadium_action');
    expect(moveTypes).toContain('discard_fossil');
  });

  it('handles every one of them', () => {
    const dispatch = stripComments(readFileSync(DISPATCH, 'utf8'));
    const missing = moveTypes.filter(t => !dispatch.includes(`case '${t}'`));
    expect(missing).toEqual([]);
  });

  it.each(Object.entries(ENGINES))('%s dispatches through the shared applyMove', (_name, file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    expect(src).toMatch(/applyMove\(/);
    // No engine may keep a switch of its own — that is how battles.ts fell two moves behind.
    const ownCases = moveTypes.filter(t => src.includes(`case '${t}'`));
    expect(ownCases).toEqual([]);
  });
});
