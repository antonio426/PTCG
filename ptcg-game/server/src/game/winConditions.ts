import { PtcgGameState } from './GameState';
import type { GameCard } from '@ptcg/shared';

/**
 * The one place the game decides that someone has won.
 *
 * This was the third thing hand-copied into every driver, and the copies were NOT identical:
 * `routes/battles.ts` — the engine behind BattleLab — had no `G.winner` early-out (so a forfeit
 * or 「剩1張獎賞卡則獲勝」 result could be overwritten), no setup-phase guard, and never wrote
 * `winReason` at all, which is why every BattleLab game won on prizes reported `winReason: null`.
 * `tests/win-conditions.test.ts` listed only three engines, so that fourth copy was invisible to
 * the guard — the same blind spot `turnLifecycle.ts` was created to close.
 *
 * Split in two because boardgame.io's `endIf` is supposed to be a pure predicate while the other
 * three engines mutate `G`: `evaluateWinner` decides, `applyWinner` records.
 */

/** Reasons are part of the API — the client renders them and BattleLab reports them. */
export type WinReason = 'took all prizes' | 'opponent has no pokemon' | 'deck empty at draw';

export interface WinOutcome {
  winner: 0 | 1;
  reason: WinReason;
}

/**
 * Who has won right now, or null. Pure — never touches `G`.
 *
 * Returns null (not the standing result) when `G.winner` is already set: callers that want the
 * final answer read `G.winner` themselves, and `applyWinner` reports it as "already over".
 */
export function evaluateWinner(G: PtcgGameState): WinOutcome | null {
  if (G.winner !== null) return null;
  // A player legitimately has no Pokémon in play during the setup phases, so the "opponent has no
  // pokemon" condition below is meaningless there — and `setup()` deliberately leaves an
  // interactive seat's Active null for the player to choose. Without this guard, boardgame.io's
  // top-level endIf ended every human match before its first move, and humanBattle handed the AI
  // the win right after the coin-flip move. Direct winners (forfeit) are honored above.
  if (G.phase === 'choose_first' || G.phase === 'choose_active') return null;
  for (let p = 0; p < 2; p++) {
    const player = G.players[p as 0 | 1];
    const opponent = G.players[(1 - p) as 0 | 1];
    if (player.takenPrizes >= 6) return { winner: p as 0 | 1, reason: 'took all prizes' };
    if (!opponent.active && opponent.bench.every((s: GameCard | null) => s === null)) {
      return { winner: p as 0 | 1, reason: 'opponent has no pokemon' };
    }
  }
  const cur = G.players[G.currentPlayer];
  if (cur.deck.length === 0 && G.phase === 'draw') {
    return { winner: (1 - G.currentPlayer) as 0 | 1, reason: 'deck empty at draw' };
  }
  return null;
}

/** Records the outcome on `G`. Returns whether the game is over — including when it already was. */
export function applyWinner(G: PtcgGameState): boolean {
  if (G.winner !== null) return true;
  const outcome = evaluateWinner(G);
  if (!outcome) return false;
  G.winner = outcome.winner;
  G.winReason = outcome.reason;
  return true;
}

/**
 * The seat that cannot act loses. Shared because the three drivers each answered "a player has no
 * legal move" differently: battleRunner gave the win to the other seat, humanBattle hardcoded
 * seat 0, and battles.ts merely broke out of its inner loop and let the game carry on — so the
 * same soft-locked board was a loss in one engine and a non-event in another.
 */
export function applyStuckSeatLoss(G: PtcgGameState, stuckSeat: 0 | 1): void {
  if (G.winner !== null) return;
  G.winner = (1 - stuckSeat) as 0 | 1;
  G.winReason = 'no legal moves';
}
