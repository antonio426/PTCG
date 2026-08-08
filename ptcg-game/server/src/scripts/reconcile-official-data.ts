/**
 * Reconcile server/data/cards.json against the official asia.pokemon-card.com
 * Standard-format card list (server/data/scraped-cards-all.json, produced by
 * scrape-all-official-data.ts) plus the rarity map
 * (data-scraped/official-rarity-map.json, produced by scrape-official-rarity.ts).
 *
 * For every officially-scraped Standard card:
 *  - If it matches an existing TCGdex-sourced card (by set code + card number,
 *    case-insensitive; falls back to exact name match ONLY when that name is
 *    unambiguous, i.e. exactly one TCGdex card has it) -> patch that card's
 *    `rarity` (official short code) and `legalities.standard` = 'Legal'
 *    (ground truth: it came from the official Standard-format search).
 *  - If it has no TCGdex match -> insert it as a new scr-* card so the browser
 *    can show it at all.
 *
 * IMPORTANT: many card names (item/supporter reprints like "高級球", basic
 * energy) are shared by dozens of TCGdex entries spanning a decade of sets —
 * matching those by name alone and marking every candidate standard-legal
 * would wrongly legalize long-rotated-out reprints. So `legalities.standard`
 * is first reset to a clean baseline (regulationMark in G/H/I/J — the
 * official rule, see server/src/card-api/tcgdex.ts) before any official-scrape
 * overrides are layered on, and ambiguous name matches are skipped entirely
 * rather than applied to every same-named candidate.
 *
 * TCGdex cards currently flagged standard-legal that find NO official match
 * are left alone but counted/logged — see printed summary — rather than
 * auto-demoted, since a join-key miss is more likely than the card being
 * genuinely illegal (our regulationMark-based check already gates this).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_ALL = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const RARITY_MAP_FILE = path.resolve(__dirname, '../../../data-scraped/official-rarity-map.json');

// Official Standard-format regulation marks — kept in sync with
// server/src/card-api/tcgdex.ts's STANDARD_REGULATION_MARKS. G is deliberately
// excluded here too (see that file's comment) — the small named exception list
// of G-marked reprints is instead confirmed via the official-scrape key match below.
const STANDARD_REGULATION_MARKS = new Set(['H', 'I', 'J']);

interface CacheWrapper {
  timestamp: number;
  data: MapCard[];
}

/** Parse the numerator out of an official card number like "001/076" -> 1 */
function parseNumerator(num: string): number | null {
  const m = num.match(/^0*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse a TCGdex card number (may be plain "001" or contain letters) -> numeric part */
function parseTcgdexNumber(num: string): number | null {
  const m = num.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function key(setId: string, num: number | null): string | null {
  if (num === null || !setId) return null;
  return `${setId.toLowerCase()}-${num}`;
}

function main() {
  console.log('Reading cards.json...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  console.log(`  TCGdex cards: ${cards.length}`);

  console.log('Reading scraped-cards-all.json (official)...');
  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8'));
  const officialCards = scrapedRaw.data as MapCard[];
  console.log(`  Official standard cards: ${officialCards.length}`);

  console.log('Reading official-rarity-map.json...');
  const rarityMap: Record<string, string> = JSON.parse(fs.readFileSync(RARITY_MAP_FILE, 'utf-8'));
  console.log(`  Rarity entries: ${Object.keys(rarityMap).length}`);

  // ── Reset standard-legality to the clean regulationMark-based baseline
  // before layering official-scrape overrides on top. This undoes any prior
  // over-broad name-match grants from earlier runs of this script. ──
  let resetCount = 0;
  for (const c of cards) {
    if (c.id.startsWith('scr-')) continue;
    const shouldBeBaseline = !!c.regulationMark && STANDARD_REGULATION_MARKS.has(c.regulationMark);
    const wasLegal = c.legalities?.standard === 'Legal';
    if (shouldBeBaseline && !wasLegal) {
      c.legalities = { ...c.legalities, standard: 'Legal' };
      resetCount++;
    } else if (!shouldBeBaseline && wasLegal) {
      c.legalities = { ...c.legalities };
      delete c.legalities.standard;
      resetCount++;
    }
  }
  console.log(`  Reset to regulationMark baseline: ${resetCount} cards changed`);

  // ── Build lookup of TCGdex cards by set+number key ──
  const tcgdexByKey = new Map<string, MapCard[]>();
  const tcgdexByName = new Map<string, MapCard[]>();
  for (const c of cards) {
    const num = parseTcgdexNumber(c.number || '');
    const k = key(c.set?.id || '', num);
    if (k) {
      if (!tcgdexByKey.has(k)) tcgdexByKey.set(k, []);
      tcgdexByKey.get(k)!.push(c);
    }
    if (!tcgdexByName.has(c.name)) tcgdexByName.set(c.name, []);
    tcgdexByName.get(c.name)!.push(c);
  }

  const matchedTcgdexIds = new Set<string>();
  let patchedRarity = 0;
  let patchedStandard = 0;
  let supertypeFixed = 0;
  let addedNew = 0;
  let matchedByKey = 0;
  let matchedByName = 0;
  let unmatched = 0;
  let ambiguousSkipped = 0;
  const unmatchedSamples: string[] = [];
  const ambiguousSamples: string[] = [];

  for (const oc of officialCards) {
    const scrId = oc.id.replace(/^scr-/, '');
    const rarity = rarityMap[scrId];
    const num = parseNumerator(oc.number || '');
    const k = key(oc.set?.id || '', num);

    let targets: MapCard[] | undefined = k ? tcgdexByKey.get(k) : undefined;
    let matchType: 'key' | 'name' | null = targets && targets.length > 0 ? 'key' : null;
    if (!targets || targets.length === 0) {
      const nameCandidates = tcgdexByName.get(oc.name);
      // Only trust a name match when it's unambiguous — many item/supporter/
      // energy names are shared by dozens of reprints across a decade of
      // sets, and applying "standard legal" to every same-named candidate
      // would wrongly legalize long-rotated-out prints (see file header).
      if (nameCandidates && nameCandidates.length === 1) {
        targets = nameCandidates;
        matchType = 'name';
      } else {
        targets = undefined;
      }
    }

    if (targets && targets.length > 0 && matchType) {
      for (const t of targets) {
        matchedTcgdexIds.add(t.id);
        if (rarity && t.rarity !== rarity) { t.rarity = rarity; patchedRarity++; }
        if (t.legalities?.standard !== 'Legal') {
          t.legalities = { ...t.legalities, standard: 'Legal' };
          patchedStandard++;
        }
        // TCGdex occasionally leaves a card's category-listing supertype wrong
        // forever when its per-card enrichment fetch never succeeds — the dead
        // giveaway is empty subtypes (enrichment always sets at least one).
        // Only patch that narrow, unambiguous case; don't blindly trust the
        // official scrape's supertype in general (its own header-keyword
        // categorization has false positives too, e.g. "能量輸送"/Energy
        // Retrieval is a real Trainer Item card despite the name).
        if (t.subtypes.length === 0 && t.supertype !== oc.supertype && oc.supertype === 'Energy') {
          t.supertype = 'Energy';
          const basicMatch = t.name.replace(/^基本/, '').match(/^[【\[]([^】\]]+)[】\]]能量$/);
          t.subtypes = [basicMatch ? 'Basic Energy' : 'Special Energy'];
          if (t.types === undefined && oc.types) t.types = oc.types;
          supertypeFixed++;
        }
      }
      if (matchType === 'key') matchedByKey++; else matchedByName++;
    } else if ((tcgdexByName.get(oc.name)?.length || 0) > 1) {
      // Name exists in TCGdex but ambiguously (multiple reprints) and no
      // set+number key matched either — skip rather than guess which print,
      // and definitely don't add a duplicate scr-* card for an already-known name.
      ambiguousSkipped++;
      if (ambiguousSamples.length < 15) ambiguousSamples.push(`${oc.name} (${oc.set?.id}-${oc.number})`);
    } else {
      // Genuinely no TCGdex equivalent — add as a new scr-* card
      const newCard: MapCard = { ...oc };
      if (rarity) newCard.rarity = rarity;
      newCard.legalities = { ...newCard.legalities, standard: 'Legal' };
      cards.push(newCard);
      addedNew++;
      unmatched++;
      if (unmatchedSamples.length < 15) unmatchedSamples.push(`${oc.name} (${oc.set?.id}-${oc.number})`);
    }
  }

  // ── Count currently-standard TCGdex cards that found no official match ──
  const staleStandard = cards.filter(
    c => !c.id.startsWith('scr-') && c.legalities?.standard === 'Legal' && !matchedTcgdexIds.has(c.id)
  );

  cacheRaw.timestamp = Date.now();
  fs.writeFileSync(CARDS_CACHE, JSON.stringify(cacheRaw, null, 2), 'utf-8');

  console.log('\n=== Reconciliation Complete ===');
  console.log(`  Official standard cards processed: ${officialCards.length}`);
  console.log(`  Matched by set+number key: ${matchedByKey}`);
  console.log(`  Matched by name fallback:  ${matchedByName}`);
  console.log(`  Rarity patched: ${patchedRarity}`);
  console.log(`  Standard-legal flag patched (newly set true): ${patchedStandard}`);
  console.log(`  Supertype fixed (empty-subtype TCGdex cards confirmed Energy): ${supertypeFixed}`);
  console.log(`  New scr-* cards added (no TCGdex match): ${addedNew}`);
  console.log(`  Ambiguous name matches skipped (no key match, name shared by 2+ TCGdex cards): ${ambiguousSkipped}`);
  console.log(`  Total cards now: ${cards.length}`);
  console.log(`\n  TCGdex cards flagged standard-legal WITHOUT an official-scrape match: ${staleStandard.length}`);
  if (staleStandard.length > 0) {
    console.log('  (left untouched — regulationMark-based check already gates these; sample:)');
    staleStandard.slice(0, 15).forEach(c => console.log(`    ${c.name} (${c.set?.id}-${c.number}, reg:${c.regulationMark})`));
  }
  if (unmatchedSamples.length > 0) {
    console.log(`\n  Sample of newly-added scr-* cards:`);
    unmatchedSamples.forEach(s => console.log(`    ${s}`));
  }
}

main();
