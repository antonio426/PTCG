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
