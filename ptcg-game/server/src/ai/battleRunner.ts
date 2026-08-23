import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { applyTurnBegin, beginNextTurn } from '../game/turnLifecycle';
import { applyMove } from '../game/moveDispatch';
import { applyWinner, applyStuckSeatLoss } from '../game/winConditions';
import { MAX_MOVES_PER_GAME, SAFETY_CAP_REASON } from '../game/engineLimits';
import { IAIPlayer } from './aiPlayer';
import { AIThought, AIPlayerResult } from './types';

export interface BattleConfig {
  deckA: string[];
  deckB: string[];
  cardData: Record<string, any>;
  playerA: IAIPlayer;
  playerB: IAIPlayer;
  games: number;
  concurrency?: number;
  seed?: number;
}

export interface BattleStats {
  totalGames: number;
  playerAWins: number;
  playerBWins: number;
  draws: number;
  averageTurns: number;
  playerAWinRate: number;
  playerBWinRate: number;
  gameResults: AIPlayerResult[];
}

/** Kept as a named export because the scripts and tests call it; the rule itself lives in
 * game/winConditions.ts so all four engines decide the game the same way. */
export function checkEndCondition(G: PtcgGameState): void {
  applyWinner(G);
}

export { applyTurnBegin };

export function executeMove(G: PtcgGameState, action: { type: string; payload?: Record<string, any> }, actor?: 0 | 1): boolean {
  let turnEnded = false;
  const ctx = {
    currentPlayer: String(G.currentPlayer),
    playerID: String(actor ?? G.currentPlayer),
    events: {
      endTurn: () => {
        turnEnded = true;
      },
    },
  };

  applyMove(G, action, ctx);
  return turnEnded;
}

async function runSingleGame(
  gameId: string,
  config: BattleConfig,
  _gameIndex: number,
): Promise<AIPlayerResult> {
  const seed = config.seed !== undefined ? config.seed + _gameIndex : undefined;
  const G = setup({
    decks: [config.deckA, config.deckB],
    cardData: config.cardData,
    seed,
  });

  const players: [IAIPlayer, IAIPlayer] = [config.playerA, config.playerB];
  const thoughts: AIThought[] = [];

  applyTurnBegin(G);

  let moveSafety = 0;
  while (G.winner === null && moveSafety < MAX_MOVES_PER_GAME) {
    moveSafety++;
    // A pendingChoice can belong to the player whose turn it ISN'T ("the opponent chooses"), and
    // getLegalMoves returns nothing for anyone else while one is standing — polling only
    // currentPlayer used to end the game right there with a "no legal moves" win for the wrong
    // player, which is why such effects had to auto-resolve instead of asking.
    const playerIdx = (G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1;
    const ai = players[playerIdx];
    const legalMoves = getLegalMoves(G, playerIdx);

    if (legalMoves.length === 0) {
      applyStuckSeatLoss(G, playerIdx);
      break;
    }

    const { action, thought } = await ai.decide(G, playerIdx, legalMoves);

    thoughts.push({
      turn: G.turn,
      player: playerIdx,
      thought,
      action: { type: action.type, description: action.description, payload: action.payload },
      timestamp: Date.now(),
    });

    const turnEnded = executeMove(G, action, playerIdx);

    checkEndCondition(G);
    if (G.winner !== null) break;

    if (turnEnded && beginNextTurn(G)) break;
  }
  // Hitting the cap means the game never resolved — recording it as a player-0 win is a lie that
  // inflated seat A's rate in every measurement this runner feeds (BattleLab, ai-strength.ts),
  // and it also made BattleStats.draws — which counts `winner === null` — permanently zero, so
  // the number that would have exposed the problem could never move. The reason is still
  // recorded; the winner stays null.
  if (G.winner === null) G.winReason = SAFETY_CAP_REASON;

  return {
    gameId,
    winner: G.winner,
    turns: G.turn,
    thoughts,
    logs: G.turnLog,
  };
}

export async function runBattles(config: BattleConfig): Promise<BattleStats> {
  const concurrency = Math.min(config.concurrency || 4, config.games);
  const results: AIPlayerResult[] = [];

  for (let i = 0; i < config.games; i += concurrency) {
    const batch = Math.min(concurrency, config.games - i);
    const promises: Promise<AIPlayerResult>[] = [];

    for (let j = 0; j < batch; j++) {
      const gameIndex = i + j;
      promises.push(runSingleGame(`game_${gameIndex}`, config, gameIndex));
    }

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  const playerAWins = results.filter(r => r.winner === 0).length;
  const playerBWins = results.filter(r => r.winner === 1).length;
  const draws = results.filter(r => r.winner === null).length;
  const totalTurns = results.reduce((sum, r) => sum + r.turns, 0);

  return {
    totalGames: results.length,
    playerAWins,
    playerBWins,
    draws,
    averageTurns: results.length > 0 ? totalTurns / results.length : 0,
    playerAWinRate: results.length > 0 ? playerAWins / results.length : 0,
    playerBWinRate: results.length > 0 ? playerBWins / results.length : 0,
    gameResults: results,
  };
}
