import cors from '@koa/cors';
import koaBody from 'koa-body';
import Router from '@koa/router';
import { Server } from 'boardgame.io/server';
import { PtcgGame } from './game/PtcgGame';
import { cardRoutes } from './routes/cards';
import { battleRoutes } from './routes/battles';
import { humanBattleRoutes } from './routes/humanBattle';
import { imageRoutes } from './routes/images';
import { presetDeckRoutes } from './routes/preset-decks';
import { fetchAllCards } from './card-api/tcgdex';

const PORT = parseInt(process.env.PORT || '3001', 10);

// Without these, any exception thrown outside a request handler (a timer callback, an
// unawaited promise, boardgame.io's own internals) is a genuinely uncaught exception —
// Node's default response is to silently kill the whole process. `tsx watch` only restarts on
// file changes, not runtime crashes, so a crash here would otherwise leave the server dead
// (port closed) with the watcher process still sitting there looking alive, no error visible
// anywhere the user would think to look. Logging keeps the process up and leaves a paper trail.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const server = Server({
  games: [PtcgGame],
  origins: ['http://localhost:5173', 'http://localhost:3000'],
});

const app = server.app;
app.use(cors({ origin: '*' }));
app.use(koaBody({ jsonLimit: '10mb' }));

const apiRouter = new Router({ prefix: '/api' });
apiRouter.use('/cards', cardRoutes.routes(), cardRoutes.allowedMethods());
apiRouter.use('/battles', battleRoutes.routes(), battleRoutes.allowedMethods());
apiRouter.use('/human-battle', humanBattleRoutes.routes(), humanBattleRoutes.allowedMethods());
apiRouter.use('/images', imageRoutes.routes(), imageRoutes.allowedMethods());
apiRouter.use('/preset-decks', presetDeckRoutes.routes(), presetDeckRoutes.allowedMethods());
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

server.run(PORT, async () => {
  console.log(`PTCG Server running on port ${PORT}`);
  // Preload cards on startup so enrichment starts early
  try {
    const cards = await fetchAllCards();
    console.log(`Preloaded ${cards.length} cards`);
  } catch (e: any) {
    console.error('Failed to preload cards:', e.message);
  }
});
