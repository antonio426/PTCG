/**
 * collect-std-full.js — Fetch FULL detail for all official standard cards (5343)
 * with images. Resumable: skips IDs already present in the output JSON and
 * images already downloaded.
 *
 * Input : server/data/audit/official-std-ids.json  (array of 8-digit ID strings)
 * Output: server/data/audit/std-full.json          (full parse, checkpointed)
 *         server/data/std-images/tw{id}.png        (card images)
 *
 * Run from ptcg-game/server:  node scripts/collect-std-full.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const IN_JSON = path.join(AUDIT_DIR, 'official-std-ids.json');
const OUT_JSON = path.join(AUDIT_DIR, 'std-full.json');
const IMG_DIR = path.join(DATA_DIR, 'std-images');

const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail/';
const IMG_BASE = 'https://asia.pokemon-card.com/tw/card-img/';
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 25;

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

/** Full parse of one detail page — mirrors scrape-m6.js. */
function parseDetail(html, id) {
  const h1Raw = firstMatch(/<h1 class="pageHeader cardDetail">([\s\S]*?)<\/h1>/, html);
  const h1text = h1Raw ? h1Raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
  const name = h1text || null;

  const evolveMarker = firstMatch(/<span class="evolveMarker">\s*([^<]+?)\s*<\/span>/, html);
  const h3Header = firstMatch(/<h3 class="commonHeader">\s*([^<]+?)\s*<\/h3>/, html);
  const category = evolveMarker ? evolveMarker.trim() : (h3Header ? h3Header.trim() : null);

  const image = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/tw\d+\.png)">/, html);

  const hpRaw = firstMatch(/<span class="hitPoint">HP<\/span>\s*<span class="number">(\d+)<\/span>/, html);
  const hp = hpRaw ? parseInt(hpRaw, 10) : null;

  const typeRaw = firstMatch(/<span class="type">[^<]*<\/span>\s*<img src="https:\/\/asia\.pokemon-card\.com\/various_images\/energy\/([A-Za-z]+)\.png">/, html);

  const attacks = [];
  const trainerEffects = [];
  const skillBlocks = extractAll(/<div class="skill">([\s\S]*?)<\/div>\s*<\/div>/, html);
  for (const b of skillBlocks) {
    const block = b[1];
    const skillName = firstMatch(/<span class="skillName">([^<]+?)<\/span>/, block);
    const effect = firstMatch(/<p class="skillEffect">\s*([\s\S]*?)\s*<\/p>/, block);
    if (!skillName) {
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

  const weakRaw = firstMatch(/<td class="weakpoint">([\s\S]*?)<\/td>/, html);
  const resistRaw = firstMatch(/<td class="resist">([\s\S]*?)<\/td>/, html);
  const escapeRaw = firstMatch(/<td class="escape">([\s\S]*?)<\/td>/, html);

  const parseWeak = (raw) => {
    if (!raw) return null;
    const type = firstMatch(ENERGY_ICON, raw);
    const val = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
    if (!type) return val || null;
    return { type, value: val.replace(type, '') || '×2' };
  };

  const collectorNumbers = extractAll(/<span class="collectorNumber">([\s\S]*?)<\/span>/, html)
    .flatMap((m) => m[1].split(','))
    .map((s) => s.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  const setMark = firstMatch(/<img src="(https:\/\/asia\.pokemon-card\.com\/tw\/card-img\/mark\/[^"]+)">/, html);

  const evolution = extractAll(/<li class="step[^"]*">\s*<a href="[^"]*keyword=([^&"]+)&searchType=evolve">([^<]+)<\/a>/, html)
    .map((m) => ({ keyword: decodeURIComponent(m[1]), name: m[2] }));

  const dexRaw = firstMatch(/<h3>No\.(\d+)\s*([^<]+?)<\/h3>/, html);
  const dexNo = dexRaw ? parseInt(dexRaw, 10) : null;
  const species = dexRaw ? dexRaw[2] : null;

  const height = firstMatch(/身高\s*<span class="value">([^<]+)<\/span>/, html);
  const weight = firstMatch(/體重\s*<span class="value">([^<]+)<\/span>/, html);

  const flavor = firstMatch(/<p class="discription">\s*([\s\S]*?)\s*<\/p>/, html);

  const illustrator = firstMatch(/<div class="illustrator">[\s\S]*?<a href="[^"]*illustratorName=[^"]*">([^<]+)<\/a>/, html);

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

async function fetchWithRetry(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

async function main() {
  const ids = JSON.parse(fs.readFileSync(IN_JSON, 'utf-8'));
  fs.mkdirSync(IMG_DIR, { recursive: true });

  // Resume: load already-done IDs from output + existing images
  let done = new Map();
  if (fs.existsSync(OUT_JSON)) {
    for (const c of JSON.parse(fs.readFileSync(OUT_JSON, 'utf-8'))) done.set(String(c.id), c);
  }
  const remaining = ids.filter((id) => !done.has(String(id)));
  console.log(`Total ${ids.length}, already done ${done.size}, remaining ${remaining.length}`);

  let ok = done.size, fail = 0;
  let queue = [...remaining];
  const log = (msg) => console.log(msg);

  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      const imgUrl = `${IMG_BASE}tw${String(id).padStart(8, '0')}.png`;
      const imgFile = path.join(IMG_DIR, `tw${String(id).padStart(8, '0')}.png`);
      try {
        const html = await fetchWithRetry(`${DETAIL_BASE}${id}/`);
        if (html === null) { fail++; log(`[404] ${id}`); continue; }
        const card = parseDetail(html, id);

        // Image (skip if already downloaded)
        if (!fs.existsSync(imgFile)) {
          const res = await fetch(imgUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (res.ok) {
            fs.writeFileSync(imgFile, Buffer.from(await res.arrayBuffer()));
            card.imageBytes = fs.statSync(imgFile).size;
          }
        } else {
          card.imageBytes = fs.statSync(imgFile).size;
        }
        card.imageFile = imgFile;
        done.set(String(id), card);
        ok++;
        if (ok % CHECKPOINT_EVERY === 0) {
          fs.writeFileSync(OUT_JSON, JSON.stringify([...done.values()], null, 0), 'utf-8');
          log(`[checkpoint] ${ok} done, ${fail} fail`);
        }
      } catch (e) {
        fail++;
        log(`[FAIL] ${id}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  fs.writeFileSync(OUT_JSON, JSON.stringify([...done.values()], null, 0), 'utf-8');
  console.log(`\nDONE: ${ok} ok, ${fail} fail → ${OUT_JSON}`);
  console.log(`Images in: ${IMG_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
