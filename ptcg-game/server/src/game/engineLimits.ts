/**
 * How many moves one game is allowed before an engine gives up on it.
 *
 * Shared because the three loop-driving engines had three different policies in two different
 * units — battleRunner 2000 moves per game, battles.ts 200 turns x 500 moves per turn (~100,000),
 * humanBattle 500 AI moves per request with the counter resetting on every human move, i.e. no
 * per-game bound at all. The same deck pair could therefore hit the cap under one engine and play
 * to a real conclusion under another, which means they were measuring different populations of
 * games. A stalled BattleLab batch could also hold a Koa request open for ten games' worth of
 * HeuristicAI scoring passes.
 *
 * Reaching this is NOT a win for anybody: the game did not resolve, and recording a winner there
 * is what quietly inflated seat A's rate in every measurement.
 */
export const MAX_MOVES_PER_GAME = 2000;

/** Recorded as `G.winReason` when the cap is hit; `G.winner` deliberately stays null. */
export const SAFETY_CAP_REASON = 'safety cap exceeded';
