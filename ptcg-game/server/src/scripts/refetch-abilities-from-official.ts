/**
 * Targeted follow-up to backfill-attacks-from-official.ts: the official-site scraper
 * (scrape-all-official-data.ts) couldn't extract Pokémon abilities at all until its
 * `[`-prefix-bracket parsing bug was just fixed (abilities live in the same .skill blocks as
 * attacks, tagged "[特性] <name>" — there's no separate .abilityBlock). scraped-cards-all.json
 * was scraped before that fix, so its `abilities` field is empty for every card.
 *
 * Rather than re-scraping all 5160 official cards, this re-fetches detail pages ONLY for the
 * cards data-scraped/sibling-data-gaps.json flagged as missing `abilities` (looked up via the
 * same set+number matching reconcile-official-data.ts / backfill-attacks-from-official.ts use),
 * updates their record in scraped-cards-all.json, and backfills cards.json the same cautious way.
 *
 * Run with: npx tsx src/scripts/refetch-abilities-from-official.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import type { MapCard, Ability } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_ALL = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const GAPS_REPORT = path.resolve(__dirname, '../../../data-scraped/sibling-data-gaps.json');
const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail';

const REMINDER_PREFIXES = ['[物品規則]', '[支援者規則]', '[競技場規則]', '[寶可夢道具規則]', '[ACE SPEC規則]'];

interface CacheWrapper { timestamp: number; data: MapCard[]; }
interface Gap { name: string; field: 'abilities' | 'attacks'; missingId: string; missingStandardLegal: boolean; sourceId: string; confidence: string; }

function parseNumerator(num: string): number | null {
  const m = num.match(/^0*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function parseTcgdexNumber(num: string): number | null {
  const m = num.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function key(setId: string, num: number | null): string | null {
  if (num === null || !setId) return null;
  return `${setId.toLowerCase()}-${num}`;
}

/** Parses just the ability blocks ("[特性] <name>") out of a detail page — mirrors the fixed
 * logic in scrape-all-official-data.ts, scoped down since attacks aren't needed here. */
function parseAbilities(html: string): Ability[] {
  const $ = cheerio.load(html);
  const abilities: Ability[] = [];
  $('.skill').each((_i, el) => {
    const $el = $(el);
    const name = $el.find('.skillName').text().trim();
    if (!name.startsWith('[特性]')) return;
    const cleanName = name.replace(/^\[特性\]\s*/, '');
    const text = $el.find('.skillEffect').text().trim();
    abilities.push({ name: cleanName, text, type: 'Ability' });
  });
  return abilities;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Reading cards.json...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  const cardCountBefore = cards.length;
  const cardsById = new Map(cards.map(c => [c.id, c]));

  console.log('Reading scraped-cards-all.json...');
  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8'));
  const officialCards = scrapedRaw.data as MapCard[];
  const officialByKey = new Map<string, MapCard>();
  for (const oc of officialCards) {
    const num = parseNumerator(oc.number || '');
    const k = key(oc.set?.id || '', num);
    if (k) officialByKey.set(k, oc); // sibling-gap candidates are singular prints; last-write is fine here
  }

  console.log('Reading sibling-data-gaps.json...');
  const gaps = JSON.parse(fs.readFileSync(GAPS_REPORT, 'utf-8')) as Gap[];
  const missingAbilityIds = [...new Set(gaps.filter(g => g.field === 'abilities').map(g => g.missingId))];
  console.log(`  Candidates missing abilities: ${missingAbilityIds.length}`);

  let noOfficialMatch = 0;
  let fetchFailed = 0;
  let noAbilityOnPage = 0;
  let patchedCards = 0;
  let patchedOfficialRecords = 0;
  const patchedSamples: string[] = [];
  const noMatchSamples: string[] = [];

  for (let i = 0; i < missingAbilityIds.length; i++) {
    const tcgdexId = missingAbilityIds[i];
    const card = cardsById.get(tcgdexId);
    if (!card) { noOfficialMatch++; continue; }

    const num = parseTcgdexNumber(card.number || '');
    const k = key(card.set?.id || '', num);
    const oc = k ? officialByKey.get(k) : undefined;
    if (!oc) { noOfficialMatch++; if (noMatchSamples.length < 15) noMatchSamples.push(`${card.name} (${tcgdexId})`); continue; }

    const scrNum = oc.id.replace(/^scr-/, '');
    try {
      const res = await fetch(`${DETAIL_BASE}/${scrNum}/`);
      if (!res.ok) { fetchFailed++; continue; }
      const html = await res.text();
      const abilities = parseAbilities(html);

      if (abilities.length === 0) { noAbilityOnPage++; continue; }

      oc.abilities = abilities;
      patchedOfficialRecords++;

      if (!card.abilities || card.abilities.length === 0) {
        card.abilities = abilities;
        patchedCards++;
        if (patchedSamples.length < 20) patchedSamples.push(`${card.name} (${tcgdexId}): ${abilities.map(a => a.name).join(', ')}`);
      }
    } catch {
      fetchFailed++;
    }

    if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${missingAbilityIds.length}`);
    await sleep(150); // gentle on the official site
  }

  const cardCountAfter = cards.length;
  if (cardCountAfter !== cardCountBefore) {
    throw new Error(`Card count changed (${cardCountBefore} -> ${cardCountAfter}) — aborting without writing.`);
  }

  cacheRaw.timestamp = Date.now();
  fs.writeFileSync(CARDS_CACHE, JSON.stringify(cacheRaw, null, 2), 'utf-8');
  scrapedRaw.timestamp = Date.now();
  fs.writeFileSync(SCRAPED_ALL, JSON.stringify(scrapedRaw, null, 2), 'utf-8');

  console.log('\n=== Abilities Refetch + Backfill Complete ===');
  console.log(`  Candidates: ${missingAbilityIds.length}`);
  console.log(`  No matching official card (set+number key miss): ${noOfficialMatch}`);
  console.log(`  Fetch failed: ${fetchFailed}`);
  console.log(`  Official page had no [特性] ability block: ${noAbilityOnPage}`);
  console.log(`  Official records updated: ${patchedOfficialRecords}`);
  console.log(`  cards.json entries patched: ${patchedCards}`);
  console.log(`  Card count unchanged: ${cardCountBefore} -> ${cardCountAfter}`);
  if (patchedSamples.length > 0) {
    console.log(`\n  Sample of patched cards:`);
    patchedSamples.forEach(s => console.log(`    ${s}`));
  }
  if (noMatchSamples.length > 0) {
    console.log(`\n  Sample of no-official-match candidates:`);
    noMatchSamples.forEach(s => console.log(`    ${s}`));
  }
}

main();
