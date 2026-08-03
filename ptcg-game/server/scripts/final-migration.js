/**
 * final-migration.js
 *
 * Final migration that:
 * 1. Takes the 337 mappings from build-id-mapping.js
 * 2. Builds new IDs for the 115 unmapped from scraped data
 * 3. Adds any remaining missing cards to the cache
 * 4. Applies the complete mapping to preset-decks.json
 * 5. Writes the final updated files
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================
// 1. Load all data
// ============================================================
console.log('=== Loading data ===');

const report = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'id-mapping-report.json'), 'utf-8'));
console.log(`Existing mapping entries: ${Object.keys(report.mapping || {}).length}`);
console.log(`Unmapped entries: ${(report.unmapped || []).length}`);

const scrapedRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped-cards.json'), 'utf-8'));
const scraped = scrapedRaw.data || scrapedRaw;
const scrapedById = {};
scraped.forEach(c => { scrapedById[c.id] = c; });
console.log(`Scraped cards: ${scraped.length}`);

const cardsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf-8'));
const cache = cardsRaw.data || cardsRaw;
let cacheIds = new Set(cache.map(c => c.id));
console.log(`Server cache cards: ${cache.length}`);

const presetDecks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preset-decks.json'), 'utf-8'));
console.log(`Preset decks: ${presetDecks.length}`);

// ============================================================
// 2. Helper: extract localId from number field
// ============================================================
function extractLocalId(number) {
  if (!number) return '';
  return String(number).split('/')[0].split('-')[0].trim();
}

// ============================================================
// 3. Collect all unique scr-* IDs from preset decks
// ============================================================
console.log('\n=== Collecting preset deck sr-* IDs ===');

const allScrIds = new Map(); // scrId -> { count, occurrences }
presetDecks.forEach(deck => {
  (deck.entries || []).forEach(entry => {
    if (entry.cardId && entry.cardId.startsWith('scr-')) {
      const existing = allScrIds.get(entry.cardId) || { count: 0, decks: new Set() };
      existing.count += entry.count || 1;
      existing.decks.add(deck.id || deck.name);
      allScrIds.set(entry.cardId, existing);
    }
  });
});
console.log(`Unique scr-* IDs: ${allScrIds.size}`);

// ============================================================
// 4. Build complete ID mapping
// ============================================================
console.log('\n=== Building complete ID mapping ===');

const existingMapping = report.mapping || {};
const unmappedList = report.unmapped || [];
const finalMapping = {};

let fromExisting = 0;
let fromScraped = 0;
let stillUnmapped = 0;

// 4a. Copy existing mappings
for (const [scrId, info] of Object.entries(existingMapping)) {
  if (info.newId) {
    finalMapping[scrId] = info.newId;
    fromExisting++;
  }
}
console.log(`From existing mapping: ${fromExisting}`);

// 4b. Build new IDs for unmapped from scraped data
const addedCards = []; // track cards we need to add to cache
for (const item of unmappedList) {
  const scrId = item.id || item;
  const card = scrapedById[scrId];
  if (!card) {
    stillUnmapped++;
    console.warn(`  WARN: ${scrId} not in scraped data`);
    continue;
  }

  const setId = card.set && card.set.id;
  const localId = extractLocalId(card.number);
  if (!setId || !localId) {
    stillUnmapped++;
    console.warn(`  WARN: ${scrId} (${card.name}) has no set/number`);
    continue;
  }

  const newId = `${setId}-${localId}`;

  // If this card isn't in cache, add it
  if (!cacheIds.has(newId)) {
    const newCard = {
      ...card,
      id: newId,
      localId,
    };
    addedCards.push(newCard);
    cacheIds.add(newId);
  }

  finalMapping[scrId] = newId;
  fromScraped++;
}

console.log(`From scraped mapping: ${fromScraped}`);
console.log(`Still unmapped: ${stillUnmapped}`);
console.log(`Cards to add to cache: ${addedCards.length}`);
console.log(`Total mapped: ${fromExisting + fromScraped}`);

// ============================================================
// 5. Add new cards to cache
// ============================================================
console.log('\n=== Adding new cards to cache ===');

const fullCache = [...cache, ...addedCards];
console.log(`Cache size: ${cache.length} -> ${fullCache.length}`);

// ============================================================
// 6. Apply mapping to preset-decks.json
// ============================================================
console.log('\n=== Applying mapping to preset-decks.json ===');

let updatedCount = 0;
let unmappedCount = 0;
let scrEntriesCount = 0;

const updatedDecks = presetDecks.map(deck => {
  const newEntries = (deck.entries || []).map(entry => {
    if (entry.cardId && entry.cardId.startsWith('scr-')) {
      scrEntriesCount++;
      const newId = finalMapping[entry.cardId];
      if (newId) {
        updatedCount++;
        return { ...entry, cardId: newId };
      } else {
        unmappedCount++;
        return entry;
      }
    }
    return entry;
  });
  return { ...deck, entries: newEntries };
});

console.log(`Total scr-* entries: ${scrEntriesCount}`);
console.log(`Updated: ${updatedCount}`);
console.log(`Still unmapped: ${unmappedCount}`);

// ============================================================
// 7. Write output
// ============================================================
console.log('\n=== Writing output ===');

// Write final cards.json
const cardsOutput = cardsRaw.data
  ? { ...cardsRaw, data: fullCache }
  : fullCache;
fs.writeFileSync(path.join(DATA_DIR, 'cards-final.json'), JSON.stringify(cardsOutput, null, 2), 'utf-8');

// Write final preset-decks.json
fs.writeFileSync(path.join(DATA_DIR, 'preset-decks-final.json'), JSON.stringify(updatedDecks, null, 2), 'utf-8');

// Write migration summary
fs.writeFileSync(path.join(DATA_DIR, 'migration-summary.json'), JSON.stringify({
  stats: {
    totalScrIds: allScrIds.size,
    fromExistingMapping: fromExisting,
    fromScrapedMapping: fromScraped,
    totalMapped: fromExisting + fromScraped,
    coverage: `${((fromExisting + fromScraped) / allScrIds.size * 100).toFixed(1)}%`,
    stillUnmapped,
    cardsAddedToCache: addedCards.length,
    cacheSize: fullCache.length,
    entriesUpdated: updatedCount,
    entriesUnmapped: unmappedCount,
  },
  addedCards: addedCards.map(c => ({
    id: c.id,
    name: c.name,
    supertype: c.supertype,
    set: c.set?.id,
    number: c.number,
  })),
}, null, 2), 'utf-8');

console.log('Written: cards-final.json');
console.log('Written: preset-decks-final.json');
console.log('Written: migration-summary.json');

if (unmappedCount > 0) {
  console.log(`\n⚠️  ${unmappedCount} entries still have old scr-* IDs!`);
} else {
  console.log('\n✅ All scr-* entries have been migrated!');
}

console.log('\n=== Done ===');
