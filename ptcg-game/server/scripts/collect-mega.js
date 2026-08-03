/**
 * collect-mega.js — Fetch detail pages for the official standard MEGA cards
 * (超級進化寶可夢ex, spPokemon=107) and extract name/category/collector/product
 * so we can diff against our local library.
 *
 * Input : server/data/audit/official-mega-ids.json  (array of 8-digit ID strings)
 * Output: server/data/audit/official-mega-details.json
 *
 * Run from ptcg-game/server:  node scripts/collect-mega.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const IN_JSON = path.join(AUDIT_DIR, 'official-mega-ids.json');
const OUT_JSON = path.join(AUDIT_DIR, 'official-mega-details.json');

const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail/';
const IMG_BASE = 'https://asia.pokemon-card.com/tw/card-img/';

const ENERGY_ICON = /various_images\/energy\/([A-Za-z]+)\.png/g;

function extractAll(re, html) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(html)) !== null) out.push(m);
  return out;
}

function firstMatch(re, html, group = 1) {
  const m = html.match(re);
  return m ? m[group] : null;
}

/** Minimal parse of a detail page — enough to identify the card. */
function parseDetail(html, id) {
  const h1Raw = firstMatch(/<h1 class="pageHeader cardDetail">([\s\S]*?)<\/h1>/, html);
  const h1text = h1Raw ? h1Raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;

  const evolveMarker = firstMatch(/<span class="evolveMarker">\s*([^<]+?)\s*<\/span>/, html);
  const h3Header = firstMatch(/<h3 class="commonHeader">\s*([^<]+?)\s*<\/h3>/, html);
  const category = evolveMarker ? evolveMarker.trim() : (h3Header ? h3Header.trim() : null);

  const image = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/tw\d+\.png)">/, html);

  const collectorNumbers = extractAll(/<span class="collectorNumber">([\s\S]*?)<\/span>/, html)
    .flatMap((m) => m[1].split(','))
    .map((s) => s.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);

  const product = firstMatch(/<section class="expansionLinkColumn">[\s\S]*?<a href="\/tw\/card-search\/list\/\?expansionCodes=[^"]+">\s*([^<]+?)\s*<\/a>/, html);
  const setMark = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/mark\/[^"]+)">/, html);

  return {
    id,
    name: h1text ? h1text.trim() : null,
    category: category ? category.trim() : null,
    image,
    collectorNumber: collectorNumbers.length ? collectorNumbers.join(', ') : null,
    product: product ? product.replace(/\s+/g, ' ').trim() : null,
    setMark,
  };
}

async function main() {
  const ids = JSON.parse(fs.readFileSync(IN_JSON, 'utf-8'));
  console.log(`Fetching ${ids.length} MEGA detail pages...`);

  const cards = [];
  let ok = 0, fail = 0;

  for (const id of ids) {
    const detailUrl = `${DETAIL_BASE}${id}/`;
    const imgUrl = `${IMG_BASE}tw${String(id).padStart(8, '0')}.png`;
    try {
      const res = await fetch(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
      const html = await res.text();
      const card = parseDetail(html, id);
      card.image = imgUrl;
      cards.push(card);
      ok++;
      console.log(`[${ok}/${ids.length}] ${id} ${card.name} (${card.category}) ${card.collectorNumber} ${card.product}`);
    } catch (e) {
      fail++;
      console.error(`[FAIL] ${id}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(cards, null, 2), 'utf-8');
  console.log(`\nDONE: ${ok} ok, ${fail} fail → ${OUT_JSON}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
