import Router from '@koa/router';
import {
  fetchAllCards, fetchCardById, fetchCardsByIds,
  fetchAllSets, refreshCache, getCachedCards,
} from '../card-api/tcgdex';

const router = new Router();

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
