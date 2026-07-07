/**
 * Merge scraped-cards.json into cards.json (TCGdex cache).
 *
 * 1. Reads scraped-cards.json (cards scraped from official site)
 * 2. Reads cards.json (TCGdex zh-tw cache)
 * 3. Adds scraped cards whose id doesn't already exist in cards.json
 * 4. Saves updated cards.json
 *
 * Run AFTER import-official-standard.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_CACHE = path.resolve(__dirname, '../../data/scraped-cards.json');

interface CacheWrapper {
  timestamp: number;
  data: MapCard[];
}

function main() {
  // ── Read both sources ──
  console.log('Reading cards.json (TCGdex cache)...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  const existingIds = new Set(cards.map(c => c.id));

  console.log(`TCGdex cards: ${cards.length}`);

  console.log('\nReading scraped-cards.json...');
  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_CACHE, 'utf-8'));
  const scraped = scrapedRaw.data as MapCard[];

  console.log(`Scraped cards total: ${scraped.length}`);

  // ── Filter out already-existing IDs ──
  const toMerge = scraped.filter(c => !existingIds.has(c.id));
  const skipped = scraped.length - toMerge.length;

  console.log(`New to add: ${toMerge.length}`);
  console.log(`Skipped (id exists): ${skipped}`);

  // ── Merge ──
  let added = 0;
  for (const card of toMerge) {
    // Ensure it has legalities
    if (!card.legalities) card.legalities = {};
    cards.push(card);
    added++;
  }

  // ── Save ──
  cacheRaw.timestamp = Date.now();
  const json = JSON.stringify(cacheRaw, null, 2);
  fs.writeFileSync(CARDS_CACHE, json, 'utf-8');

  console.log(`\n=== Merge Complete ===`);
  console.log(`Added: ${added}`);
  console.log(`Total cards now: ${cards.length}`);
  console.log(`Saved: ${(json.length / 1024).toFixed(0)} KB`);
}

main();
