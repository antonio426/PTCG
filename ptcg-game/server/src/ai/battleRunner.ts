import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves } from '../game/validation';
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

function checkEndCondition(G: PtcgGameState): void {
  if (G.winner !== null) return;
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

function applyTurnBegin(G: PtcgGameState): void {
  G.phase = G.turn === 1 ? 'main' : 'draw';
  const player = G.players[G.currentPlayer];
  player.energyAttachedThisTurn = 0;
  player.basicPokemonPlayedThisTurn = 0;
  player.supporterPlayedThisTurn = false;
  player.pokemonPlayedThisTurn = [];
  player.cardsPlayedThisTurn = 0;
}

function advanceTurn(G: PtcgGameState): void {
  G.currentPlayer = (1 - G.currentPlayer) as 0 | 1;
  G.turn++;
}

function executeMove(G: PtcgGameState, action: { type: string; payload?: Record<string, any> }): boolean {
  let turnEnded = false;
  const ctx = {
    currentPlayer: String(G.currentPlayer),
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
    case 'retreat':
      moves.retreat({ G, ctx }, payload.targetBenchPosition);
      break;
    case 'attack':
      moves.attack({ G, ctx }, payload.attackIndex);
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

  while (G.winner === null) {
    const playerIdx = G.currentPlayer;
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

    const turnEnded = executeMove(G, action);

    checkEndCondition(G);
    if (G.winner !== null) break;

    if (turnEnded) {
      advanceTurn(G);
      applyTurnBegin(G);
    }
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
