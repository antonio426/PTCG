// diff-std-full.js — reconcile our cards-final.json (7551) against official standard 5343 (std-full.json)
// Match key: (product, collectorNumber-no-suffix) — the unique identity of an official standard card.
// Outputs: server/data/audit/std-diff-report.json + prints summary.

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const official = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8')); // bare array, 5343
const cacheWrap = JSON.parse(fs.readFileSync(path.join(DATA, 'cards-final.json'), 'utf8')); // {timestamp, data}
const cache = cacheWrap.data;

// normalize collectorNumber '003/076' -> '003'; '071/076 , 072/076' -> '071' (take first) ; '142/157' -> '142'
function normNum(n) {
  if (n == null) return '';
  const s = String(n).trim();
  const first = s.split(',')[0].trim();
  const slash = first.split('/')[0];
  return slash.split('-')[0].trim();
}

// normalize set name: strip 擴充包「」/強化擴充包「」/高級擴充包「」 wrappers + ALL whitespace
// e.g. '擴充包「純白閃焰」' -> '純白閃焰'; '挑戰牌組 「超級蒂安希ex」' -> '挑戰牌組「超級蒂安希ex」'
function normSet(name) {
  if (name == null) return '';
  let s = String(name).replace(/[「」]/g, '').replace(/(擴充包|強化擴充包|高級擴充包)/g, '');
  s = s.replace(/\s+/g, '');
  return s;
}

// Build official keyed map: key = normSet(product)|normNum -> list of official entries (dup rarities)
const offByKey = new Map();
for (const c of official) {
  const key = `${normSet(c.product)}|${normNum(c.collectorNumber)}`;
  if (!offByKey.has(key)) offByKey.set(key, []);
  offByKey.get(key).push(c);
}

// Build cache keyed map: key = normSet(set.name)|normNum(card.number) -> list of cache entries
const cacheByKey = new Map();
for (const c of cache) {
  const key = `${normSet(c.set?.name)}|${normNum(c.number)}`;
  if (!cacheByKey.has(key)) cacheByKey.set(key, []);
  cacheByKey.get(key).push(c);
}

// 1) Official keys missing entirely from cache (need to be added)
const missingKeys = [];
const matchedKeys = [];
for (const [key, offList] of offByKey) {
  const cList = cacheByKey.get(key);
  if (!cList || cList.length === 0) missingKeys.push({ key, officialCount: offList.length, sample: offList[0] });
  else matchedKeys.push({ key, officialCount: offList.length, cacheCount: cList.length, cacheIds: cList.map((x) => x.id) });
}

// 2) Cache cards marked standard Legal whose key is NOT in official standard (should not be Legal)
const cacheLegalNotInStd = [];
for (const c of cache) {
  if (c.legalities?.standard === 'Legal') {
    const key = `${normSet(c.set?.name)}|${normNum(c.number)}`;
    if (!offByKey.has(key)) {
      cacheLegalNotInStd.push({ id: c.id, name: c.name, set: c.set?.name, number: c.number, regulationMark: c.regulationMark });
    }
  }
}

// 3) Duplicate official pairs (same product+number twice = different rarity/version) — how many cache entries exist
const dupKeys = [...offByKey.entries()].filter(([, v]) => v.length > 1);
const dupDetail = dupKeys.map(([key, offList]) => ({
  key,
  officialCount: offList.length,
  officialNames: [...new Set(offList.map((o) => o.name))],
  cacheCount: cacheByKey.get(key)?.length || 0,
  cacheIds: (cacheByKey.get(key) || []).map((x) => x.id),
}));

const report = {
  officialTotal: official.length,
  cacheTotal: cache.length,
  officialUniqueKeys: offByKey.size,
  missingKeys: missingKeys.length,
  missingCards: missingKeys.reduce((s, k) => s + k.officialCount, 0),
  matchedKeys: matchedKeys.length,
  matchedCards: matchedKeys.reduce((s, k) => s + k.officialCount, 0),
  cacheLegalNotInStd: cacheLegalNotInStd.length,
  dupOfficialPairs: dupKeys.length,
  missingSample: missingKeys.slice(0, 50).map((m) => ({ key: m.key, officialCount: m.officialCount, name: m.sample.name, category: m.sample.category, collectorNumber: m.sample.collectorNumber, product: m.sample.product })),
  dupDetail: dupDetail.slice(0, 100),
};

fs.writeFileSync(path.join(DATA, 'audit', 'std-diff-report.json'), JSON.stringify(report, null, 2));

// console summary (ASCII-safe)
console.log('officialTotal:', official.length);
console.log('cacheTotal:', cache.length);
console.log('officialUniqueKeys:', offByKey.size);
console.log('missingKeys (official cards absent from cache):', missingKeys.length, '=>', report.missingCards, 'cards');
console.log('matchedKeys:', matchedKeys.length, '=>', report.matchedCards, 'cards');
console.log('cacheLegalNotInStd (marked Legal but not official std):', cacheLegalNotInStd.length);
console.log('dupOfficialPairs (same product+number, diff rarity):', dupKeys.length);
console.log('--- first 20 missing ---');
for (const m of report.missingSample.slice(0, 20)) {
  console.log(`  ${m.key} | ${m.category} | ${m.collectorNumber} | officialCount=${m.officialCount}`);
}
console.log('WROTE', path.join(DATA, 'audit', 'std-diff-report.json'));
