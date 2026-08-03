// probe-set-fuzzy.js — for each unmatched std-full product, find cache set names
// whose normSet is a substring/contains of the product normSet (near-miss detection)
const fs = require('fs');
const path = require('path');
const DATA = path.resolve(__dirname, '../data');
const cache = JSON.parse(fs.readFileSync(path.join(DATA, 'cards-final.json'), 'utf8'));
const std = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'std-full.json'), 'utf8'));
const probe = JSON.parse(fs.readFileSync(path.join(DATA, 'audit', 'set-map-probe.json'), 'utf8'));

function decodeEntities(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function normSet(name) {
  return decodeEntities(name)
    .replace(/[「」]/g, '')
    .replace(/^(擴充包|強化擴充包|高級擴充包)/, '')
    .replace(/\s+/g, '')
    .trim();
}

// cache set names by normSet (deduped)
const cacheSets = new Map(); // normSet -> {id, name}
for (const c of cache.data) {
  if (!c.set) continue;
  const k = normSet(c.set.name);
  if (!cacheSets.has(k)) cacheSets.set(k, { id: c.set.id, name: c.set.name });
}
const cacheNormNames = [...cacheSets.keys()];

console.log('=== NEAR-MISS CHECK: unmatched products vs cache set names ===');
for (const u of probe.unmatchedProducts) {
  const pn = normSet(u.product);
  // find cache norm names that share a significant substring
  const hits = [];
  for (const cn of cacheNormNames) {
    if (cn === pn) { hits.push(`EXACT:${cacheSets.get(cn).id}`); continue; }
    const long = pn.length >= cn.length ? pn : cn;
    const short = pn.length >= cn.length ? cn : pn;
    if (short.length >= 3 && long.includes(short)) {
      hits.push(`${cacheSets.get(cn).id}(${cn}${cn === pn ? '' : ' ⊂ ' + pn})`);
    }
  }
  if (hits.length) console.log(`\n${u.product} [${u.count}] → ${hits.join(' | ')}`);
  else console.log(`\n${u.product} [${u.count}] → (no cache near-match)`);
}
