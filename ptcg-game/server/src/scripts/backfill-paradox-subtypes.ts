/**
 * Backfills the 古代 (Ancient) / 未來 (Future) subtypes into cards.json.
 *
 * Neither source carries them as data: TCGdex has 0 cards with either subtype, and on the
 * official card page the label is part of the card ARTWORK — 「古代」 appears exactly once in the
 * HTML of an Ancient Pokémon's page, and that occurrence is inside an attack's effect text. So
 * the mechanic was unimplementable and the gap is recorded in CLAUDE.md/ROADMAP.
 *
 * The official CARD SEARCH does expose it, as a filter: `pokemonTag[]=105` is 古代 and
 * `pokemonTag[]=106` is 未來. Paging that filter gives the membership list, which is all the
 * engine needs.
 *
 * What this unblocks: 覺醒戰鼓 counts 「古代」 Pokémon in play and so always drew 0, and
 * 振翼髮's 蠱惑挪移 (preset-reachable) moves damage off an 「古代」 Pokémon.
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

const TAGS: { value: number; subtype: 'Ancient' | 'Future'; zh: string }[] = [
  { value: 105, subtype: 'Ancient', zh: '古代' },
  { value: 106, subtype: 'Future', zh: '未來' },
];

interface AnyCard {
  id: string; name: string; supertype?: string; subtypes?: string[];
  set?: { id: string }; number?: string; legalities?: { standard?: string };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const numOf = (s: string | undefined) => {
  const m = String(s ?? '').match(/^0*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const tcgNum = (s: string | undefined) => {
  const m = String(s ?? '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const normalizeName = (n: string) => n.replace(/^[‌​\s]+/, '').replace(/[<>「」]/g, '').trim();

async function collectDetailIds(tagValue: number): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 1; page <= 40; page++) {
    const res = await fetch(`${LIST}?pokemonTag%5B%5D=${tagValue}&pageNo=${page}`, { headers: UA });
    if (!res.ok) break;
    const html = await res.text();
    const found = [...html.matchAll(/card-search\/detail\/(\d+)/g)].map(m => m[1]);
    const before = ids.size;
    for (const id of found) ids.add(id);
    await sleep(120);
    // Paging past the end repeats the last page, so stop when nothing new arrives.
    if (ids.size === before) break;
  }
  return [...ids];
}

async function fetchDetail(detailId: string): Promise<{ setId: string; number: number | null; name: string } | null> {
  const res = await fetch(`${DETAIL}/${detailId}/`, { headers: UA });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  const setId = (html.match(/expansionCodes=([A-Za-z0-9]+)/) ?? [])[1] ?? '';
  const number = numOf($('.collectorNumber').first().text().trim());
  const name = normalizeName(($('title').first().text() || '').split('|')[0].trim());
  return { setId, number, name };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const wrapper = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as { timestamp: number; data: AnyCard[] };
  const cards = wrapper.data;

  // Index our side by set+number, with the promo special case (cards.json stores set "SV-P" and a
  // `number` field of literally "P", so the printed number only survives in the id).
  const byKey = new Map<string, AnyCard[]>();
  for (const c of cards) {
    const ourNumber = c.set?.id === 'SV-P' ? c.id.replace(/^SV-P-/, '') : (c.number ?? '');
    const n = tcgNum(ourNumber);
    if (n === null || !c.set?.id) continue;
    const k = `${c.set.id.toLowerCase()}-${n}`;
    const arr = byKey.get(k);
    if (arr) arr.push(c); else byKey.set(k, [c]);
  }

  const matched: { id: string; name: string; subtype: string }[] = [];
  const unmatched: { detailId: string; setId: string; number: number | null; name: string; subtype: string }[] = [];

  for (const tag of TAGS) {
    const ids = await collectDetailIds(tag.value);
    console.log(`${tag.zh}: ${ids.length} prints listed by the official search`);
    for (const [i, detailId] of ids.entries()) {
      process.stdout.write(`\r  ${tag.zh} ${i + 1}/${ids.length}   `);
      const d = await fetchDetail(detailId);
      await sleep(120);
      if (!d) continue;
      // Promos come back as set "SV" with number "110/SV-P"; our side files them under SV-P.
      const candidates = byKey.get(`${d.setId.toLowerCase()}-${d.number}`)
        ?? byKey.get(`sv-p-${d.number}`)
        ?? [];
      const hit = candidates.find(c => {
        const a = normalizeName(c.name), b = d.name;
        return a.includes(b) || b.includes(a);
      });
      if (!hit) { unmatched.push({ detailId, ...d, subtype: tag.subtype }); continue; }
      matched.push({ id: hit.id, name: hit.name, subtype: tag.subtype });
    }
    process.stdout.write('\r');
  }

  const already = matched.filter(m => cards.find(c => c.id === m.id)?.subtypes?.includes(m.subtype));
  console.log(`matched to cards.json: ${matched.length} (${already.length} already tagged)`);
  console.log(`unmatched: ${unmatched.length}`);
  for (const u of unmatched.slice(0, 10)) console.log(`  ${u.subtype} ${u.name} ${u.setId} #${u.number}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'paradox-subtypes.json'), JSON.stringify({ matched, unmatched }, null, 2), 'utf-8');
  console.log('Report -> data-scraped/paradox-subtypes.json');

  if (!apply) { console.log('Read-only. Re-run with --apply to write the subtypes into cards.json.'); return; }

  const byId = new Map(cards.map(c => [c.id, c]));
  let patched = 0;
  for (const m of matched) {
    const card = byId.get(m.id);
    if (!card) continue;
    card.subtypes ??= [];
    if (!card.subtypes.includes(m.subtype)) { card.subtypes.push(m.subtype); patched++; }
  }
  fs.writeFileSync(CARDS_CACHE, JSON.stringify({ ...wrapper, data: cards }, null, 2), 'utf-8');
  console.log(`Patched ${patched} cards in cards.json.`);
}

main();
