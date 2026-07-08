import * as fs from 'fs';
import * as path from 'path';
import Router from '@koa/router';

const router = new Router();

interface PresetDeckEntry {
  cardId: string;
  count: number;
}

interface PresetDeckSource {
  id: string;
  name: string;
  entries: PresetDeckEntry[];
}

interface PresetDeckResponse {
  id: string;
  name: string;
  cards: string[];
  format: string;
  preset: true;
}

const DECKS_PATH = path.resolve(__dirname, '../../data/preset-decks.json');

let cached: PresetDeckResponse[] | null = null;

function loadPresetDecks(): PresetDeckResponse[] {
  if (cached) return cached;

  const raw = JSON.parse(fs.readFileSync(DECKS_PATH, 'utf-8')) as PresetDeckSource[];
  cached = raw.map((deck) => {
    const cards: string[] = [];
    for (const entry of deck.entries) {
      for (let i = 0; i < entry.count; i++) {
        cards.push(entry.cardId);
      }
    }
    return {
      id: deck.id,
      name: deck.name,
      cards,
      format: 'standard',
      preset: true as const,
    };
  });

  return cached;
}

router.get('/', async (ctx) => {
  // Allow re-read when query param ?refresh=1
  if (ctx.query.refresh === '1') {
    cached = null;
  }
  ctx.body = loadPresetDecks();
});

export { router as presetDeckRoutes };
