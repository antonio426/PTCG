// patch-std-remnants.js — add the 7 cards the gap-merge missed (all in 3 products:
// 起始組合「古代故勒頓ex」, 起始組合「未來密勒頓ex」, 牌組構築BOX黯焰支配者).
// For every std-full entry of these products: key absent locally → force-ADD.
// Also prints a diagnostic explaining why the key was skipped by merge-std-gap.
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '../data');
const std = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8'));
const FILES = ['cards-final.json', 'cards.json'];
const TARGET_PRODUCTS = ['起始組合「古代故勒頓ex」', '起始組合「未來密勒頓ex」', '牌組構築BOX黯焰支配者'];

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

function toCard(entry, num, cacheSet) {
  const name = cleanName(entry.name);
  const isPokemon = entry.category === '基礎' || entry.category === '1階進化' || entry.category === '2階進化';
  const subtypes = isPokemon
    ? (TYPE_OF[entry.category] ? [TYPE_OF[entry.category]] : [])
    : (TRAINER_SUBTYPE[entry.category] ? [TRAINER_SUBTYPE[entry.category]] : []);
  if (isPokemon && /ex$/.test(name)) subtypes.push('ex');
  const localId = num.split('/')[0].trim();
  const set = cacheSet
    ? { ...cacheSet }
    : {
        id: 'EXT00',
        name: decodeEntities(entry.product),
        series: 'SV',
        printedTotal: 0,
        total: 0,
        releaseDate: ''
      };
  const card = {
    id: `${set.id}-${localId}`,
    name,
    supertype: isPokemon ? 'Pokémon' : 'Trainer',
    subtypes,
    set,
    number: num,
    legalities: { standard: 'Legal' },
    images: {
      small: `/api/images/SV/${set.id}/${localId}/low`,
      large: `/api/images/SV/${set.id}/${localId}/high`
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

for (const fname of FILES) {
  const cachePath = path.join(DATA, fname);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const cacheSetByNorm = new Map();
  const cacheKeyToIdx = new Map();
  for (let i = 0; i < cache.data.length; i++) {
    const c = cache.data[i];
    if (!c.set) continue;
    const sk = normSet(c.set.name);
    if (!cacheSetByNorm.has(sk)) cacheSetByNorm.set(sk, c.set);
    cacheKeyToIdx.set(`${sk}|${normNum(c.number)}`, i);
  }

  let added = 0;
  let diagShown = false;
  for (const entry of std) {
    const p = normSet(entry.product);
    if (!TARGET_PRODUCTS.some(t => normSet(t) === p)) continue;
    const cacheSet = cacheSetByNorm.get(p);
    for (const num of String(entry.collectorNumber || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const key = `${p}|${normNum(num)}`;
      if (cacheKeyToIdx.has(key)) continue;
      if (!diagShown) {
        diagShown = true;
        console.log(`DIAG: product='${entry.product}' num='${entry.collectorNumber}' key='${key}' cacheSetByNorm=${!!cacheSet} cacheSetId=${cacheSet ? cacheSet.id : '(none)'} file=${fname}`);
      }
      const card = toCard(entry, num, cacheSet);
      cache.data.push(card);
      cacheKeyToIdx.set(key, cache.data.length - 1);
      added++;
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
      } else {
        console.log('MISSING IMG for', card.id, srcFile);
      }
    }
  }
  cache.timestamp = Date.now();
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`=== ${fname} === added: ${added} | total now: ${cache.data.length}`);
}
