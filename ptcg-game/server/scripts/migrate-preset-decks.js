/**
 * migrate-preset-decks.js
 *
 * Complete migration script:
 * 1. Add scraped cards from missing sets to the card cache
 * 2. Build complete scr-* → newID mapping via direct match + name match
 * 3. Apply mapping to preset-decks.json
 * 4. Write updated cards.json (+ new cards) and preset-decks.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ============================================================
// 1. Load data
// ============================================================
console.log('=== Loading data ===');

const scrapedRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped-cards.json'), 'utf-8'));
const scrapedCards = scrapedRaw.data || scrapedRaw;
console.log(`Scraped cards: ${scrapedCards.length}`);

const cardsRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf-8'));
const cache = cardsRaw.data || cardsRaw;
console.log(`Server cache cards: ${cache.length}`);

const presetDecks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preset-decks.json'), 'utf-8'));
console.log(`Preset decks: ${presetDecks.length}`);

// ============================================================
// 2. Extract localId from number field
// ============================================================
function extractLocalId(number) {
  if (!number) return '';
  // "003/022" → "003", "012/M-P" → "012"
  return String(number).split('/')[0].split('-')[0].trim();
}

// ============================================================
// 3. Add missing-set cards to cache
// ============================================================
console.log('\n=== Adding missing-set cards to cache ===');

const cacheSetIds = new Set(cache.map(c => c.set && c.set.id).filter(Boolean));
const cacheIds = new Set(cache.map(c => c.id));
const newCards = [];

scrapedCards.forEach(c => {
  const setId = c.set && c.set.id;
  if (!setId || cacheSetIds.has(setId)) return;

  const localId = extractLocalId(c.number);
  const newId = `${setId}-${localId}`;
  if (cacheIds.has(newId)) return;

  const newCard = { ...c, id: newId, localId };
  delete newCard._oldId;
  newCards.push(newCard);
  cacheIds.add(newId);
});

console.log(`New cards added: ${newCards.length}`);
const fullCache = [...cache, ...newCards];
console.log(`Full cache size: ${fullCache.length}`);

// ============================================================
// 4. Normalize card name for better matching
// ============================================================
function normalizeName(name) {
  if (!name) return '';
  return name
    .replace(/[<>（）()]/g, '')     // Remove brackets
    .replace(/[　\s]+/g, ' ')        // Normalize whitespace
    .trim()
    .toLowerCase();
}

function getNameSimilarity(a, b) {
  if (!a || !b) return 0;
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.8;
  // Check character overlap
  const aChars = new Set(normA);
  const bChars = new Set(normB);
  if (aChars.size === 0 || bChars.size === 0) return 0;
  const intersection = new Set([...aChars].filter(x => bChars.has(x)));
  return intersection.size / Math.min(aChars.size, bChars.size);
}

// ============================================================
// 5. Collect all unique scr-* IDs from preset decks
// ============================================================
console.log('\n=== Collecting scr-* IDs from preset decks ===');

const allIds = new Set();
presetDecks.forEach(deck => {
  (deck.entries || []).forEach(entry => {
    if (entry.cardId && entry.cardId.startsWith('scr-')) {
      allIds.add(entry.cardId);
    }
  });
});
console.log(`Unique scr-* IDs: ${allIds.size}`);

// Build scraped lookup
const scrapedById = {};
scrapedCards.forEach(c => {
  scrapedById[c.id] = c;
});

// ============================================================
// 6. Build ID mapping (priority: direct > name-exact > name-fuzzy)
// ============================================================
console.log('\n=== Building ID mapping ===');

const idMap = {};
const stats = { directSetNumber: 0, byNameExact: 0, byNameFuzzy: 0, noMatch: 0, noScrapedData: 0 };

for (const scrId of allIds) {
  const scrCard = scrapedById[scrId];

  if (!scrCard) {
    stats.noScrapedData++;
    // Still try name match against cache
    const noNameMatch = fullCache.find(c => normalizeName(c.name) === normalizeName(scrId));
    if (noNameMatch) {
      idMap[scrId] = { newId: noNameMatch.id, method: 'nameFallback' };
      stats.byNameFuzzy++;
    } else {
      idMap[scrId] = { unmapped: true, reason: 'not in scraped data' };
      stats.noMatch++;
    }
    continue;
  }

  // Method 1: Direct set + number
  const setId = scrCard.set && scrCard.set.id;
  const localId = extractLocalId(scrCard.number);
  if (setId && localId) {
    const newId = `${setId}-${localId}`;
    if (cacheIds.has(newId)) {
      idMap[scrId] = { newId, method: 'directSetNumber' };
      stats.directSetNumber++;
      continue;
    }
  }

  // Method 2: Name exact match in fullCache
  const name = scrCard.name;
  const exactMatch = fullCache.find(c => c.name === name);
  if (exactMatch) {
    idMap[scrId] = { newId: exactMatch.id, method: 'byNameExact' };
    stats.byNameExact++;
    continue;
  }

  // Method 3: Name fuzzy match - prefer same supertype
  const normName = normalizeName(name);
  const allMatches = fullCache
    .map(c => ({
      card: c,
      similarity: getNameSimilarity(name, c.name),
    }))
    .filter(m => m.similarity >= 0.7)
    .sort((a, b) => b.similarity - a.similarity);

  if (allMatches.length > 0) {
    // Prefer same supertype
    const sameType = allMatches.filter(m => m.card.supertype === scrCard.supertype);
    const best = sameType.length > 0 ? sameType[0] : allMatches[0];
    idMap[scrId] = { newId: best.card.id, name, method: 'byNameFuzzy' };
    stats.byNameFuzzy++;
    continue;
  }

  // Method 4: Construct new ID anyway even if not in cache (for missing sets we just added)
  if (setId && localId) {
    idMap[scrId] = { newId: `${setId}-${localId}`, method: 'constructed' };
    stats.directSetNumber++;
    continue;
  }

  idMap[scrId] = { unmapped: true, name, reason: 'no match found' };
  stats.noMatch++;
}

console.log(`Direct set+number: ${stats.directSetNumber}`);
console.log(`By name (exact):   ${stats.byNameExact}`);
console.log(`By name (fuzzy):   ${stats.byNameFuzzy}`);
console.log(`No scraped data:  ${stats.noScrapedData}`);
console.log(`No match:         ${stats.noMatch}`);
console.log(`Total:            ${allIds.size}`);
const mapped = stats.directSetNumber + stats.byNameExact + stats.byNameFuzzy;
console.log(`\nMapped: ${mapped}/${allIds.size} (${(mapped/allIds.size*100).toFixed(1)}%)`);

// ============================================================
// 7. Apply mapping to preset-decks.json
// ============================================================
console.log('\n=== Applying mapping ===');

let updatedCount = 0;
let unmappedCount = 0;

const updatedDecks = presetDecks.map(deck => {
  const newEntries = (deck.entries || []).map(entry => {
    const cardId = entry.cardId || entry;
    if (typeof cardId === 'string' && cardId.startsWith('scr-')) {
      const mapping = idMap[cardId];
      if (mapping && mapping.newId && !mapping.unmapped) {
        updatedCount++;
        return { ...entry, cardId: mapping.newId };
      } else {
        unmappedCount++;
        return entry; // Keep old entry
      }
    }
    return entry;
  });
  return { ...deck, entries: newEntries };
});

console.log(`Updated entries: ${updatedCount}`);
console.log(`Still unmapped:  ${unmappedCount}`);

const totalEntries = updatedDecks.reduce((sum, d) => sum + (d.entries || []).length, 0);
console.log(`Total entries:   ${totalEntries}`);

// ============================================================
// 8. Write output files
// ============================================================
console.log('\n=== Writing output ===');

// Write updated cards.json
const cardsOutput = cardsRaw.data
  ? { ...cardsRaw, data: fullCache }
  : fullCache;
fs.writeFileSync(path.join(DATA_DIR, 'cards-updated.json'), JSON.stringify(cardsOutput, null, 2), 'utf-8');

// Write updated preset-decks.json
fs.writeFileSync(path.join(DATA_DIR, 'preset-decks-final.json'), JSON.stringify(updatedDecks, null, 2), 'utf-8');

// Write mapping lookup for debugging
const mappingSummary = {};
for (const [scrId, info] of Object.entries(idMap)) {
  if (info.unmapped) {
    mappingSummary[scrId] = info;
  }
}
fs.writeFileSync(path.join(DATA_DIR, 'migration-final-report.json'), JSON.stringify({
  stats: {
    totalScrIds: allIds.size,
    mapped,
    unmapped: allIds.size - mapped,
    coverage: `${(mapped/allIds.size*100).toFixed(1)}%`,
    methods: stats,
    newCardsAdded: newCards.length,
  },
  newCardsBySet: Object.fromEntries(
    Array.from(new Set(newCards.map(c => c.set?.id))).map(sid => [
      sid,
      newCards.filter(c => c.set?.id === sid).length
    ])
  ),
  unmapped: mappingSummary,
}, null, 2), 'utf-8');

console.log('Written: cards-updated.json');
console.log('Written: preset-decks-final.json');
console.log('Written: migration-final-report.json');

// Show unmapped if any
const unmappedList = Object.entries(idMap).filter(([, v]) => v.unmapped);
if (unmappedList.length > 0) {
  console.log(`\n=== Unmapped (${unmappedList.length}) ===`);
  unmappedList.slice(0, 20).forEach(([id, info]) => {
    const card = scrapedById[id];
    const name = card ? card.name : 'N/A';
    const setId = card && card.set ? card.set.id : 'N/A';
    console.log(`  ${id} (${name} @ ${setId}): ${info.reason}`);
  });
  if (unmappedList.length > 20) {
    console.log(`  ... and ${unmappedList.length - 20} more`);
  }
}

console.log('\n=== Done ===');
