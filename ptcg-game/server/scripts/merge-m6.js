// merge-m6.js — merge scraped-m6.json (73 official detail entries) into cards-final.json as MapCard records
// - splits the 3 dual-card pages into 6 Stadium halves (M6-071..M6-076)
// - copies m6-images/tw{id}.png → data/images/M6/{localId}.png
// - id format M6-{localId}; set M6 擴充包「綠寶石風暴」; regulationMark J; legalities.standard Legal
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '../data');
const scraped = JSON.parse(fs.readFileSync(path.join(DATA, 'scraped-m6.json'), 'utf8'));
const cachePath = path.join(DATA, 'cards-final.json');
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); // {timestamp, data}

const SET = { id: 'M6', name: '擴充包「綠寶石風暴」', series: 'SV', printedTotal: 76, total: 76, releaseDate: '2026-07-31' };
const PREFIX_RE = /^(基礎|1階進化|2階進化)\s*/;
const TYPE_OF = { '基礎': 'Basic', '1階進化': 'Stage 1', '2階進化': 'Stage 2' };
const TRAINER_SUBTYPE = { '物品卡': 'Item', '寶可夢道具': 'Pokémon Tool', '支援者卡': 'Supporter', '競技場卡': 'Stadium' };

function energyTypeName(type) {
  // type may be bare 'Colorless' or full path 'various_images/energy/Colorless.png'
  if (!type) return null;
  const m = String(type).match(/([A-Za-z]+)\.png$/);
  return m ? m[1] : type;
}
function retreatCount(value) {
  const m = String(value || '').match(/×(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function toCards(entry) {
  // split dual pages: collectorNumber '071/076 , 072/076' → 2 cards; else 1
  const nums = String(entry.collectorNumber).split(',').map(s => s.trim()).filter(Boolean);
  return nums.map(num => {
    const name = String(entry.name).replace(PREFIX_RE, '');
    const isPokemon = entry.category === '基礎' || entry.category === '1階進化' || entry.category === '2階進化';
    const subtypes = isPokemon
      ? (TYPE_OF[entry.category] ? [TYPE_OF[entry.category]] : [])
      : (TRAINER_SUBTYPE[entry.category] ? [TRAINER_SUBTYPE[entry.category]] : []);
    if (isPokemon && /ex$/.test(name)) subtypes.push('ex');
    const localId = num.split('/')[0].trim();
    const card = {
      id: `M6-${localId}`,
      name,
      supertype: isPokemon ? 'Pokémon' : 'Trainer',
      subtypes,
      set: SET,
      number: num,
      legalities: { standard: 'Legal' },
      regulationMark: 'J',
      images: {
        small: `/api/images/SV/M6/${localId}/low`,
        large: `/api/images/SV/M6/${localId}/high`
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
        const name = String(a.name || '').trim();
        const text = a.effect || '';
        if (name.includes('[特性]')) {
          abilities.push({ name: name.replace('[特性]', '').trim(), text, type: 'Ability' });
        } else if (name) {
          const cost = (a.cost || []).map(energyTypeName).filter(Boolean);
          attacks.push({ name, cost, convertedEnergyCost: cost.length, damage: String(a.damage || ''), text });
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
      // trainer / stadium: rules text
      const effect = entry.effect || (entry.attacks && entry.attacks[0] && entry.attacks[0].effect) || '';
      if (effect) card.rules = [effect];
    }
    // drop undefined keys
    for (const k of Object.keys(card)) if (card[k] === undefined) delete card[k];
    return card;
  });
}

// 1. build new cards
const newCards = [];
for (const entry of scraped) {
  for (const c of toCards(entry)) {
    if (!c.rules && !c.attacks && !c.abilities && c.supertype === 'Trainer') {
      // guard: trainer must have rules
      c.rules = c.rules || [];
    }
    newCards.push(c);
  }
}
console.log('built', newCards.length, 'cards (expect 76)');

// 2. copy images: m6-images/tw{id}.png → images/M6/{localId}.png
const srcDir = path.join(DATA, 'm6-images');
const dstDir = path.join(DATA, 'images', 'M6');
fs.mkdirSync(dstDir, { recursive: true });
let imgOk = 0, imgMiss = 0;
const idToNum = {};
for (const e of scraped) {
  const nums = String(e.collectorNumber).split(',').map(s => s.trim());
  nums.forEach((n, i) => { idToNum[n.split('/')[0].trim()] = { id: e.id, idx: i }; });
}
for (const c of newCards) {
  const srcFile = path.join(srcDir, `tw${String(idToNum[c.localId] ? idToNum[c.localId].id : '').padStart(8, '0')}.png`);
  // idToNum stores {id, idx}; recompute source id directly
}
// simpler: map localId → scraped entry id via collectorNumber
const localIdToEntryId = {};
for (const e of scraped) {
  for (const n of String(e.collectorNumber).split(',').map(s => s.trim())) {
    localIdToEntryId[n.split('/')[0].trim()] = e.id;
  }
}
for (const c of newCards) {
  const srcId = localIdToEntryId[c.localId];
  const srcFile = path.join(srcDir, `tw${String(srcId).padStart(8, '0')}.png`);
  const dstFile = path.join(dstDir, `${c.localId}.png`);
  if (fs.existsSync(srcFile)) {
    if (!fs.existsSync(dstFile) || fs.statSync(srcFile).mtimeMs > fs.statSync(dstFile).mtimeMs) {
      fs.copyFileSync(srcFile, dstFile);
    }
    imgOk++;
  } else {
    console.log('MISSING IMG for', c.id, srcFile);
    imgMiss++;
  }
}
console.log(`images: ${imgOk} ok, ${imgMiss} missing`);

// 3. merge into cards-final.json
const existingIds = new Set(cache.data.map(c => c.id));
let added = 0, updated = 0;
for (const c of newCards) {
  if (existingIds.has(c.id)) {
    const idx = cache.data.findIndex(x => x.id === c.id);
    cache.data[idx] = c;
    updated++;
  } else {
    if (!c.legalities) c.legalities = {};
    cache.data.push(c);
    added++;
  }
}
cache.timestamp = Date.now();
fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
const summary = { timestamp: cache.timestamp, total: cache.data.length, added, updated, newCardIds: newCards.map(c => c.id) };
fs.writeFileSync(path.join(DATA, 'M6-merge-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`merged: +${added} added, ${updated} updated, total now ${cache.data.length}`);
