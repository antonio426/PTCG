import cors from '@koa/cors';
import koaBody from 'koa-body';
import Router from '@koa/router';
import { Server } from 'boardgame.io/server';
import { PtcgGame } from './game/PtcgGame';
import { cardRoutes } from './routes/cards';
import { battleRoutes } from './routes/battles';
import { imageRoutes } from './routes/images';

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
apiRouter.use('/images', imageRoutes.routes(), imageRoutes.allowedMethods());
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());

server.run(PORT, () => {
  console.log(`PTCG Server running on port ${PORT}`);
});
