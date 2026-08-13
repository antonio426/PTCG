/**
 * Backfills `attacks` on server/data/cards.json (TCGdex-sourced) from the already-scraped
 * official-site dataset (server/data/scraped-cards-all.json, produced by
 * scrape-all-official-data.ts) wherever TCGdex is missing it and the official scrape has it.
 *
 * Reuses reconcile-official-data.ts's matching strategy exactly (set+number key first, falling
 * back to name matching ONLY when the name is unambiguous in cards.json) — see that file's header
 * comment for why: many card names are shared by a decade of reprints, so a bare name match risks
 * patching the wrong print. Ambiguous/no-match cards are skipped, not guessed.
 *
 * Run with: npx tsx src/scripts/backfill-attacks-from-official.ts
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

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

function main() {
  console.log('Reading cards.json...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  const cardCountBefore = cards.length;
  console.log(`  TCGdex cards: ${cardCountBefore}`);

  console.log('Reading scraped-cards-all.json (official)...');
  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8'));
  const officialCards = scrapedRaw.data as MapCard[];
  console.log(`  Official cards: ${officialCards.length}`);

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

  let matchedByKey = 0;
  let matchedByName = 0;
  let patched = 0;
  let ambiguousSkipped = 0;
  let noOfficialAttacks = 0;
  let alreadyHadAttacks = 0;
  let noMatch = 0;
  const patchedSamples: string[] = [];
  const ambiguousSamples: string[] = [];

  for (const oc of officialCards) {
    // Only Pokémon actually have attacks — Trainer "rule reminder" blocks (e.g. Ultra Ball's
    // "[物品規則]") get mis-scraped into the same .skill/attacks shape by
    // scrape-all-official-data.ts (its `[`-prefix filter only catches ability blocks, not these,
    // since the reminder text itself doesn't retain the bracket in the scraped name). Guard here
    // rather than trusting supertype alone, since that mis-scrape is a real observed case.
    if (oc.supertype !== 'Pokémon') continue;
    if (isEmpty(oc.attacks)) { noOfficialAttacks++; continue; }

    const num = parseNumerator(oc.number || '');
    const k = key(oc.set?.id || '', num);

    let targets: MapCard[] | undefined = k ? tcgdexByKey.get(k) : undefined;
    let matchType: 'key' | 'name' | null = targets && targets.length > 0 ? 'key' : null;
    if (!targets || targets.length === 0) {
      const nameCandidates = tcgdexByName.get(oc.name);
      if (nameCandidates && nameCandidates.length === 1) {
        targets = nameCandidates;
        matchType = 'name';
      } else if (nameCandidates && nameCandidates.length > 1) {
        ambiguousSkipped++;
        if (ambiguousSamples.length < 15) ambiguousSamples.push(`${oc.name} (${oc.set?.id}-${oc.number})`);
        continue;
      } else {
        targets = undefined;
      }
    }

    if (!targets || targets.length === 0) { noMatch++; continue; }

    for (const t of targets) {
      if (t.supertype !== 'Pokémon') continue; // defense in depth alongside the oc.supertype guard above
      if (!isEmpty(t.attacks)) { alreadyHadAttacks++; continue; }
      t.attacks = oc.attacks;
      patched++;
      if (patchedSamples.length < 20) patchedSamples.push(`${t.name} (${t.id})`);
    }
    if (matchType === 'key') matchedByKey++; else if (matchType === 'name') matchedByName++;
  }

  const cardCountAfter = cards.length;
  if (cardCountAfter !== cardCountBefore) {
    throw new Error(`Card count changed (${cardCountBefore} -> ${cardCountAfter}) — this script must only patch fields, never add/remove cards. Aborting without writing.`);
  }

  cacheRaw.timestamp = Date.now();
  fs.writeFileSync(CARDS_CACHE, JSON.stringify(cacheRaw, null, 2), 'utf-8');

  console.log('\n=== Attacks Backfill Complete ===');
  console.log(`  Official cards with attacks: ${officialCards.length - noOfficialAttacks}`);
  console.log(`  Matched by set+number key: ${matchedByKey}`);
  console.log(`  Matched by unambiguous name: ${matchedByName}`);
  console.log(`  Patched (TCGdex attacks was empty, official had data): ${patched}`);
  console.log(`  Skipped — TCGdex already had attacks: ${alreadyHadAttacks}`);
  console.log(`  Skipped — ambiguous name (2+ TCGdex cards share it), no key match: ${ambiguousSkipped}`);
  console.log(`  Skipped — no TCGdex match at all: ${noMatch}`);
  console.log(`  Card count unchanged: ${cardCountBefore} -> ${cardCountAfter}`);
  if (patchedSamples.length > 0) {
    console.log(`\n  Sample of patched cards:`);
    patchedSamples.forEach(s => console.log(`    ${s}`));
  }
  if (ambiguousSamples.length > 0) {
    console.log(`\n  Sample of skipped ambiguous matches:`);
    ambiguousSamples.forEach(s => console.log(`    ${s}`));
  }
}

main();
