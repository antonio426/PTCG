// Collect official card IDs: (A) default list = standard (regulation=1 default), (B) MEGA spPokemon=107, (C) keyword=超級
// POST body carries filters; pageNo in query string.
const BASE = 'https://asia.pokemon-card.com/tw/card-search/list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const fs = require('fs');
const OUT_DIR = __dirname + '/../data/audit';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function collect(label, bodyParams, maxPages = 400) {
  const ids = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const res = await fetch(`${BASE}?pageNo=${pageNo}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(bodyParams).toString()
    });
    const html = await res.text();
    const pageIds = [...html.matchAll(/card-search\/detail\/(\d+)\//g)].map(m => m[1]);
    if (pageIds.length === 0) { console.log(`${label}: page ${pageNo} empty, stop.`); break; }
    ids.push(...pageIds);
    if (pageIds.length < 20) { console.log(`${label}: page ${pageNo} had ${pageIds.length} (<20), stop.`); break; }
    if (pageNo % 25 === 0) console.log(`${label}: ${pageNo} pages, ${ids.length} ids so far`);
    await delay(150);
  }
  const uniq = [...new Set(ids)];
  console.log(`${label}: TOTAL ${ids.length} (unique ${uniq.length})`);
  return uniq;
}

(async () => {
  // A) default = standard (send empty regulation to be safe; default is regulation=1)
  const std = await collect('STANDARD', {});
  fs.writeFileSync(`${OUT_DIR}/official-std-ids.json`, JSON.stringify(std, null, 2));
  // B) MEGA (超級進化寶可夢ex)
  const mega = await collect('MEGA(spPokemon=107)', { regulation: 1, 'spPokemon[]': 107 });
  fs.writeFileSync(`${OUT_DIR}/official-mega-ids.json`, JSON.stringify(mega, null, 2));
  // C) keyword 超級
  const kw = await collect('KEYWORD=超級', { regulation: 1, keyword: '\u8d85\u7d1a' });
  fs.writeFileSync(`${OUT_DIR}/official-super-keyword-ids.json`, JSON.stringify(kw, null, 2));
  console.log('MEGA vs KEYWORD 超級 diff (in mega not kw):', mega.filter(x => !kw.includes(x)));
  console.log('diff (in kw not mega):', kw.filter(x => !mega.includes(x)));
})();
