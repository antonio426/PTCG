// Re-collect official STANDARD list with regulation=1 filter (should be 5343).
const BASE = 'https://asia.pokemon-card.com/tw/card-search/list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const fs = require('fs');
const OUT_DIR = __dirname + '/../data/audit';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const delay = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const ids = [];
  for (let pageNo = 1; pageNo <= 400; pageNo++) {
    const res = await fetch(`${BASE}?pageNo=${pageNo}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ regulation: 1 }).toString()
    });
    const html = await res.text();
    const pageIds = [...html.matchAll(/card-search\/detail\/(\d+)\//g)].map(m => m[1]);
    if (pageIds.length === 0) { console.log(`page ${pageNo} empty, stop`); break; }
    ids.push(...pageIds);
    if (pageIds.length < 20) { console.log(`page ${pageNo} had ${pageIds.length}, stop`); break; }
    if (pageNo % 50 === 0) console.log(`${pageNo} pages, ${ids.length} ids`);
    await delay(120);
  }
  const uniq = [...new Set(ids)];
  console.log(`STANDARD total ${ids.length} unique ${uniq.length}`);
  fs.writeFileSync(`${OUT_DIR}/official-std-ids.json`, JSON.stringify(uniq, null, 2));
})();
