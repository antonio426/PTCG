/**
 * Backfill real Trainer-card rules text into cards.json.
 *
 * TCGdex never provides Trainer effect text, and the earlier official scrapers
 * (scrape-all-official-data.ts / scrape-missing-card-data.ts) only extracted
 * Pokémon attack/ability text — Trainer cards' `.skill` block has an EMPTY
 * skillName (vs. a real attack's named skillName, or a "[物品規則]"-style
 * reminder block), so it was silently dropped every time.
 *
 * Strategy: dedupe by card name (reprints share identical rules text), reuse
 * the official numeric IDs already sitting in scraped-cards-all.json instead of
 * re-searching, and fetch only ~241 detail pages instead of all 772 reprints.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_ALL = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail';

interface CacheWrapper { timestamp: number; data: MapCard[]; }

/** Reminder-text blocks that aren't the card's actual effect. */
const REMINDER_PREFIXES = ['[物品規則]', '[支援者規則]', '[競技場規則]', '[寶可夢道具規則]', '[ACE SPEC規則]'];

function extractTrainerRules(html: string): string[] {
  const $ = cheerio.load(html);
  const rules: string[] = [];
  $('.skill').each((_i, el) => {
    const $el = $(el);
    const name = $el.find('.skillName').text().trim();
    if (name && REMINDER_PREFIXES.some(p => name.startsWith(p.slice(0, 2)))) return; // skip reminder blocks
    if (name) return; // a non-empty, non-reminder name means this isn't a plain trainer-effect block
    const effect = $el.find('.skillEffect').text().trim();
    if (effect) rules.push(effect);
  });
  return rules;
}

async function main() {
  console.log('Reading cards.json...');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as CacheWrapper;
  const cards = cacheRaw.data;
  const trainers = cards.filter(c => c.supertype === 'Trainer' && c.legalities?.standard === 'Legal');
  const uniqueNames = [...new Set(trainers.map(c => c.name))];
  console.log(`  Trainer reprints: ${trainers.length}, unique names: ${uniqueNames.length}`);

  console.log('Reading scraped-cards-all.json for a representative official ID per name...');
  const official = (JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8')).data as MapCard[]);
  const officialByName = new Map<string, string>(); // name -> scr-XXXX id
  for (const o of official) {
    if (o.supertype === 'Trainer' && !officialByName.has(o.name)) officialByName.set(o.name, o.id);
  }

  const namesToFetch = uniqueNames.filter(n => officialByName.has(n));
  console.log(`  Names with a known official ID: ${namesToFetch.length} / ${uniqueNames.length}`);

  const rulesByName = new Map<string, string[]>();
  const CONCURRENCY = 5;
  let done = 0, failed = 0;

  for (let i = 0; i < namesToFetch.length; i += CONCURRENCY) {
    const batch = namesToFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (name) => {
      const scrId = officialByName.get(name)!.replace(/^scr-/, '');
      const res = await fetch(`${DETAIL_BASE}/${scrId}/`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const rules = extractTrainerRules(html);
      return { name, rules };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') { rulesByName.set(r.value.name, r.value.rules); done++; }
      else failed++;
    }
    if (done % 50 < CONCURRENCY) console.log(`  Progress: ${done + failed}/${namesToFetch.length} (${failed} failed)`);
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nFetched rules for ${rulesByName.size} unique trainer names (${failed} failed)`);

  let patched = 0;
  for (const c of cards) {
    if (c.supertype !== 'Trainer') continue;
    const rules = rulesByName.get(c.name);
    if (rules && rules.length > 0) { (c as any).rules = rules; patched++; }
  }

  cacheRaw.timestamp = Date.now();
  fs.writeFileSync(CARDS_CACHE, JSON.stringify(cacheRaw, null, 2), 'utf-8');
  console.log(`Patched rules text onto ${patched} card records (all reprints of the ${rulesByName.size} fetched names).`);

  const missing = uniqueNames.filter(n => !rulesByName.has(n));
  console.log(`\nStill missing rules text for ${missing.length} names:`);
  missing.slice(0, 40).forEach(n => console.log('  ', n));
  fs.writeFileSync(
    path.resolve(__dirname, '../../../data-scraped/trainer-rules-missing.json'),
    JSON.stringify(missing, null, 2), 'utf-8'
  );
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
