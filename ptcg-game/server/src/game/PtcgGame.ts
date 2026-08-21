import { Game, Ctx } from 'boardgame.io';
import { TurnOrder } from 'boardgame.io/core';
import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { setup } from './setup';
import { moves } from './moves';
import { applyTurnBegin } from './turnLifecycle';
import { promoteActiveIfNeeded } from './damage';

/** The shared `moves.ts` calls `ctx.events?.endTurn?.()` to end a turn — that was boardgame.io's
 * pre-0.50 API shape. This project's other two engines (humanBattle.ts, battleRunner.ts) build
 * their own fake `ctx` objects with `events` nested exactly like that, deliberately matching
 * this call site — but real boardgame.io 0.50 passes `events` as a SIBLING of `ctx`, not nested
 * inside it, so `ctx.events` is always undefined there and every `endTurn()`/`endGame()` call
 * from a shared move silently no-ops in this engine alone. Since PtcgGame.ts is the only one of
 * the three that talks to the real API, the compatibility shim belongs here, not in the shared
 * file the other two engines also rely on: wrap every move so its `ctx` gets `events` copied
 * onto it before the shared implementation ever runs. */
function withEventsOnCtx(fn: (...args: any[]) => any) {
  return (context: any, ...args: any[]) => fn({ ...context, ctx: { ...context.ctx, events: context.events } }, ...args);
}
const bgioMoves = Object.fromEntries(Object.entries(moves).map(([name, fn]) => [name, withEventsOnCtx(fn as any)]));

/** Shared game-over check, independent of phase — reused as the top-level `endIf` so it's
 * evaluated after every move regardless of which phase (setup or play) is active. */
export function checkGameOver({ G }: { G: PtcgGameState; ctx?: Ctx }): number | undefined {
  if (G.winner !== null) return G.winner;
  // During the setup phases a player legitimately has no Pokémon in play yet, so the "opponent
  // has no pokemon" condition below is meaningless there — and because this is the top-level
  // endIf, it runs before the first move of an interactive game, where setup() deliberately
  // leaves the interactive seat's Active null for it to choose. Without this guard boardgame.io
  // ended every human match instantly, handing the win to the opposite seat. humanBattle.ts's
  // checkAndApplyWin has carried the same guard since it hit exactly this bug; battleRunner.ts's
  // checkEndCondition carries it too so all three copies agree. Direct winners (forfeit) are
  // still honored by the G.winner check above.
  if (G.phase === 'choose_first' || G.phase === 'choose_active') return undefined;
  for (let p = 0; p < 2; p++) {
    const player = G.players[p as 0 | 1];
    const opponent = G.players[(1 - p) as 0 | 1];
    if (player.takenPrizes >= 6) return p;
    if (!opponent.active && opponent.bench.every((s: GameCard | null) => s === null)) return p;
  }
  const cur = G.players[G.currentPlayer];
  if (cur.deck.length === 0 && G.phase === 'draw') return 1 - G.currentPlayer;
  return undefined;
}

export const PtcgGame: Game<PtcgGameState> = {
  name: 'ptcg',

  setup: (_ctx: unknown, setupData: any) => setup(setupData),

  moves: bgioMoves,

  phases: {
    // Coin-flip / opening-Active selection / mulligan-compensation choices. moves.chooseFirst,
    // chooseActive and resolveChoice (this module's own shared implementations, same as
    // humanBattle.ts and battleRunner.ts use) drive these by mutating G.currentPlayer directly
    // rather than calling ctx.events.endTurn() — real boardgame.io, unlike this project's other
    // two engines, gates "who's allowed to call a move" on its OWN ctx.currentPlayer, so without
    // help that would drift from G.currentPlayer the instant a setup move hands off to a
    // different seat (e.g. local 2P's second choose_active). `moveLimit: 1` closes that gap: it
    // makes boardgame.io end its internal "turn" after every single move automatically, which
    // re-invokes `order.first`/`next` and re-reads G.currentPlayer fresh each time — no change to
    // the shared move functions themselves needed.
    setupPhase: {
      start: true,
      turn: {
        order: {
          first: ({ G }: { G: PtcgGameState }) => G.currentPlayer,
          next: ({ G }: { G: PtcgGameState }) => G.currentPlayer,
        },
        moveLimit: 1,
      },
      // Leaving 'choose_active' alone isn't enough: a mulligan-bonus PendingChoice can still be
      // outstanding for a DIFFERENT seat than G.firstPlayer even after G.phase already reads
      // 'draw' (raiseNextMulliganBonusOrFinish in moves.ts sets G.currentPlayer to the owed
      // seat, not firstPlayer, while that choice is pending) — transitioning early would hand
      // the `play` phase's turn order straight to firstPlayer and strand that choice unreachable.
      endIf: ({ G }: { G: PtcgGameState }) =>
        G.phase !== 'choose_first' && G.phase !== 'choose_active' &&
        G.pendingChoice?.effectKey !== 'mulligan_bonus' && G.pendingChoice?.effectKey !== 'mulligan_bonus_bench',
      next: 'play',
      // setup() initializes G.turn to 1 for the shared engines' own benefit (battleRunner/
      // humanBattle never run a setup phase at all), but here that value has just spent an
      // indeterminate number of moveLimit:1 micro-turns being irrelevant — reset it to 0 so
      // `play`'s turn.onBegin can unconditionally `G.turn++` on every call, including its first,
      // and land on exactly 1 for the real first turn.
      onEnd: ({ G }: { G: PtcgGameState }) => { G.turn = 0; },
    },

    play: {
      turn: {
        order: {
          // Real rules: the coin-flip winner picks who takes turn 1. By the time setupPhase's
          // endIf above goes true, moves.ts (chooseActive/resolveChoice) has already resolved
          // G.currentPlayer to exactly that seat — reuse it rather than re-deriving.
          first: ({ G }: { G: PtcgGameState }) => G.currentPlayer,
          next: TurnOrder.DEFAULT.next,
        },
        onBegin: ({ G, ctx }: { G: PtcgGameState; ctx: Ctx }) => {
          // Trust boardgame.io's own order.first/next result (ctx.currentPlayer) rather than
          // flipping G.currentPlayer by hand — it already accounts for whichever seat order.first
          // picked for turn 1 and alternates correctly from there.
          G.currentPlayer = parseInt(ctx.currentPlayer) as 0 | 1;
          // G.turn is this shared engine's own counter (validation.ts's isFirstTurnOfGame etc.
          // read G.turn, not ctx.turn) — self-incremented here (the shared
          // applyTurnBegin below does not touch it), NOT derived from ctx.turn, which also
          // counts every setupPhase moveLimit:1 micro-turn and would badly over-count "turn 1"
          // of real gameplay if used directly. Safe to always increment: setupPhase.onEnd above
          // reset G.turn to 0 right before this phase's first turn begins.
          G.turn++;
          applyTurnBegin(G);
        },
      },
    },
  },

  endIf: checkGameOver,
};
