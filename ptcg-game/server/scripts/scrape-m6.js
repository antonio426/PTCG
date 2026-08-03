/**
 * scrape-m6.js — Scrape M6 set (擴充包「綠寶石風暴」/ Emerald Storm) from
 * https://asia.pokemon-card.com/tw/card-search/list/?expansionCodes=M6
 *
 * Outputs:
 *   - server/data/scraped-m6.json      (raw card data, array of card objects)
 *   - server/data/m6-images/tw{id}.png (downloaded card images)
 *
 * Run from ptcg-game/server:  node scripts/scrape-m6.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMG_DIR = path.join(DATA_DIR, 'm6-images');
const OUT_JSON = path.join(DATA_DIR, 'scraped-m6.json');

const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail/';
const IMG_BASE = 'https://asia.pokemon-card.com/tw/card-img/';

// Detail IDs 19551..19623 (73 cards, from search list pages)
const IDS = [];
for (let i = 19551; i <= 19623; i++) IDS.push(i);

const ENERGY_ICON = /various_images\/energy\/([A-Za-z]+)\.png/g;

function extractAll(re, html) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(html)) !== null) out.push(m);
  return out;
}

function firstMatch(re, html, group = 1) {
  // A /g regex makes String.match() return full-match strings (no groups) — clone without /g.
  const r = re.flags.includes('g') ? new RegExp(re.source, re.flags.replace('g', '')) : re;
  const m = html.match(r);
  return m ? m[group] : null;
}

/** Parse one detail page HTML into a card object. */
function parseDetail(html, id) {
  // h1: <h1 class="pageHeader cardDetail"> [<span class="evolveMarker">基礎</span>] 赫拉克羅斯 </h1>
  //   Pokémon cards: evolveMarker present (基礎/1階進化/2階進化)
  //   Trainer/Energy cards: no evolveMarker — h3.commonHeader holds the category (物品卡/競技場卡/...)
  const h1Raw = firstMatch(/<h1 class="pageHeader cardDetail">([\s\S]*?)<\/h1>/, html);
  const h1text = h1Raw ? h1Raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  const name = h1text || null;

  // Category: evolveMarker if present, else the skillInformation h3 header
  const evolveMarker = firstMatch(/<span class="evolveMarker">\s*([^<]+?)\s*<\/span>/, html);
  const h3Header = firstMatch(/<h3 class="commonHeader">\s*([^<]+?)\s*<\/h3>/, html);
  const category = evolveMarker ? evolveMarker.trim() : (h3Header ? h3Header.trim() : null);

  // Image
  const image = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/tw\d+\.png)">/, html);

  // HP
  const hpRaw = firstMatch(/<span class="hitPoint">HP<\/span>\s*<span class="number">(\d+)<\/span>/, html);
  const hp = hpRaw ? parseInt(hpRaw, 10) : null;

  // Type (屬性) — energy icon next to HP
  const typeRaw = firstMatch(/<span class="type">[^<]*<\/span>\s*<img src="https:\/\/asia\.pokemon-card\.com\/various_images\/energy\/([A-Za-z]+)\.png">/, html);

  // Attacks (招式) — Pokémon cards. Trainer/Energy cards have one skill block with
  // empty name but the card effect text in skillEffect.
  const attacks = [];
  const trainerEffects = [];
  const skillBlocks = extractAll(/<div class="skill">([\s\S]*?)<\/div>\s*<\/div>/, html);
  for (const b of skillBlocks) {
    const block = b[1];
    const skillName = firstMatch(/<span class="skillName">([^<]+?)<\/span>/, block);
    const effect = firstMatch(/<p class="skillEffect">\s*([\s\S]*?)\s*<\/p>/, block);
    if (!skillName) {
      // Trainer/Energy card effect block
      if (effect) trainerEffects.push(effect.replace(/\s+/g, ' ').trim());
      continue;
    }
    const cost = [...block.matchAll(ENERGY_ICON)].map((m) => m[1]);
    const damageRaw = firstMatch(/<span class="skillDamage">([^<]+?)<\/span>/, block);
    attacks.push({
      name: skillName.trim(),
      cost,
      damage: damageRaw ? damageRaw.trim() : null,
      effect: effect ? effect.replace(/\s+/g, ' ').trim() : null,
    });
  }

  // Weakness / Resistance / Retreat
  const weakRaw = firstMatch(/<td class="weakpoint">([\s\S]*?)<\/td>/, html);
  const resistRaw = firstMatch(/<td class="resist">([\s\S]*?)<\/td>/, html);
  const escapeRaw = firstMatch(/<td class="escape">([\s\S]*?)<\/td>/, html);

  const parseWeak = (raw) => {
    if (!raw) return null;
    const type = firstMatch(ENERGY_ICON, raw);
    const val = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
    if (!type) return val || null; // e.g. "--" or "なし"
    return { type, value: val.replace(type, '') || '×2' };
  };

  // Collector number — may be multiple (e.g. "071/076 , 072/076")
  const collectorNumbers = extractAll(/<span class="collectorNumber">([\s\S]*?)<\/span>/, html)
    .flatMap((m) => m[1].split(','))
    .map((s) => s.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  const setMark = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/mark\/[^"]+)">/, html);

  // Evolution target
  const evolution = extractAll(/<li class="step[^"]*">\s*<a href="[^"]*keyword=([^&"]+)&searchType=evolve">([^<]+)<\/a>/, html)
    .map((m) => ({ keyword: decodeURIComponent(m[1]), name: m[2] }));

  // Dex info: <h3>No.214 獨角寶可夢</h3>
  const dexRaw = firstMatch(/<h3>No\.(\d+)\s*([^<]+?)<\/h3>/, html);
  const dexNo = dexRaw ? parseInt(dexRaw, 10) : null;
  const species = dexRaw ? dexRaw[2] : null;

  // Size
  const height = firstMatch(/身高\s*<span class="value">([^<]+)<\/span>/, html);
  const weight = firstMatch(/體重\s*<span class="value">([^<]+)<\/span>/, html);

  // Flavor
  const flavor = firstMatch(/<p class="discription">\s*([\s\S]*?)\s*<\/p>/, html);

  // Illustrator
  const illustrator = firstMatch(/<div class="illustrator">[\s\S]*?<a href="[^"]*illustratorName=[^"]*">([^<]+)<\/a>/, html);

  // Product (收錄商品)
  const product = firstMatch(/<section class="expansionLinkColumn">[\s\S]*?<a href="\/tw\/card-search\/list\/\?expansionCodes=[^"]+">\s*([^<]+?)\s*<\/a>/, html);

  return {
    id,
    name: name ? name.trim() : null,
    category: category ? category.trim() : null,
    image,
    hp,
    type: typeRaw,
    attacks,
    effect: trainerEffects.length ? trainerEffects.join(' ') : null,
    weakness: parseWeak(weakRaw),
    resistance: parseWeak(resistRaw),
    retreat: parseWeak(escapeRaw),
    collectorNumber: collectorNumbers.length ? collectorNumbers.join(', ') : null,
    setMark,
    evolution,
    dexNo,
    species: species ? species.trim() : null,
    height: height ? height.trim() : null,
    weight: weight ? weight.trim() : null,
    flavor: flavor ? flavor.replace(/\s+/g, ' ').trim() : null,
    illustrator: illustrator ? illustrator.trim() : null,
    product: product ? product.replace(/\s+/g, ' ').trim() : null,
  };
}

async function downloadImage(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const cards = [];
  let ok = 0, fail = 0;

  for (const id of IDS) {
    const detailUrl = `${DETAIL_BASE}${id}/`;
    const imgUrl = `${IMG_BASE}tw${String(id).padStart(8, '0')}.png`;
    try {
      const res = await fetch(detailUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
      const html = await res.text();
      const card = parseDetail(html, id);
      cards.push(card);

      // Download image
      const imgFile = path.join(IMG_DIR, `tw${String(id).padStart(8, '0')}.png`);
      const bytes = await downloadImage(imgUrl, imgFile);
      card.imageFile = imgFile;
      card.imageBytes = bytes;

      ok++;
      console.log(`[${ok}/${IDS.length}] ${id} ${card.name} (${card.category}) ${card.collectorNumber} img=${bytes}B`);
    } catch (e) {
      fail++;
      console.error(`[FAIL] ${id}: ${e.message}`);
    }
    // Be polite to the site
    await new Promise((r) => setTimeout(r, 150));
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(cards, null, 2), 'utf-8');
  console.log(`\nDONE: ${ok} ok, ${fail} fail → ${OUT_JSON}`);
  console.log(`Images in: ${IMG_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
