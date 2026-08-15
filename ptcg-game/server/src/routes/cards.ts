import Router from '@koa/router';
import {
  fetchAllCards, fetchCardById, fetchCardsByIds,
  fetchAllSets, refreshCache, getCachedCards,
  getEnrichmentStats,
} from '../card-api/tcgdex';
import { buildStandardByName, remapId } from '../card-api/printRemap';
import { getEvolutionChains } from '../game/evolutionChains';

const router = new Router();

/**
 * Legacy-id migration for saved decks (AGENTS.md backlog item D): maps outdated print ids
 * (rotated prints like S5R-027, old scraper scr-* ids) to a current Standard-legal print.
 * Response: { remap: { [oldId]: newId | null } } — oldId === newId means "already fine",
 * null means "unresolvable, keep the original". Used by the client deckStore's one-time
 * localStorage migration.
 */
/** Species evolution chains (child -> parent), for the client's 進化鏈 search. Static data. */
router.get('/evolution-chains', (ctx) => {
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = getEvolutionChains();
});

router.post('/remap', async (ctx) => {
  try {
    const { ids } = (ctx.request.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string') || ids.length > 2000) {
      ctx.status = 400;
      ctx.body = { error: 'ids must be an array of at most 2000 strings' };
      return;
    }
    const cards = await fetchAllCards();
    const byId = new Map(cards.map(c => [c.id, c]));
    const standardByName = buildStandardByName(cards);
    const remap: Record<string, string | null> = {};
    for (const id of new Set(ids as string[])) {
      remap[id] = remapId(id, byId, standardByName);
    }
    ctx.body = { remap };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to remap ids', detail: err.message };
  }
});

router.get('/', async (ctx) => {
  try {
    if (ctx.query.refresh === 'true') { await refreshCache(); }
    const cards = await fetchAllCards();
    ctx.body = cards;
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch cards', detail: err.message };
  }
});

router.get('/sets', async (ctx) => {
  try {
    const sets = await fetchAllSets();
    ctx.body = sets;
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch sets', detail: err.message };
  }
});

router.get('/search', async (ctx) => {
  try {
    const { q, supertype, type, set } = ctx.query;
    let cards = await fetchAllCards();
    if (q && typeof q === 'string') {
      const query = q.toLowerCase();
      cards = cards.filter(c => c.name.toLowerCase().includes(query));
    }
    if (supertype && typeof supertype === 'string') {
      cards = cards.filter(c => c.supertype === supertype);
    }
    if (type && typeof type === 'string') {
      cards = cards.filter(c => c.types?.includes(type as any));
    }
    if (set && typeof set === 'string') {
      cards = cards.filter(c => c.set.id === set);
    }
    ctx.body = cards;
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Search failed', detail: err.message };
  }
});

router.post('/batch-detail', async (ctx) => {
  try {
    const { ids } = ctx.request.body as { ids: string[] };
    if (!ids || !Array.isArray(ids)) {
      ctx.status = 400;
      ctx.body = { error: 'ids array required' };
      return;
    }
    const cards = await fetchCardsByIds(ids);
    ctx.body = cards;
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Batch fetch failed', detail: err.message };
  }
});

router.get('/enrich-stats', async (ctx) => {
  ctx.body = getEnrichmentStats();
});

router.get('/:id', async (ctx) => {
  try {
    const card = await fetchCardById(ctx.params.id);
    if (!card) { ctx.status = 404; ctx.body = { error: 'Card not found' }; return; }
    ctx.body = card;
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch card', detail: err.message };
  }
});

export { router as cardRoutes };
