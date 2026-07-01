import Router from '@koa/router';
import { randomUUID } from 'crypto';
import type { Card, LegalAction } from '@ptcg/shared';
import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves } from '../game/validation';
import { fetchCardsByIds } from '../card-api/tcgdex';

interface BattleRecord {
  matchId: string; deckA: string[]; deckB: string[];
  winner: number; winReason: string | null; turns: number;
  logs: any[]; createdAt: number;
}
const battleStore = new Map<string, BattleRecord>();

function checkWinner(G: PtcgGameState): number | null {
  for (let p = 0; p < 2; p++) {
    const player = G.players[p as 0 | 1];
    const opponent = G.players[(1 - p) as 0 | 1];
    if (player.takenPrizes >= 6) return p;
    if (!opponent.active && opponent.bench.every(s => s === null)) return p;
  }
  const cur = G.players[G.currentPlayer as 0 | 1];
  if (cur.deck.length === 0 && G.phase === 'draw') return (1 - G.currentPlayer) as 0 | 1;
  return null;
}

function executeMove(G: PtcgGameState, move: LegalAction, player: number): void {
  const ctx: any = { currentPlayer: String(player), turn: G.turn, events: { endTurn: () => { G.phase = 'end'; } } };
  const p = move.payload || {};
  switch (move.type) {
    case 'draw_card': moves.drawCard({ G, ctx }); break;
    case 'play_pokemon': moves.playPokemon({ G, ctx }, p.cardId as string, p.benchPosition as number); break;
    case 'evolve_pokemon': moves.evolvePokemon({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'attach_energy': moves.attachEnergy({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'play_trainer': moves.playTrainer({ G, ctx }, p.cardId as string); break;
    case 'retreat': moves.retreat({ G, ctx }, p.targetBenchPosition as number); break;
    case 'attack': moves.attack({ G, ctx }, p.attackIndex as number); break;
    case 'end_turn': moves.endTurn({ G, ctx }); break;
    case 'forfeit': moves.forfeit({ G, ctx }); break;
  }
}

function runTurnBegin(G: PtcgGameState): void {
  G.phase = G.turn === 1 ? 'main' : 'draw';
  const player = G.players[G.currentPlayer as 0 | 1];
  if (player) {
    player.energyAttachedThisTurn = 0; player.basicPokemonPlayedThisTurn = 0;
    player.supporterPlayedThisTurn = false; player.pokemonPlayedThisTurn = []; player.cardsPlayedThisTurn = 0;
  }
}

function selectRandomMove(G: PtcgGameState, playerIndex: number): LegalAction | null {
  const legalMoves = getLegalMoves(G, playerIndex);
  if (legalMoves.length === 0) return null;
  const validMoves = legalMoves.filter(m => m.type !== 'forfeit');
  const pool = validMoves.length > 0 ? validMoves : legalMoves;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

async function simulateBattle(decks: string[][], seed: number): Promise<{ winner: number; winReason: string | null; turns: number; logs: any[] }> {
  const allIds = [...new Set([...decks[0], ...decks[1]])];
  const cardData = await fetchCardsByIds(allIds);
  const cardDataMap = cardData as unknown as Record<string, Card>;
  const G = setup({ decks, cardData: cardDataMap, seed });
  runTurnBegin(G);
  let safety = 0;
  while (G.winner === null && safety < 200) {
    safety++;
    const player = G.currentPlayer as 0 | 1;
    while (G.winner === null && G.phase !== 'end') {
      const move = selectRandomMove(G, player);
      if (!move) break;
      executeMove(G, move, player);
      const winner = checkWinner(G);
      if (winner !== null) { G.winner = winner; break; }
      if (G.phase === 'end') break;
    }
    if (G.winner !== null) break;
    G.currentPlayer = (1 - G.currentPlayer) as 0 | 1;
    G.turn++;
    runTurnBegin(G);
  }
  return { winner: G.winner ?? 0, winReason: G.winReason, turns: G.turn, logs: [...G.turnLog] };
}

const router = new Router();

router.post('/ai-vs-ai', async (ctx) => {
  try {
    const { deckA, deckB, games } = ctx.request.body as any;
    if (!deckA || !deckB) { ctx.status = 400; ctx.body = { error: 'deckA and deckB required' }; return; }
    const numGames = Math.min(games || 1, 10);
    const matchId = randomUUID();
    const results: any[] = [];
    const aggregated: Record<number, number> = { 0: 0, 1: 0 };
    for (let i = 0; i < numGames; i++) {
      const result = await simulateBattle([deckA, deckB], Date.now() + i);
      results.push(result);
      aggregated[result.winner] = (aggregated[result.winner] || 0) + 1;
    }
    const totalTurns = results.reduce((s, r) => s + r.turns, 0);
    const record: BattleRecord = {
      matchId, deckA, deckB,
      winner: aggregated[1] > aggregated[0] ? 1 : 0,
      winReason: results[results.length - 1].winReason,
      turns: totalTurns,
      logs: results.map(r => r.logs).flat(),
      createdAt: Date.now(),
    };
    battleStore.set(matchId, record);
    ctx.body = { matchId, results, summary: { games: numGames, aggregated, overall_winner: record.winner, avg_turns: numGames > 0 ? totalTurns / numGames : 0 } };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: err.message || 'Battle simulation failed' };
  }
});

router.get('/:id', (ctx) => {
  const record = battleStore.get(ctx.params.id);
  if (!record) { ctx.status = 404; ctx.body = { error: 'Battle not found' }; return; }
  ctx.body = record;
});

router.get('/:id/logs', (ctx) => {
  const record = battleStore.get(ctx.params.id);
  if (!record) { ctx.status = 404; ctx.body = { error: 'Battle not found' }; return; }
  ctx.body = record.logs;
});

export { router as battleRoutes };
