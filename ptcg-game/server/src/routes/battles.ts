import Router from '@koa/router';
import { randomUUID } from 'crypto';
import type { Card, LegalAction } from '@ptcg/shared';
import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves } from '../game/validation';
import { fetchCardsByIds } from '../card-api/tcgdex';
import { promoteActiveIfNeeded } from '../game/damage';
import { applyTurnBegin } from '../game/turnLifecycle';
import { IAIPlayer, RandomAI, MockAI, ClaudeAI } from '../ai/aiPlayer';
import { HeuristicAI } from '../ai/heuristicAI';

/** Only 'claude' needs a real API key; everything else (including an unrecognized/missing
 * type) falls back to RandomAI, matching the old hardcoded-random behavior exactly when no
 * aiType is requested at all — so existing callers see zero behavior change. */
function resolveAiPlayer(type: string | undefined): IAIPlayer {
  if (type === 'heuristic') return new HeuristicAI();
  if (type === 'mock') return new MockAI();
  if (type === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Claude AI type requested but ANTHROPIC_API_KEY is not configured on this server.');
    return new ClaudeAI({ apiKey, model: process.env.ANTHROPIC_MODEL });
  }
  return new RandomAI();
}

interface BattleRecord {
  matchId: string; deckA: string[]; deckB: string[];
  winner: number; winReason: string | null; turns: number;
  logs: any[]; createdAt: number;
}
const battleStore = new Map<string, BattleRecord>();

// Same unbounded-growth issue as humanBattle.ts's session map — these records hold full turn
// logs (up to 10 games' worth per request) and are never removed on their own. Swept
// periodically AND hard-capped by count (see MAX_RECORDS below) — the time-based sweep alone
// isn't enough protection against heavy short-burst usage (e.g. repeated manual testing/
// regression batches within the same couple of hours): this exact map, uncapped, was the
// direct cause of a real "JavaScript heap out of memory" crash after a long dev session.
const RECORD_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const RECORD_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RECORDS = 20; // ~20 batches x up to 10 games' worth of logs each, worst case
setInterval(() => {
  try {
    const cutoff = Date.now() - RECORD_TTL_MS;
    for (const [id, record] of battleStore) {
      if (record.createdAt < cutoff) battleStore.delete(id);
    }
  } catch (err) {
    console.error('[battles] record sweep failed:', err);
  }
}, RECORD_SWEEP_INTERVAL_MS).unref();

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
    case 'use_ability': moves.useAbility({ G, ctx }, p.cardId as string); break;
    case 'resolve_choice': moves.resolveChoice({ G, ctx }, p.selection as string[]); break;
    case 'retreat': moves.retreat({ G, ctx }, p.targetBenchPosition as number, p.discardEnergyIds as string[]); break;
    case 'attack': moves.attack({ G, ctx }, p.attackIndex as number); break;
    case 'end_turn': moves.endTurn({ G, ctx }); break;
    case 'forfeit': moves.forfeit({ G, ctx }); break;
  }
}

async function simulateBattle(decks: string[][], seed: number, aiTypeA: string | undefined, aiTypeB: string | undefined): Promise<{ winner: number; winReason: string | null; turns: number; logs: any[] }> {
  const allIds = [...new Set([...decks[0], ...decks[1]])];
  const cardData = await fetchCardsByIds(allIds);
  const cardDataMap = cardData as unknown as Record<string, Card>;
  const G = setup({ decks, cardData: cardDataMap, seed });
  const ais: [IAIPlayer, IAIPlayer] = [resolveAiPlayer(aiTypeA), resolveAiPlayer(aiTypeB)];
  applyTurnBegin(G);
  let safety = 0;
  while (G.winner === null && safety < 200) {
    safety++;
    const player = G.currentPlayer as 0 | 1;
    let moveSafety = 0;
    // Bounds a single turn's move count — belt-and-suspenders against any move type that
    // `executeMove` doesn't recognize (a silent no-op would otherwise spin this loop forever,
    // since `G.phase` never reaches 'end' without genuine progress).
    while (G.winner === null && G.phase !== 'end' && moveSafety < 500) {
      moveSafety++;
      const legalMoves = getLegalMoves(G, player);
      if (legalMoves.length === 0) break;
      const { action: move } = await ais[player].decide(G, player, legalMoves);
      if (!move) break;
      executeMove(G, move, player);
      const winner = checkWinner(G);
      if (winner !== null) { G.winner = winner; break; }
    }
    if (G.winner !== null) break;
    G.currentPlayer = (1 - G.currentPlayer) as 0 | 1;
    G.turn++;
    applyTurnBegin(G);
  }
  return { winner: G.winner ?? 0, winReason: G.winReason, turns: G.turn, logs: [...G.turnLog] };
}

const router = new Router();

router.post('/ai-vs-ai', async (ctx) => {
  try {
    const { deckA, deckB, games, aiTypeA, aiTypeB } = ctx.request.body as any;
    if (!deckA || !deckB) { ctx.status = 400; ctx.body = { error: 'deckA and deckB required' }; return; }
    // Claude costs real money per move and a full game is dozens of calls — cap batches
    // involving it well below the normal 10-game ceiling so a user can't accidentally burn a
    // large amount of API spend from one BattleLab click.
    const involvesClaude = aiTypeA === 'claude' || aiTypeB === 'claude';
    const numGames = Math.min(games || 1, involvesClaude ? 3 : 10);
    const matchId = randomUUID();
    const results: any[] = [];
    const aggregated: Record<number, number> = { 0: 0, 1: 0 };
    for (let i = 0; i < numGames; i++) {
      const result = await simulateBattle([deckA, deckB], Date.now() + i, aiTypeA, aiTypeB);
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
    // Map iteration order is insertion order, so the first key is the oldest.
    while (battleStore.size > MAX_RECORDS) {
      const oldest = battleStore.keys().next().value;
      if (oldest === undefined) break;
      battleStore.delete(oldest);
    }
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
