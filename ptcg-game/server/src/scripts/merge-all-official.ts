/**
 * Merge ALL 5146 scraped official cards into cards.json.
 *
 * Strategy:
 * 1. Reads cards.json (TCGdex + existing scr-* cards)
 * 2. Reads scraped-cards-all.json (5146 official cards with scr-* IDs)
 * 3. For each official card:
 *    - If its scr-* ID already exists in cards.json → UPDATE with new data
 *    - If its NAME already exists in cards.json → SKIP (already covered by TCGdex)
 *    - If neither → ADD as new card
 *
 * Run AFTER scrape-all-official-data.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_ALL = path.resolve(__dirname, '../../data/scraped-cards-all.json');

interface CacheWrapper {
  timestamp: number;
  data: MapCard[];
}

function main() {
  // ── Debug paths ──
  console.log('__dirname:', __dirname);
  console.log('CARDS_CACHE path:', CARDS_CACHE);
  console.log('CARDS_CACHE exists:', fs.existsSync(CARDS_CACHE));

  // ── Read both sources ──
  console.log('Reading cards.json (current cache)...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  const existingIds = new Set(cards.map(c => c.id));
  const existingNames = new Set(cards.map(c => c.name));

  console.log(`  Current cards: ${cards.length}`);
  console.log(`  Unique names: ${existingNames.size}`);

  console.log('\nReading scraped-cards-all.json (5146 official cards)...');
  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8'));
  const scraped = scrapedRaw.data as MapCard[];
  console.log(`  Official cards: ${scraped.length}`);

  // ── Merge ──
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const card of scraped) {
    if (existingIds.has(card.id)) {
      // Update existing scr-* card with new data
      const idx = cards.findIndex(c => c.id === card.id);
      if (idx !== -1) {
        cards[idx] = card;
        updated++;
      }
    } else if (!existingNames.has(card.name)) {
      // New card (name not in cards.json at all)
      if (!card.legalities) card.legalities = {};
      cards.push(card);
      existingNames.add(card.name);
      added++;
    } else {
      skipped++;
    }
  }

  // ── Save ──
  cacheRaw.timestamp = Date.now();
  const json = JSON.stringify(cacheRaw, null, 2);
  fs.writeFileSync(CARDS_CACHE, json, 'utf-8');

  console.log(`\n=== Merge Complete ===`);
  console.log(`  Updated (existing scr-*): ${updated}`);
  console.log(`  Added (new names): ${added}`);
  console.log(`  Skipped (name already in TCGdex): ${skipped}`);
  console.log(`  Total cards now: ${cards.length}`);
  console.log(`  Saved: ${(json.length / 1024 / 1024).toFixed(1)} MB`);

  // ── Stats ──
  const scrCards = cards.filter(c => c.id.startsWith('scr'));
  const megaCards = cards.filter(c => c.name.startsWith('超級') && c.supertype === 'Pokémon');
  const exCards = cards.filter(c => c.name.endsWith('ex') && !c.name.startsWith('超級'));
  console.log(`\n=== Card Stats ===`);
  console.log(`  scr-* cards: ${scrCards.length}`);
  console.log(`  MEGA (超級 Pokémon): ${megaCards.length}`);
  console.log(`  EX (endsWith ex, not 超級): ${exCards.length}`);
}

main();
