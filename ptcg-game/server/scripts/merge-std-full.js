// merge-std-full.js — merge std-full.json (5342 official standard detail entries)
// into cards-final.json as MapCard records.
// Strategy:
//  1. key = normSet(product)|normNum(collectorNumber) — official unique key
//  2. cache card with same key → keep as-is, just ensure legalities.standard='Legal' (legality fix)
//  3. cache card with same (cleanName|normNum) in ANY set → skip (already represented; avoid dup prints)
//  4. else ADD new MapCard (full mapping incl. weakness/resistance/retreat {type,value})
//  5. unmatched products (no cache set by normSet name) → new set id EXT01..EXT44 (deterministic, count-desc)
//  6. copy std-images/tw{id}.png → data/images/{setId}/{localId}.png for added cards
//  7. save cards-final.json + merge-std-summary.json
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '../data');
const std = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8')); // bare array
const cachePath = path.join(DATA, 'cards-final.json');
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); // {timestamp, data}

const PREFIX_RE = /^(基礎|1階進化|2階進化)\s*/;
const TYPE_OF = { '基礎': 'Basic', '1階進化': 'Stage 1', '2階進化': 'Stage 2' };
const TRAINER_SUBTYPE = { '物品卡': 'Item', '寶可夢道具': 'Pokémon Tool', '支援者卡': 'Supporter', '競技場卡': 'Stadium' };

function decodeEntities(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function normSet(name) {
  return decodeEntities(name)
    .replace(/[「」]/g, '')
    .replace(/^(擴充包|強化擴充包|高級擴充包)/, '')
    .replace(/\s+/g, '')
    .trim();
}
function normNum(n) { return String(n || '').trim().split('/')[0].trim(); }
function cleanName(name) { return String(name || '').replace(PREFIX_RE, '').trim(); }
function energyTypeName(type) {
  if (!type) return null;
  const m = String(type).match(/([A-Za-z]+)\.png$/);
  return m ? m[1] : type;
}
function retreatCount(value) {
  const m = String(value || '').match(/×(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ---- index cache ----
// normSet(cache set.name) → cache set object (first seen)
const cacheSetByNorm = new Map();
// key (normSet(set.name)|normNum(number)) → cache card index
const cacheKeyToIdx = new Map();
// (cleanName|normNum(number)) → true  (any set)
const cacheNameNum = new Set();
for (let i = 0; i < cache.data.length; i++) {
  const c = cache.data[i];
  if (!c.set) continue;
  const sk = normSet(c.set.name);
  if (!cacheSetByNorm.has(sk)) cacheSetByNorm.set(sk, c.set);
  cacheKeyToIdx.set(`${sk}|${normNum(c.number)}`, i);
  cacheNameNum.add(`${cleanName(c.name)}|${normNum(c.number)}`);
}

// ---- new set ids for unmatched products (deterministic: first appearance order) ----
const productCount = new Map();
for (const e of std) {
  const p = normSet(e.product);
  productCount.set(p, (productCount.get(p) || 0) + 1);
}
const unmatchedProducts = [...new Set(std.map(e => normSet(e.product)))].filter(p => !cacheSetByNorm.has(p));
unmatchedProducts.sort((a, b) => (productCount.get(b) || 0) - (productCount.get(a) || 0));
const newSetIdByProduct = new Map();
unmatchedProducts.forEach((p, i) => newSetIdByProduct.set(p, `EXT${String(i + 1).padStart(2, '0')}`));

// product normSet → final setId
function resolveSetId(product) {
  const p = normSet(product);
  if (cacheSetByNorm.has(p)) return cacheSetByNorm.get(p).id;
  return newSetIdByProduct.get(p);
}

// build MapCard from std-full entry + num (one collector number)
function toCard(entry, num) {
  const name = cleanName(entry.name);
  const isPokemon = entry.category === '基礎' || entry.category === '1階進化' || entry.category === '2階進化';
  const subtypes = isPokemon
    ? (TYPE_OF[entry.category] ? [TYPE_OF[entry.category]] : [])
    : (TRAINER_SUBTYPE[entry.category] ? [TRAINER_SUBTYPE[entry.category]] : []);
  if (isPokemon && /ex$/.test(name)) subtypes.push('ex');
  const localId = num.split('/')[0].trim();
  const setId = resolveSetId(entry.product);
  const cacheSet = cacheSetByNorm.get(normSet(entry.product));
  const set = cacheSet
    ? { ...cacheSet }
    : {
        id: setId,
        name: decodeEntities(entry.product),
        series: 'SV',
        printedTotal: 0,
        total: 0,
        releaseDate: ''
      };
  const card = {
    id: `${setId}-${localId}`,
    name,
    supertype: isPokemon ? 'Pokémon' : 'Trainer',
    subtypes,
    set,
    number: num,
    legalities: { standard: 'Legal' },
    images: {
      small: `/api/images/SV/${setId}/${localId}/low`,
      large: `/api/images/SV/${setId}/${localId}/high`
    },
    artist: entry.illustrator || undefined,
    localId
  };
  if (isPokemon) {
    card.hp = String(entry.hp);
    card.types = entry.type ? [entry.type] : undefined;
    const abilities = [];
    const attacks = [];
    for (const a of (entry.attacks || [])) {
      const aname = String(a.name || '').trim();
      const text = a.effect || '';
      if (aname.includes('[特性]')) {
        abilities.push({ name: aname.replace('[特性]', '').trim(), text, type: 'Ability' });
      } else if (aname) {
        const cost = (a.cost || []).map(energyTypeName).filter(Boolean);
        attacks.push({ name: aname, cost, convertedEnergyCost: cost.length, damage: String(a.damage || ''), text });
      }
    }
    if (abilities.length) card.abilities = abilities;
    if (attacks.length) card.attacks = attacks;
    if (entry.weakness && entry.weakness.type) card.weaknesses = [{ type: energyTypeName(entry.weakness.type), value: entry.weakness.value }];
    if (entry.resistance && entry.resistance.type) card.resistances = [{ type: energyTypeName(entry.resistance.type), value: entry.resistance.value }];
    if (entry.retreat && entry.retreat.type) {
      const n = retreatCount(entry.retreat.value);
      const t = energyTypeName(entry.retreat.type);
      if (n > 0) { card.retreatCost = Array(n).fill(t); card.convertedRetreatCost = n; }
    }
    if (entry.dexNo) card.nationalPokedexNumbers = [entry.dexNo];
    if (entry.flavor) card.flavorText = entry.flavor;
  } else {
    const effect = entry.effect || (entry.attacks && entry.attacks[0] && entry.attacks[0].effect) || '';
    if (effect) card.rules = [effect];
  }
  for (const k of Object.keys(card)) if (card[k] === undefined) delete card[k];
  return card;
}

// ---- iterate std-full ----
let legalityFixed = 0;
let nameNumDup = 0;
let added = 0;
let addedUnderNewSet = 0;
const addedIds = new Set();
const newSetCounts = new Map();
const imageSrc = path.join(DATA, 'std-images');
const imageDstRoot = path.join(DATA, 'images');
let imgOk = 0, imgMiss = 0;

for (const entry of std) {
  const nums = String(entry.collectorNumber || '').split(',').map(s => s.trim()).filter(Boolean);
  const sk = normSet(entry.product);
  for (const num of nums) {
    const key = `${sk}|${normNum(num)}`;
    // 1. exact key already in cache → legality fix only
    if (cacheKeyToIdx.has(key)) {
      const c = cache.data[cacheKeyToIdx.get(key)];
      if (!c.legalities) c.legalities = {};
      if (c.legalities.standard !== 'Legal') { c.legalities.standard = 'Legal'; legalityFixed++; }
      continue;
    }
    // 2. same name+number in any set → skip (already represented)
    const cname = cleanName(entry.name);
    if (cacheNameNum.has(`${cname}|${normNum(num)}`)) { nameNumDup++; continue; }
    // 3. add
    const card = toCard(entry, num);
    if (addedIds.has(card.id)) { continue; } // dup within std-full (same set+num twice)
    cache.data.push(card);
    addedIds.add(card.id);
    added++;
    if (card.set.id.startsWith('EXT')) {
      addedUnderNewSet++;
      newSetCounts.set(card.set.name, (newSetCounts.get(card.set.name) || 0) + 1);
    }
    // image copy
    const srcFile = entry.imageFile && fs.existsSync(entry.imageFile)
      ? entry.imageFile
      : path.join(imageSrc, `tw${String(entry.id).padStart(8, '0')}.png`);
    const dstDir = path.join(imageDstRoot, card.set.id);
    fs.mkdirSync(dstDir, { recursive: true });
    const dstFile = path.join(dstDir, `${card.localId}.png`);
    if (fs.existsSync(srcFile)) {
      if (!fs.existsSync(dstFile) || fs.statSync(srcFile).mtimeMs > fs.statSync(dstFile).mtimeMs) {
        fs.copyFileSync(srcFile, dstFile);
      }
      imgOk++;
    } else {
      imgMiss++;
      console.log('MISSING IMG for', card.id, srcFile);
    }
  }
}

cache.timestamp = Date.now();
fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');

const summary = {
  timestamp: cache.timestamp,
  stdEntries: std.length,
  cacheBefore: cache.data.length - added,
  added,
  addedUnderNewSet,
  legalityFixed,
  nameNumDup,
  imagesOk: imgOk,
  imagesMissing: imgMiss,
  newSets: unmatchedProducts.map(p => ({ id: newSetIdByProduct.get(p), product: p, count: productCount.get(p), added: newSetCounts.get(p) || 0 })),
  totalAfter: cache.data.length
};
fs.writeFileSync(path.join(DATA, 'merge-std-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('=== MERGE STD-FULL SUMMARY ===');
console.log('std entries:', std.length);
console.log('added:', added, '(under new EXT sets:', addedUnderNewSet + ')');
console.log('legality fixed on existing:', legalityFixed);
console.log('skipped name+number dup:', nameNumDup);
console.log('images ok:', imgOk, 'missing:', imgMiss);
console.log('total cache now:', cache.data.length);
console.log('new sets:', newSetIdByProduct.size);
console.log('summary → server/data/merge-std-summary.json');
