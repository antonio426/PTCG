// merge-std-gap.js — fill the 3718-card gap caused by merge-std-full.js's global
// (cleanName|normNum) dedup, which wrongly skipped legitimate NEW-SET prints
// (e.g. 深淵之瞳 001/081 熱帶龍 was skipped because 熱帶龍|001 existed in old SV1a).
// Strategy: for each std-full entry, key = normSet(product)|normNum(collectorNumber).
//   - key already in local cache → ensure legalities.standard='Legal'
//   - else → ADD new MapCard (same toCard mapping as merge-std-full.js).
// NO cross-set name dedup. Applies to cards-final.json AND cards.json.
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '../data');
const std = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8')); // bare array
const FILES = ['cards-final.json', 'cards.json'];

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

const imageSrc = path.join(DATA, 'std-images');
const imageDstRoot = path.join(DATA, 'images');

for (const fname of FILES) {
  const cachePath = path.join(DATA, fname);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); // {timestamp, data}

  // ---- index cache ----
  const cacheSetByNorm = new Map();
  const cacheKeyToIdx = new Map();
  for (let i = 0; i < cache.data.length; i++) {
    const c = cache.data[i];
    if (!c.set) continue;
    const sk = normSet(c.set.name);
    if (!cacheSetByNorm.has(sk)) cacheSetByNorm.set(sk, c.set);
    cacheKeyToIdx.set(`${sk}|${normNum(c.number)}`, i);
  }

  // ---- new set ids for products absent locally ----
  const productCount = new Map();
  for (const e of std) {
    const p = normSet(e.product);
    productCount.set(p, (productCount.get(p) || 0) + 1);
  }
  const unmatchedProducts = [...new Set(std.map(e => normSet(e.product)))].filter(p => !cacheSetByNorm.has(p));
  unmatchedProducts.sort((a, b) => (productCount.get(b) || 0) - (productCount.get(a) || 0));
  const newSetIdByProduct = new Map();
  unmatchedProducts.forEach((p, i) => newSetIdByProduct.set(p, `EXT${String(i + 1).padStart(2, '0')}`));

  function resolveSetId(product) {
    const p = normSet(product);
    if (cacheSetByNorm.has(p)) return cacheSetByNorm.get(p).id;
    return newSetIdByProduct.get(p);
  }

  // build MapCard from std-full entry + num (same mapping as merge-std-full.js)
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

  let added = 0;
  let ensuredLegal = 0;
  let imgOk = 0;
  let imgMiss = 0;
  const addedIds = new Set();

  for (const entry of std) {
    const nums = String(entry.collectorNumber || '').split(',').map(s => s.trim()).filter(Boolean);
    const sk = normSet(entry.product);
    for (const num of nums) {
      const key = `${sk}|${normNum(num)}`;
      if (cacheKeyToIdx.has(key)) {
        const c = cache.data[cacheKeyToIdx.get(key)];
        if (!c.legalities) c.legalities = {};
        if (c.legalities.standard !== 'Legal') { c.legalities.standard = 'Legal'; ensuredLegal++; }
        continue;
      }
      const card = toCard(entry, num);
      if (addedIds.has(card.id)) continue; // dup within std-full (same set+num twice)
      cache.data.push(card);
      addedIds.add(card.id);
      added++;
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
  console.log(`=== ${fname} ===`);
  console.log('added:', added, '| ensuredLegal:', ensuredLegal, '| imagesOk:', imgOk, '| imagesMissing:', imgMiss, '| total now:', cache.data.length);
}
