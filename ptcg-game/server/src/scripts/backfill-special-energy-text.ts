/**
 * Backfills the printed effect text of Special Energy cards into cards.json.
 *
 * Every Special Energy in the dataset has an empty `rules` array — from TCGdex and from the
 * existing official scrape alike, because `scrape-all-official-data.ts` reads effect text out of
 * the `.skill` block that Pokémon cards use and never looked at Energy cards. The official detail
 * page does carry it: `.skillEffect` holds the whole rules paragraph.
 *
 * Without the text these cards are just a Colorless energy with a name — 稜鏡能量 counting as
 * every type on a Basic, 火箭隊能量's family gate, and the rest are all invisible to the engine.
 *
 * Read-only; `--apply` writes into cards.json.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const OUT_DIR = path.resolve(__dirname, '../../../data-scraped');
const LIST = 'https://asia.pokemon-card.com/tw/card-search/list/';
const DETAIL = 'https://asia.pokemon-card.com/tw/card-search/detail';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; ptcg-game-data-audit/1.0)' };

interface AnyCard {
  id: string; name: string; supertype?: string; subtypes?: string[];
  rules?: string[]; types?: string[];
  set?: { id: string }; number?: string; legalities?: { standard?: string };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const norm = (n: string) => String(n).replace(/^[‌​\s]+/, '').trim();

async function fetchEffectText(name: string): Promise<{ text: string; detailId: string } | null> {
  const res = await fetch(`${LIST}?keyword=${encodeURIComponent(name)}&card_type=all`, { headers: UA });
  if (!res.ok) return null;
  const ids = [...new Set([...(await res.text()).matchAll(/card-search\/detail\/(\d+)/g)].map(m => m[1]))];
  for (const detailId of ids.slice(0, 6)) {
    const d = await fetch(`${DETAIL}/${detailId}/`, { headers: UA });
    await sleep(120);
    if (!d.ok) continue;
    const html = await d.text();
    const $ = cheerio.load(html);
    if (norm(($('title').first().text() || '').split('|')[0].trim()) !== name) continue;
    // Energy cards keep their whole rules paragraph in .skillEffect; collapse the page's
    // formatting whitespace but keep the sentence breaks the card prints.
    const text = $('.skillEffect').first().text().replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '').trim();
    if (text) return { text, detailId };
  }
  return null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const wrapper = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as { timestamp: number; data: AnyCard[] };
  const cards = wrapper.data;

  const special = cards.filter(c =>
    c.legalities?.standard === 'Legal' && (c.subtypes ?? []).includes('Special Energy'));
  const names = [...new Set(special.map(c => norm(c.name)))];
  console.log(`Standard Special Energy names: ${names.length} (${special.length} prints)`);
  const already = special.filter(c => (c.rules ?? []).length > 0).length;
  console.log(`prints that already carry rules text: ${already}`);

  const found: { name: string; text: string; detailId: string; prints: number }[] = [];
  const missing: string[] = [];
  for (const [i, name] of names.entries()) {
    process.stdout.write(`\r  ${i + 1}/${names.length} ${name}          `);
    const hit = await fetchEffectText(name).catch(() => null);
    await sleep(120);
    if (!hit) { missing.push(name); continue; }
    found.push({ ...hit, name, prints: special.filter(c => norm(c.name) === name).length });
  }
  process.stdout.write('\r');

  console.log(`resolved: ${found.length} / ${names.length}`);
  for (const f of found) console.log(`  ${f.name} (${f.prints} prints)\n    ${f.text}`);
  if (missing.length) console.log(`no text found for: ${missing.join(', ')}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'special-energy-text.json'), JSON.stringify({ found, missing }, null, 2), 'utf-8');
  console.log('Report -> data-scraped/special-energy-text.json');

  if (!apply) { console.log('Read-only. Re-run with --apply to write the text into cards.json.'); return; }

  const textByName = new Map(found.map(f => [f.name, f.text]));
  let patched = 0;
  // Every print of a Special Energy prints the same text, so apply by name across the whole
  // catalog rather than just the Standard subset.
  for (const card of cards) {
    if (!(card.subtypes ?? []).includes('Special Energy')) continue;
    const text = textByName.get(norm(card.name));
    if (!text) continue;
    if ((card.rules ?? []).includes(text)) continue;
    card.rules = [text];
    patched++;
  }
  fs.writeFileSync(CARDS_CACHE, JSON.stringify({ ...wrapper, data: cards }, null, 2), 'utf-8');
  console.log(`Patched ${patched} prints in cards.json.`);
}

main();
