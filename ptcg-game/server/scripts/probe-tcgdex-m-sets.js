// probe-tcgdex-m-sets.js — list TCGdex sets with M-prefix IDs, and check which local cache set IDs exist
(async () => {
  const UA = { 'User-Agent': 'Mozilla/5.0' };
  const r = await fetch('https://api.tcgdex.net/v2/zh-tw/sets', { headers: UA });
  const sets = await r.json();
  const m = sets.filter((s) => /^M/i.test(s.id));
  console.log('TCGdex M-prefix sets:', m.length);
  m.forEach((s) => console.log(s.id, '|', s.name, '|', s.total, '|', s.releaseDate));

  // what M-set ids does the local cache reference?
  const cache = require('../data/cards-final.json');
  const setIds = new Set(cache.data.map((c) => c.set && c.set.id));
  const mCache = [...setIds].filter((id) => /^M/i.test(id || '')).sort();
  console.log('local cache M set ids:', mCache.join(', '));
  const known = new Set(m.map((s) => s.id));
  console.log('local M ids NOT in tcgdex:', mCache.filter((id) => !known.has(id)).join(', ') || '(none)');
  // show one local card from each M set
  for (const id of mCache) {
    const c = cache.data.find((x) => x.set && x.set.id === id);
    if (c) console.log('sample', id, '->', c.id, c.name, c.set && c.set.name, c.number, c.regulationMark, c.legalities && c.legalities.standard);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
