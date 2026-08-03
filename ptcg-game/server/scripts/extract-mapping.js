/**
 * Extract scr-* to SV*-* ID mapping from scraped-cards-all.json
 * 
 * The scraped data has entries like:
 *   { "id": "scr-14129", "set": { "id": "SV1V" }, "number": "054" }
 * 
 * We map: scr-14129 → SV1V-054
 */
const fs = require('fs');
const path = require('path');

const SCRAPED_FILE = path.resolve(__dirname, '../data/scraped-cards-all.json');
const PRESET_DECKS_FILE = path.resolve(__dirname, '../data/preset-decks.json');
const OUTPUT_MAPPING = path.resolve(__dirname, '../data/old-id-mapping.json');

console.log('=== Phase 1: Parse scraped-cards-all.json ===');
const raw = fs.readFileSync(SCRAPED_FILE, 'utf-8');
console.log(`File size: ${(raw.length / 1024 / 1024).toFixed(1)} MB`);

const parsed = JSON.parse(raw);
const cards = parsed.data || parsed.cards || parsed;
console.log(`Total entries: ${cards.length}`);
console.log(`Fields: ${Object.keys(parsed).join(', ')}`);

// Show first card structure
if (cards.length > 0) {
  console.log('\nFirst card sample:');
  console.log(JSON.stringify(cards[0], null, 2).slice(0, 500));
}

// Build mapping: scr-* → set.id-number (SV*-* format)
const mapping = {};
let mapped = 0;
let missingSetInfo = 0;

for (const card of cards) {
  const id = card.id;
  if (!id || !id.startsWith('scr-')) continue;
  
  const setId = card.set?.id;
  const number = card.number;
  
  if (setId && number) {
    // Some numbers might be numeric, ensure string
    const numStr = String(number).padStart(3, '0');
    const newId = `${setId}-${numStr}`;
    mapping[id] = {
      newId,
      name: card.name,
      setId,
      number: numStr,
    };
    mapped++;
  } else {
    missingSetInfo++;
    if (missingSetInfo <= 5) {
      console.log(`  Missing set info for ${id}: name=${card.name}, set=${JSON.stringify(card.set)}, number=${number}`);
    }
  }
}

console.log(`\nMapped: ${mapped} cards`);
console.log(`Missing set info: ${missingSetInfo} cards`);

// Show some examples
console.log('\n=== Sample mappings ===');
const examples = Object.entries(mapping).slice(0, 10);
for (const [oldId, info] of examples) {
  console.log(`  ${oldId} → ${info.newId} (${info.name})`);
}

// Save mapping
fs.writeFileSync(OUTPUT_MAPPING, JSON.stringify(mapping, null, 2), 'utf-8');
console.log(`\nSaved mapping to: ${OUTPUT_MAPPING}`);

// === Phase 2: Check which preset deck IDs are covered ===
console.log('\n=== Phase 2: Check preset-decks.json coverage ===');

const presetDecks = JSON.parse(fs.readFileSync(PRESET_DECKS_FILE, 'utf-8'));
const allScrIds = new Set();
for (const deck of presetDecks) {
  for (const entry of deck.entries) {
    if (entry.cardId.startsWith('scr-')) {
      allScrIds.add(entry.cardId);
    }
  }
}
console.log(`Unique scr-* IDs in preset-decks.json: ${allScrIds.size}`);

let covered = 0;
let uncovered = [];
for (const scrId of allScrIds) {
  if (mapping[scrId]) {
    covered++;
  } else {
    uncovered.push(scrId);
  }
}
console.log(`Covered by mapping: ${covered}/${allScrIds.size}`);
console.log(`Uncovered: ${uncovered.length}`);

if (uncovered.length > 0 && uncovered.length <= 20) {
  console.log('\nUncovered IDs:');
  for (const id of uncovered) {
    console.log(`  ${id}`);
  }
}

// === Phase 3: Generate updated preset-decks.json ===
console.log('\n=== Phase 3: Generate SV*-* format preset decks ===');

const updatedDecks = presetDecks.map(deck => ({
  ...deck,
  entries: deck.entries.map(entry => {
    if (entry.cardId.startsWith('scr-') && mapping[entry.cardId]) {
      return { ...entry, cardId: mapping[entry.cardId].newId };
    }
    return entry;  // keep unchanged if we can't map
  })
}));

// Write updated file
const OUTPUT_UPDATED = path.resolve(__dirname, '../data/preset-decks-updated.json');
fs.writeFileSync(OUTPUT_UPDATED, JSON.stringify(updatedDecks, null, 2), 'utf-8');
console.log(`Updated preset decks written to: ${OUTPUT_UPDATED}`);

// Count how many couldn't be updated
let unmappedCount = 0;
let totalEntries = 0;
for (const deck of updatedDecks) {
  for (const entry of deck.entries) {
    totalEntries++;
    if (entry.cardId.startsWith('scr-')) {
      unmappedCount++;
    }
  }
}
console.log(`\nTotal entries: ${totalEntries}`);
console.log(`Still using old IDs: ${unmappedCount}`);
console.log(`Success rate: ${((totalEntries - unmappedCount) / totalEntries * 100).toFixed(1)}%`);
