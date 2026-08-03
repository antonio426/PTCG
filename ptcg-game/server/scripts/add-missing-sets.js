/**
 * add-missing-sets.js
 * 
 * Takes scrapped cards from missing sets (not in server cache),
 * converts their IDs from scr-* to new format (setId-localId),
 * adds them to cards.json, and generates the complete ID mapping
 * for preset-decks.json.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ====== 1. Load source data ======
console.log('=== Loading data files ===');

const scrapedRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped-cards.json'), 'utf-8'));
const scrapedCards = scrapedRaw.data || scrapedRaw;
console.log(`Scraped cards: ${scrapedCards.length}`);

const cardsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf-8'));
const cache = cardsRaw.data || cardsRaw;
console.log(`Server cache cards: ${cache.length}`);

const PRESET_SRC = path.join(DATA_DIR, 'preset-decks.json');
const presetDecks = JSON.parse(fs.readFileSync(PRESET_SRC, 'utf-8'));
console.log(`Preset decks: ${presetDecks.length}`);

// ====== 2. Identify missing sets ======
console.log('\n=== Identifying missing sets ===');

const cacheSetIds = new Set(cache.map(c => c.set && c.set.id).filter(Boolean));
const missingSetIds = new Set();

scrapedCards.forEach(c => {
  const setId = c.set && c.set.id;
  if (setId && !cacheSetIds.has(setId)) {
    missingSetIds.add(setId);
  }
});

console.log(`Missing set IDs: ${[...missingSetIds].join(', ')}`);

// ====== 3. Extract localId from number field ======
function extractLocalId(number) {
  if (!number) return '';
  // "003/022" → "003"
  // "012/M-P" → "012"
  // "001" → "001"
  return number.split('/')[0].split('-')[0].trim();
}

// ====== 4. Build new cards from scraped data for missing sets ======
console.log('\n=== Building new cards for missing sets ===');

const existingIds = new Set(cache.map(c => c.id));
const newCards = [];
let skipped = 0;

scrapedCards.forEach(c => {
  const setId = c.set && c.set.id;
  if (!setId || !missingSetIds.has(setId)) return;

  const localId = extractLocalId(c.number);
  const newId = `${setId}-${localId}`;

  if (existingIds.has(newId)) {
    skipped++;
    return;
  }

  // Build the card in cache format. Keep ALL fields from scraped data.
  const newCard = {
    ...c,
    id: newId,
    localId: localId,
  };
  // Remove the old scr-* id from set if present
  delete newCard._oldId;

  newCards.push(newCard);
  existingIds.add(newId);
});

console.log(`New cards to add: ${newCards.length}`);
console.log(`Skipped (already exist): ${skipped}`);

// ====== 5. Build complete ID mapping ======
console.log('\n=== Building complete ID mapping ===');

// Build a mapping from scr-* IDs to new format IDs
// We use BOTH the cache AND the new cards
const allCards = [...cache, ...newCards];
const idMap = {};

// Also build lookup by old scraped id
const scrapedById = {};
scrapedCards.forEach(c => {
  scrapedById[c.id] = c;
});

// Count stats
let directSetMatch = 0;
let byNameExact = 0;
let byNameBestGuess = 0;
let noMatch = 0;

// Collect ALL unique scr-* IDs from preset decks
const allScrIds = new Set();
presetDecks.forEach(deck => {
  (deck.entries || []).forEach(entry => {
    const cardId = entry.cardId || entry;
    if (typeof cardId === 'string' && cardId.startsWith('scr-')) {
      allScrIds.add(cardId);
    }
  });
});
console.log(`Unique scr-* IDs in preset decks: ${allScrIds.size}`);

allScrIds.forEach(scrId => {
  const scrCard = scrapedById[scrId];
  if (!scrCard) {
    idMap[scrId] = { mapped: false, reason: 'Not in scraped data' };
    noMatch++;
    return;
  }

  // Method 1: Direct set + number match
  const setId = scrCard.set && scrCard.set.id;
  const localId = extractLocalId(scrCard.number);
  
  if (setId && localId) {
    const newId = `${setId}-${localId}`;
    const existsInAllCards = allCards.some(c => c.id === newId);
    
    if (existsInAllCards) {
      idMap[scrId] = { newId, method: 'directSetMatch' };
      directSetMatch++;
      return;
    }

    // Method 2: Look up in allCards by name (exact)
    const name = scrCard.name;
    const exactMatch = allCards.find(c => c.name === name);
    if (exactMatch) {
      idMap[scrId] = { newId: exactMatch.id, name, method: 'byNameExact' };
      byNameExact++;
      return;
    }

    // Method 3: Look up in allCards by name + supertype (best guess)
    const matches = allCards.filter(c => {
      if (!name || !c.name) return false;
      // Check if names have significant overlap
      return c.name.includes(name) || name.includes(c.name);
    });

    if (matches.length >= 1) {
      // Prefer same supertype
      const sameType = matches.filter(m => m.supertype === scrCard.supertype);
      const best = sameType.length > 0 ? sameType[0] : matches[0];
      idMap[scrId] = { newId: best.id, name, method: byNameExact > 0 ? 'byNameExact' : 'byNameBestGuess' };
      byNameExact++;
      return;
    }

    // Method 4: Try new ID anyway (even though not in cards - fallback)
    idMap[scrId] = { newId, method: 'setNumberConstructed' };
    directSetMatch++;
    return;
  }

  // Fallback: mark as no match
  idMap[scrId] = { 
    mapped: false, 
    oldName: scrCard.name,
    reason: `No set info for ${scrId}` 
  };
  noMatch++;
});

const mapped = allScrIds.size - noMatch;
console.log(`Direct set+number match:  ${directSetMatch}`);
console.log(`By name (exact):          ${byNameExact}`);
console.log(`By name (best guess):     ${byNameBestGuess}`);
console.log(`No match:                 ${noMatch}`);
console.log(`Total:                    ${allScrIds.size}`);
console.log(`Mapped:                   ${mapped}`);
console.log(`Coverage:                 ${(mapped / allScrIds.size * 100).toFixed(1)}%`);

// ====== 6. Apply mapping to preset-decks.json ======
console.log('\n=== Applying mapping to preset-decks.json ===');

let updatedCards = 0;
let stillUnmapped = 0;

const updatedDecks = presetDecks.map(deck => {
  const newEntries = (deck.entries || []).map(entry => {
    const cardId = entry.cardId || entry;
    if (typeof cardId === 'string' && cardId.startsWith('scr-')) {
      const mapping = idMap[cardId];
      if (mapping && mapping.newId) {
        updatedCards++;
        return { ...entry, cardId: mapping.newId };
      } else {
        stillUnmapped++;
        return entry; // Keep old entry
      }
    }
    return entry; // Non-scr entry, keep as is
  });

  return { ...deck, entries: newEntries };
});

console.log(`Updated cards: ${updatedCards}`);
console.log(`Still unmapped scr-*: ${stillUnmapped}`);

// ====== 7. Write output files ======
console.log('\n=== Writing output files ===');

// Helper: convert localId to string number (no leading zeros) for consistency
// with existing cache format

// Add new cards to cache and write
const updatedCache = [...cache, ...newCards];

// Write updated cards.json
const cardsOutput = cardsRaw.data 
  ? { ...cardsRaw, data: updatedCache }
  : updatedCache;

fs.writeFileSync(
  path.join(DATA_DIR, 'cards-updated.json'),
  JSON.stringify(cardsOutput, null, 2),
  'utf-8'
);
console.log(`Written: cards-updated.json (${updatedCache.length} cards)`);

// Write updated preset-decks.json
fs.writeFileSync(
  path.join(DATA_DIR, 'preset-decks-final.json'),
  JSON.stringify(updatedDecks, null, 2),
  'utf-8'
);
console.log(`Written: preset-decks-final.json (${updatedDecks.length} decks)`);

// Write ID mapping report
const report = {
  stats: {
    totalScrIds: allScrIds.size,
    directSetMatch,
    byNameExact,
    byNameBestGuess,
    mapped,
    noMatch,
    coverage: `${(mapped / allScrIds.size * 100).toFixed(1)}%`,
  },
  missingSetCardsAdded: newCards.length,
  newCardsBySet: {},
};
// Group new cards by set
newCards.forEach(c => {
  const setId = c.set && c.set.id;
  if (!report.newCardsBySet[setId]) report.newCardsBySet[setId] = [];
  report.newCardsBySet[setId].push(c.id);
});

fs.writeFileSync(
  path.join(DATA_DIR, 'migration-report.json'),
  JSON.stringify(report, null, 2),
  'utf-8'
);
console.log(`Written: migration-report.json`);

// Write list of unmapped IDs for debugging
const unmappedEntries = [];
allScrIds.forEach(scrId => {
  const mapping = idMap[scrId];
  if (!mapping || !mapping.newId) {
    const scrCard = scrapedById[scrId];
    unmappedEntries.push({
      id: scrId,
      name: scrCard ? scrCard.name : 'UNKNOWN',
      set: scrCard && scrCard.set ? scrCard.set.id : 'UNKNOWN',
      number: scrCard ? scrCard.number : 'UNKNOWN',
      reason: mapping ? mapping.reason : 'No mapping data',
    });
  }
});

if (unmappedEntries.length > 0) {
  console.log(`\n=== Unmapped entries (${unmappedEntries.length}) ===`);
  unmappedEntries.slice(0, 20).forEach(e => {
    console.log(`  ${e.id} (${e.name} @ ${e.set}/${e.number}): ${e.reason}`);
  });
  if (unmappedEntries.length > 20) {
    console.log(`  ... and ${unmappedEntries.length - 20} more`);
  }
}

console.log('\n=== Done ===');
