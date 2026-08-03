// probe-cache-sets.js — inspect how our cache stores set.name/number for M-era cards vs official product strings
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const cache = JSON.parse(fs.readFileSync(path.join(DATA, 'cards-final.json'), 'utf8')).data;

// 1) sample a few M-era cards raw
for (const id of ['MBG-003', 'M1L-046', 'M5-063', 'M2a-092', 'MC-018', 'M6-001']) {
  const c = cache.find((x) => x.id === id);
  if (c) {
    console.log('CACHE', id, '| name=', JSON.stringify(c.name), '| number=', JSON.stringify(c.number), '| set.name=', JSON.stringify(c.set?.name), '| set.id=', JSON.stringify(c.set?.id), '| legalities=', JSON.stringify(c.legalities));
  } else {
    console.log('CACHE', id, 'NOT FOUND');
  }
}

// 2) distinct set names containing 超級/挑戰/特典/初階
const setNames = new Map();
for (const c of cache) {
  if (c.set?.name) setNames.set(c.set.name, (setNames.get(c.set.name) || 0) + 1);
}
console.log('\n--- cache set.name sample (first 40 of', setNames.size, ') ---');
let i = 0;
for (const [k, v] of setNames) {
  if (i++ >= 40) break;
  console.log(`  ${v} x ${JSON.stringify(k)}`);
}

// 3) any set.name containing 超級進化 or 綠寶石 or 挑戰牌組
console.log('\n--- sets containing 超級/綠寶石/挑戰/特典/深淵/忍者/烈獄/虛無 ---');
for (const [k, v] of setNames) {
  if (/超級|綠寶石|挑戰|特典|深淵|忍者|烈獄|虛無|勇氣|交響樂/.test(k)) {
    console.log(`  ${v} x ${JSON.stringify(k)}`);
  }
}
