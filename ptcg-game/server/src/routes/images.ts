import Router from '@koa/router';
import * as fs from 'fs';
import * as path from 'path';

const IMAGES_DIR = path.resolve(__dirname, '../../data/images');
const CDN = 'https://assets.tcgdex.net';

const router = new Router();

// Serve card images from local cache, with CDN fallback
// URL format: /api/images/:serie/:set/:localId/:variant  (no .png extension)
// CDN format: https://assets.tcgdex.net/{lang}/{serie}/{setId}/{localId}/{variant}.png
router.get('/:serie/:set/:localId/:variant', async (ctx) => {
  const { serie, set: setId, localId, variant } = ctx.params;

  if (variant !== 'low' && variant !== 'high') {
    ctx.status = 400;
    ctx.body = { error: 'Invalid variant' };
    return;
  }

  const localPath = path.join(IMAGES_DIR, setId, `${localId}.png`);

  // Serve from local cache if available
  if (fs.existsSync(localPath)) {
    ctx.type = 'image/png';
    ctx.body = fs.createReadStream(localPath);
    return;
  }

  // Fallback: proxy from CDN
  const cdnUrl = `${CDN}/zh-tw/${serie}/${setId}/${localId}/high.png`;
  try {
    const response = await fetch(cdnUrl, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      ctx.type = 'image/png';
      ctx.body = buffer;
      // Save locally for future requests (fire-and-forget)
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      fs.promises.writeFile(localPath, buffer).catch(() => {});
      return;
    }
  } catch {
    // CDN fetch failed
  }

  ctx.status = 404;
  ctx.body = { error: 'Image not found' };
});

export { router as imageRoutes };
