/**
 * Build ID mapping from old scr-* format to new SV*-* / S*-* format
 *
 * Strategy:
 * 1. Load scraped-cards-all.json (5146 cards with scr-* IDs + Chinese names + metadata)
 * 2. Load cards.json (7436 cards with new-format IDs + names)
 * 3. For each scr-* ID in preset-decks.json:
 *    a. Find in scraped data → get name, supertype, subtypes, regulationMark, set info
 *    b. Find ALL cards with same name in server cache
 *    c. Disambiguate: supertype > subtypes > regulationMark > HP > attacks text
 *    d. If unique match → record mapping
 *    e. If no match → flag as unmappable
 * 4. Generate updated preset-decks.json
 * 5. Output mapping report
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');

// Load files
console.log('=== Loading data files ===');
const scrapedRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped-cards-all.json'), 'utf-8'));
const scrapedCards = scrapedRaw.data || scrapedRaw.cards || scrapedRaw;
console.log(`Scraped cards: ${scrapedCards.length}`);

const cacheRaw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards.json'), 'utf-8'));
const cacheCards = cacheRaw.data || cacheRaw.cards || cacheRaw;
console.log(`Server cache cards: ${cacheCards.length}`);

const presetDecks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preset-decks.json'), 'utf-8'));
console.log(`Preset decks: ${presetDecks.length}`);

// Build name index for server cache
// Key: lowercase name. Value: array of cards with that name
console.log('\n=== Building name index ===');
const cacheByName = {};
for (const c of cacheCards) {
  if (!c.name) continue;
  const key = c.name.toLowerCase().trim();
  if (!cacheByName[key]) cacheByName[key] = [];
  cacheByName[key].push(c);
}
console.log(`Unique names in cache: ${Object.keys(cacheByName).length}`);

// Collect all unique scr-* IDs from preset decks
console.log('\n=== Analyzing preset deck IDs ===');
const scrIds = new Set();
const presetDeckEntries = [];
for (const deck of presetDecks) {
  for (const entry of deck.entries) {
    if (entry.cardId.startsWith('scr-')) {
      scrIds.add(entry.cardId);
      presetDeckEntries.push({ deckId: deck.id, deckName: deck.name, cardId: entry.cardId, count: entry.count });
    }
  }
}
console.log(`Unique scr-* IDs: ${scrIds.size}`);
console.log(`Total entries (including duplicates across decks): ${presetDeckEntries.length}`);

// Build scraped lookup by ID
const scrapedById = {};
for (const c of scrapedCards) {
  scrapedById[c.id] = c;
}

// Build mapping: scr-* → newId (with confidence level)
console.log('\n=== Building ID mapping ===');
const mapping = {};     // scr-* → { newId, name, method, confidence }
const unmapped = [];    // scr-* IDs that couldn't be mapped
const stats = { directSetMatch: 0, byNameExact: 0, byNameSupertype: 0, byNameRegMark: 0, byNameSubtype: 0, byNameBestGuess: 0, noMatch: 0 };

for (const scrId of scrIds) {
  const scraped = scrapedById[scrId];
  if (!scraped) {
    unmapped.push({ id: scrId, reason: 'not in scraped data' });
    stats.noMatch++;
    continue;
  }

  const name = scraped.name;
  if (!name) {
    unmapped.push({ id: scrId, reason: 'no name in scraped data' });
    stats.noMatch++;
    continue;
  }

  const nameKey = name.toLowerCase().trim();
  const matches = cacheByName[nameKey];

  if (!matches || matches.length === 0) {
    // Try direct set+number match first (from scraped data)
    const setId = scraped.set?.id;
    const number = scraped.number;
    if (setId && number) {
      const localId = number.split('/')[0].padStart(3, '0');
      const constructedId = `${setId}-${localId}`;
      const directMatch = cacheCards.find(c => c.id === constructedId);
      if (directMatch) {
        mapping[scrId] = { newId: constructedId, name, method: 'directSetMatch' };
        stats.directSetMatch++;
        continue;
      }
    }

    unmapped.push({ id: scrId, name, reason: `no cards named "${name}" in server cache` });
    stats.noMatch++;
    continue;
  }

  if (matches.length === 1) {
    mapping[scrId] = { newId: matches[0].id, name, method: 'byNameExact' };
    stats.byNameExact++;
    continue;
  }

  // Multiple matches - disambiguate
  const supertype = scraped.supertype;
  const subtypes = scraped.subtypes || [];
  const regulationMark = scraped.regulationMark;

  // Strategy 1: Match by supertype
  if (supertype) {
    const stFiltered = matches.filter(m => m.supertype === supertype);
    if (stFiltered.length === 1) {
      mapping[scrId] = { newId: stFiltered[0].id, name, method: 'byNameSupertype' };
      stats.byNameSupertype++;
      continue;
    }
    if (stFiltered.length > 1) {
      // Strategy 2: Match by supertype + regulationMark
      if (regulationMark) {
        const rmFiltered = stFiltered.filter(m => m.regulationMark === regulationMark);
        if (rmFiltered.length === 1) {
          mapping[scrId] = { newId: rmFiltered[0].id, name, method: 'byNameRegMark' };
          stats.byNameRegMark++;
          continue;
        }
        if (rmFiltered.length > 0 && rmFiltered.length < stFiltered.length) {
          // Multiple with same reg mark - try subtypes
          if (subtypes.length > 0) {
            const subFiltered = rmFiltered.filter(m => {
              const mSubs = (m.subtypes || []).map(s => s.toLowerCase()).sort().join(',');
              const sSubs = subtypes.map(s => s.toLowerCase()).sort().join(',');
              return mSubs === sSubs;
            });
            if (subFiltered.length === 1) {
              mapping[scrId] = { newId: subFiltered[0].id, name, method: 'byNameSubtype' };
              stats.byNameSubtype++;
              continue;
            }
          }
          // Pick first from regulation match
          mapping[scrId] = { newId: rmFiltered[0].id, name, method: 'byNameRegMark(first)' };
          stats.byNameBestGuess++;
          continue;
        }
      }
      // Strategy 3: Match by supertype + subtypes
      if (subtypes.length > 0) {
        const subFiltered = stFiltered.filter(m => {
          const mSubs = (m.subtypes || []).map(s => s.toLowerCase()).sort().join(',');
          const sSubs = subtypes.map(s => s.toLowerCase()).sort().join(',');
          return mSubs === sSubs;
        });
        if (subFiltered.length === 1) {
          mapping[scrId] = { newId: subFiltered[0].id, name, method: 'byNameSubtype' };
          stats.byNameSubtype++;
          continue;
        }
        if (subFiltered.length > 0) {
          mapping[scrId] = { newId: subFiltered[0].id, name, method: 'byNameSubtype(first)' };
          stats.byNameBestGuess++;
          continue;
        }
      }
      // Last resort: pick first
      mapping[scrId] = { newId: stFiltered[0].id, name, method: 'byNameSupertype(first)' };
      stats.byNameBestGuess++;
      continue;
    }
    // Fall through: supertype filter gave 0 results
  }

  // Strategy 4: Just pick first match
  mapping[scrId] = { newId: matches[0].id, name, method: 'byName(first)' };
  stats.byNameBestGuess++;
}

// Print stats
console.log('\n=== Mapping Statistics ===');
console.log(`Direct set+number match:     ${stats.directSetMatch}`);
console.log(`By name (exact, unique):     ${stats.byNameExact}`);
console.log(`By name + supertype:         ${stats.byNameSupertype}`);
console.log(`By name + regulation mark:   ${stats.byNameRegMark}`);
console.log(`By name + subtype:           ${stats.byNameSubtype}`);
console.log(`By name (best guess):        ${stats.byNameBestGuess}`);
console.log(`No match:                    ${stats.noMatch}`);
console.log(`Total:                       ${Object.keys(mapping).length + unmapped.length}`);
console.log(`Mapped:                      ${Object.keys(mapping).length}`);
console.log(`Coverage:                    ${(Object.keys(mapping).length / (Object.keys(mapping).length + unmapped.length) * 100).toFixed(1)}%`);

// Print unmapped examples
console.log('\n=== Unmapped examples (first 20) ===');
for (const u of unmapped.slice(0, 20)) {
  console.log(`  ${u.id} (${u.name || 'N/A'}): ${u.reason}`);
}

// Generate updated preset-decks.json
console.log('\n=== Generating updated preset-decks.json ===');
let updatedCount = 0;
let unchangedCount = 0;
let stillUnmappedCount = 0;

const updatedDecks = presetDecks.map(deck => {
  const newEntries = deck.entries.map(entry => {
    if (entry.cardId.startsWith('scr-')) {
      const mapped = mapping[entry.cardId];
      if (mapped) {
        updatedCount += entry.count;
        return { ...entry, cardId: mapped.newId };
      } else {
        stillUnmappedCount += entry.count;
        return entry; // keep old ID
      }
    } else {
      unchangedCount += entry.count;
      return entry; // not scr-*, leave as-is
    }
  });
  return { ...deck, entries: newEntries };
});

console.log(`Updated cards: ${updatedCount}`);
console.log(`Unchanged (non-scr): ${unchangedCount}`);
console.log(`Still unmapped scr-*: ${stillUnmappedCount}`);

// Count decks that still have old IDs
const decksWithOldIds = [];
for (const deck of updatedDecks) {
  const oldIdEntries = deck.entries.filter(e => e.cardId.startsWith('scr-'));
  if (oldIdEntries.length > 0) {
    decksWithOldIds.push({ name: deck.name, count: oldIdEntries.length });
  }
}
console.log(`\nDecks still with old IDs: ${decksWithOldIds.length}`);
for (const d of decksWithOldIds.slice(0, 10)) {
  console.log(`  ${d.name}: ${d.count} old IDs`);
}

// Write updated file
const outputPath = path.join(DATA_DIR, 'preset-decks-updated.json');
fs.writeFileSync(outputPath, JSON.stringify(updatedDecks, null, 2), 'utf-8');
console.log(`\nUpdated file written to: ${outputPath}`);

// Write mapping report
const reportPath = path.join(DATA_DIR, 'id-mapping-report.json');
fs.writeFileSync(reportPath, JSON.stringify({ mapping, unmapped, stats }, null, 2), 'utf-8');
console.log(`Mapping report written to: ${reportPath}`);
