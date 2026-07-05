/**
 * Import official Taiwan standard card data to fix standard legality in TCGdex cache.
 *
 * 1. Reads official-standard-cards.json (scraped from asia.pokemon-card.com/tw)
 * 2. Reads cards.json (TCGdex zh-tw cache)
 * 3. Cross-references by name — any TCGdex card whose Chinese name appears in the
 *    official standard list is marked standard = 'Legal'
 * 4. Any TCGdex card NOT in the official list → standard mark removed
 * 5. Saves updated cards.json for the server to pick up
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const OFFICIAL_DATA = path.resolve(__dirname, '../../../data-scraped/official-standard-cards.json');
const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');

interface OfficialCard {
  id: number;
  name: string;
  regulation: string;
  expansionCode: string;
  cardNumber: string;
}

interface OfficialData {
  cards: OfficialCard[];
}

function main() {
  // ── Read official data ──
  console.log('Reading official standard card data...');
  const rawOfficial = JSON.parse(fs.readFileSync(OFFICIAL_DATA, 'utf-8')) as OfficialData;
  const officialCards = rawOfficial.cards;

  // Build the set of all standard-legal card names (unique)
  const standardNames = new Set<string>();
  for (const card of officialCards) {
    if (card.name) standardNames.add(card.name);
  }

  console.log(`Official standard cards: ${officialCards.length}`);
  console.log(`Unique standard card names: ${standardNames.size}`);

  // ── Read TCGdex cache ──
  console.log('\nReading TCGdex cards.json...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8'));
  const cards = cacheRaw.data as MapCard[];

  console.log(`TCGdex cards in cache: ${cards.length}`);

  // ── Cross-reference ──
  let markedStandard = 0;
  let unmarkedNonStandard = 0;
  let alreadyStandard = 0;
  let alreadyNonStandard = 0;

  for (const card of cards) {
    const isInOfficialList = standardNames.has(card.name);
    const isCurrentlyStandard = card.legalities?.standard === 'Legal';

    if (isInOfficialList && !isCurrentlyStandard) {
      // This card should be standard but isn't — fix it
      if (!card.legalities) card.legalities = {};
      card.legalities.standard = 'Legal';
      markedStandard++;
    } else if (!isInOfficialList && isCurrentlyStandard) {
      // This card is marked standard but shouldn't be — remove it
      if (card.legalities) {
        delete card.legalities.standard;
      }
      unmarkedNonStandard++;
    } else if (isInOfficialList && isCurrentlyStandard) {
      alreadyStandard++;
    } else {
      alreadyNonStandard++;
    }
  }

  // ── Report ──
  console.log(`\n=== Cross-Reference Results ===`);
  console.log(`Newly marked as standard:     ${markedStandard}`);
  console.log(`Unmarked (removed standard):  ${unmarkedNonStandard}`);
  console.log(`Already correctly standard:   ${alreadyStandard}`);
  console.log(`Already correctly non-std:    ${alreadyNonStandard}`);
  console.log(`\nTotal standard-legal now:     ${alreadyStandard + markedStandard}`);
  console.log(`Total non-standard now:       ${alreadyNonStandard + unmarkedNonStandard}`);
  console.log(`Total cards:                  ${cards.length}`);

  // ── Save updated cache ──
  if (markedStandard > 0 || unmarkedNonStandard > 0) {
    cacheRaw.data = cards;
    cacheRaw.timestamp = Date.now();

    // Write with UTF-8 and proper encoding for Chinese characters
    const json = JSON.stringify(cacheRaw, null, 2);
    fs.writeFileSync(CARDS_CACHE, json, 'utf-8');
    console.log(`\nUpdated cards.json saved (${(json.length / 1024).toFixed(0)} KB)`);
  } else {
    console.log('\nNo changes needed — all cards correctly classified.');
  }
}

main();
