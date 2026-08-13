import Router from '@koa/router';

const router = new Router();

/** Lets the client know whether "hard" (ClaudeAI) difficulty is actually usable before
 * offering it — avoids surfacing an option that would just 400 with no API key configured. */
router.get('/', (ctx) => {
  ctx.body = { hard: !!process.env.ANTHROPIC_API_KEY };
});

export { router as aiStatusRoutes };
