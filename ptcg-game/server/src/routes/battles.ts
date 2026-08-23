import Router from '@koa/router';
import { randomUUID } from 'crypto';
import type { Card, LegalAction } from '@ptcg/shared';
import type { PtcgGameState } from '../game/GameState';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { fetchCardsByIds } from '../card-api/tcgdex';
import { applyTurnBegin, beginNextTurn } from '../game/turnLifecycle';
import { applyMove } from '../game/moveDispatch';
import { applyWinner, applyStuckSeatLoss } from '../game/winConditions';
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

function executeMove(G: PtcgGameState, move: LegalAction, player: number): void {
  const ctx: any = { currentPlayer: String(player), playerID: String(player), turn: G.turn, events: { endTurn: () => { G.phase = 'end'; } } };
  applyMove(G, move, ctx);
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
    let moveSafety = 0;
    // Bounds a single turn's move count — belt-and-suspenders against any move type that
    // `executeMove` doesn't recognize (a silent no-op would otherwise spin this loop forever,
    // since `G.phase` never reaches 'end' without genuine progress).
    while (G.winner === null && G.phase !== 'end' && moveSafety < 500) {
      moveSafety++;
      // See battleRunner's loop: a pendingChoice can name the player whose turn it ISN'T, and
      // while one stands nobody else has a legal move — so the actor is re-read every iteration.
      const player = (G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1;
      const legalMoves = getLegalMoves(G, player);
      // A seat with nothing legal to play has lost — the same rule battleRunner applies. This
      // used to be a bare `break`, so BattleLab shrugged off a soft-locked board that the
      // headless runner scored as a decisive loss.
      if (legalMoves.length === 0) { applyStuckSeatLoss(G, player); break; }
      const { action: move } = await ais[player].decide(G, player, legalMoves);
      if (!move) break;
      executeMove(G, move, player);
      if (applyWinner(G)) break;
    }
    if (G.winner !== null || beginNextTurn(G)) break;
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
