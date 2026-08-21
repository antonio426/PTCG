import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves } from '../game/validation';
import { applyTurnBegin } from '../game/turnLifecycle';
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

export function checkEndCondition(G: PtcgGameState): void {
  if (G.winner !== null) return;
  // A player legitimately has no Pokémon in play during the setup phases — see the fuller
  // comment on PtcgGame.ts's checkGameOver. Headless runs auto-place both Actives in setup() so
  // this is unreachable today, but the three win-check copies are kept identical on purpose:
  // the documented failure mode here is one copy getting a rule right that the others don't.
  if (G.phase === 'choose_first' || G.phase === 'choose_active') return;
  for (let p = 0; p < 2; p++) {
    const player = G.players[p as 0 | 1];
    const opponent = G.players[(1 - p) as 0 | 1];
    if (player.takenPrizes >= 6) {
      G.winner = p as 0 | 1;
      G.winReason = 'took all prizes';
      return;
    }
    if (!opponent.active && opponent.bench.every(s => s === null)) {
      G.winner = p as 0 | 1;
      G.winReason = 'opponent has no pokemon';
      return;
    }
  }
  const cur = G.players[G.currentPlayer];
  if (cur.deck.length === 0 && G.phase === 'draw') {
    G.winner = (1 - G.currentPlayer) as 0 | 1;
    G.winReason = 'deck empty at draw';
  }
}

export { applyTurnBegin };

export function advanceTurn(G: PtcgGameState): void {
  G.currentPlayer = (1 - G.currentPlayer) as 0 | 1;
  G.turn++;
}

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

  const payload = (action.payload || {}) as Record<string, any>;

  switch (action.type) {
    case 'draw_card':
      moves.drawCard({ G, ctx });
      break;
    case 'play_pokemon':
      moves.playPokemon({ G, ctx }, payload.cardId, payload.benchPosition);
      break;
    case 'evolve_pokemon':
      moves.evolvePokemon({ G, ctx }, payload.cardId, payload.targetId);
      break;
    case 'attach_energy':
      moves.attachEnergy({ G, ctx }, payload.cardId, payload.targetId);
      break;
    case 'play_trainer':
      moves.playTrainer({ G, ctx }, payload.cardId);
      break;
    case 'use_ability':
      moves.useAbility({ G, ctx }, payload.cardId);
      break;
    case 'resolve_choice':
      moves.resolveChoice({ G, ctx }, payload.selection);
      break;
    case 'retreat':
      moves.retreat({ G, ctx }, payload.targetBenchPosition, payload.discardEnergyIds);
      break;
    case 'discard_fossil':
      moves.discardFossil({ G, ctx }, payload.cardId);
      break;
    case 'attack':
      moves.attack({ G, ctx }, payload.attackIndex);
      break;
    case 'use_stadium_action':
      moves.useStadiumAction({ G, ctx }, payload.effectKey);
      break;
    case 'end_turn':
      moves.endTurn({ G, ctx });
      break;
    case 'forfeit':
      moves.forfeit({ G, ctx });
      break;
  }

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
  while (G.winner === null && moveSafety < 2000) {
    moveSafety++;
    // A pendingChoice can belong to the player whose turn it ISN'T ("the opponent chooses"), and
    // getLegalMoves returns nothing for anyone else while one is standing — polling only
    // currentPlayer used to end the game right there with a "no legal moves" win for the wrong
    // player, which is why such effects had to auto-resolve instead of asking.
    const playerIdx = (G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1;
    const ai = players[playerIdx];
    const legalMoves = getLegalMoves(G, playerIdx);

    if (legalMoves.length === 0) {
      G.winner = (1 - playerIdx) as 0 | 1;
      G.winReason = 'no legal moves';
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

    if (turnEnded) {
      advanceTurn(G);
      applyTurnBegin(G);
    }
  }
  if (G.winner === null) {
    G.winner = 0;
    G.winReason = 'safety cap exceeded';
  }

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
