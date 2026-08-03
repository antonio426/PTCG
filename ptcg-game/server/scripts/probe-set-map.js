// probe-set-map.js — map std-full.json official products → existing cache set ids
// Builds normSet(name) → cache set object map; reports which std-full products match
// an existing cache set (and which set id) vs which need a NEW generated set id.
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '../data');
const cache = JSON.parse(fs.readFileSync(path.join(DATA, 'cards-final.json'), 'utf8')); // {timestamp, data}
const std = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8')); // bare array 5342

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function normSet(name) {
  return decodeEntities(name)
    .replace(/[「」]/g, '')
    .replace(/^(擴充包|強化擴充包|高級擴充包)/, '')
    .replace(/\s+/g, '')
    .trim();
}
function normNum(n) {
  return String(n || '').trim().split('/')[0].trim();
}

// 1. cache set map: normSet(name) → first set object seen
const cacheSetMap = new Map();
const cacheSetById = new Map();
for (const c of cache.data) {
  if (!c.set) continue;
  const key = normSet(c.set.name);
  if (!cacheSetMap.has(key)) cacheSetMap.set(key, c.set);
  cacheSetById.set(c.set.id, c.set);
}

// 2. cache existing ids
const existingIds = new Set(cache.data.map(c => c.id));

// 3. products in std-full
const productStats = new Map(); // normSet(product) → {product, count, matchedSet}
for (const e of std) {
  const p = normSet(e.product);
  if (!productStats.has(p)) productStats.set(p, { product: e.product, count: 0 });
  productStats.get(p).count++;
}

// 4. classify products
const matched = [];
const unmatched = [];
for (const [key, st] of productStats) {
  const set = cacheSetMap.get(key);
  if (set) matched.push({ ...st, normKey: key, cacheSetId: set.id, cacheSetName: set.name });
  else unmatched.push({ ...st, normKey: key });
}
matched.sort((a, b) => b.count - a.count);
unmatched.sort((a, b) => b.count - a.count);

console.log('=== CACHE SET COUNT ===');
console.log('cache sets (unique normSet names):', cacheSetMap.size);
console.log('cache sets (unique ids):', cacheSetById.size);

console.log('\n=== STD-FULL PRODUCTS ===');
console.log('std-full entries:', std.length);
console.log('std-full distinct products:', productStats.size);
console.log('matched to cache set:', matched.length, '| unmatched (need new id):', unmatched.length);

console.log('\n=== MATCHED PRODUCTS (top 30 by count) ===');
for (const m of matched.slice(0, 30)) {
  console.log(`  ${m.cacheSetId.padEnd(10)} ${m.count}  ${m.product}`);
}

console.log('\n=== UNMATCHED PRODUCTS (need new set id) ===');
for (const u of unmatched) {
  console.log(`  ${u.count}  ${u.product}`);
}

// 5. estimated adds: for each std-full entry, potential id = {setId}-{localId}
let wouldAdd = 0, wouldSkip = 0;
const missingByProduct = new Map();
const seenIds = new Set();
for (const e of std) {
  const setKey = normSet(e.product);
  const set = cacheSetMap.get(setKey);
  const nums = String(e.collectorNumber || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const num of nums) {
    const localId = num.split('/')[0].trim();
    const setId = set ? set.id : `NEW:${setKey}`;
    const id = `${setId}-${localId}`;
    if (existingIds.has(id) || seenIds.has(id)) {
      wouldSkip++;
    } else {
      wouldAdd++;
      seenIds.add(id);
      const key = set ? set.id : '(new set)';
      missingByProduct.set(key, (missingByProduct.get(key) || 0) + 1);
    }
  }
}
console.log('\n=== ESTIMATED MERGE ===');
console.log('would SKIP (id already in cache or dup in std-full):', wouldSkip);
console.log('would ADD (new cards):', wouldAdd);
const missSorted = [...missingByProduct.entries()].sort((a, b) => b[1] - a[1]);
console.log('\nmissing by cache set id (top 30):');
for (const [id, n] of missSorted.slice(0, 30)) console.log(`  ${String(id).padEnd(10)} ${n}`);

const report = {
  cacheSetsByNormName: cacheSetMap.size,
  cacheSetsById: cacheSetById.size,
  stdEntries: std.length,
  stdProducts: productStats.size,
  matchedProducts: matched.length,
  unmatchedProducts: unmatched,
  matchedProductsDetail: matched,
  estimatedAdds: wouldAdd,
  estimatedSkips: wouldSkip,
  missingBySetId: [...missingByProduct.entries()].map(([id, n]) => ({ setId: id, missing: n })),
};
fs.writeFileSync(path.join(DATA, 'audit', 'set-map-probe.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\nreport → server/data/audit/set-map-probe.json');
