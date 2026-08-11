import * as fs from 'fs';
import * as path from 'path';
import { MapCard, SetData, CacheData } from './types';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const SETS_FILE = path.join(DATA_DIR, 'sets.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function isCacheValid<T>(cache: CacheData<T>): boolean {
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

function readCacheFile<T>(filePath: string): CacheData<T> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const cache: CacheData<T> = JSON.parse(raw);
    return cache;
  } catch {
    return null;
  }
}

// Async on purpose: the card cache is ~10,000+ entries, and a synchronous write blocks the
// ENTIRE Node event loop for its duration — every other in-flight request (including totally
// unrelated ones, like fetching preset decks) stalls until it finishes. This is called several
// times per background-enrichment pass (every 100 cards + a final save), and enrichment
// re-runs after every `tsx watch` restart — so under active development this could fire
// repeatedly in quick succession, each one freezing the whole server for however long the
// synchronous stringify+write took. This was reproduced live: the server stopped responding to
// ANY request, including ones with no card-data dependency at all, matching exactly that pattern.
async function writeCacheFile<T>(filePath: string, data: T): Promise<void> {
  ensureDataDir();
  const cache: CacheData<T> = { timestamp: Date.now(), data };
  await fs.promises.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8');
}

export async function saveCardCache(cards: MapCard[]): Promise<void> {
  await writeCacheFile(CARDS_FILE, cards);
}

export function loadCardCache(ignoreTTL = false): MapCard[] | null {
  const cache = readCacheFile<MapCard[]>(CARDS_FILE);
  if (!cache) return null;
  if (ignoreTTL || isCacheValid(cache)) return cache.data;
  return null;
}

export async function saveSetCache(sets: SetData[]): Promise<void> {
  await writeCacheFile(SETS_FILE, sets);
}

export function loadSetCache(ignoreTTL = false): SetData[] | null {
  const cache = readCacheFile<SetData[]>(SETS_FILE);
  if (!cache) return null;
  if (ignoreTTL || isCacheValid(cache)) return cache.data;
  return null;
}

export function getCacheTimestamp(): { cards: number | null; sets: number | null } {
  const cardsCache = readCacheFile<MapCard[]>(CARDS_FILE);
  const setsCache = readCacheFile<SetData[]>(SETS_FILE);
  return {
    cards: cardsCache?.timestamp ?? null,
    sets: setsCache?.timestamp ?? null,
  };
}

export function clearCache(): void {
  try {
    if (fs.existsSync(CARDS_FILE)) fs.unlinkSync(CARDS_FILE);
    if (fs.existsSync(SETS_FILE)) fs.unlinkSync(SETS_FILE);
  } catch {
  }
}
