// collect-super-full.js — definitive full-pagination counts for keyword=超級 & MEGA (spPokemon=107)
// Output: server/data/audit/super-counts.json  (per combo: total ids + first 200 ids)
// Method: POST page 1 (URLSearchParams body), then GET subsequent pages with bracket query syntax (proven working).

const BASE = 'https://asia.pokemon-card.com/tw/card-search/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'audit', 'super-counts.json');

const COMBOS = [
  { key: 'super_reg1', label: 'keyword=超級 regulation=1', params: { keyword: '超級', regulation: '1' } },
  { key: 'mega_reg1', label: 'spPokemon[]=107 regulation=1', params: { 'spPokemon[]': '107', regulation: '1' } },
  { key: 'super_pokemon_reg1', label: 'keyword=超級 cardType=1 regulation=1', params: { keyword: '超級', cardType: '1', regulation: '1' } },
  { key: 'super_all', label: 'keyword=超級 (no regulation)', params: { keyword: '超級' } },
];

const ID_RE = /card-search\/detail\/(\d+)\//g;

function extractIds(html) {
  const ids = [];
  let m;
  while ((m = ID_RE.exec(html)) !== null) ids.push(m[0].match(/\d+/)[0]);
  return ids;
}

function hasPagination(html) {
  return /class="pagination"/.test(html);
}

async function fetchPage(url, isPost, body) {
  const opts = {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' },
    redirect: 'follow',
  };
  if (isPost) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function collectCombo(combo) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(combo.params)) body.append(k, v);

  const allIds = [];
  let pageNo = 1;
  let lastLen = 0;

  // Page 1 via POST
  let html = await fetchPage(BASE + 'list/', true, body);
  let ids = extractIds(html);
  allIds.push(...ids);
  lastLen = ids.length;
  if (lastLen === 0) return { label: combo.label, total: 0, ids: [] };

  const pages = hasPagination(html) ? null : 1; // if no pagination element, only 1 page
  if (pages === 1) return { label: combo.label, total: allIds.length, ids: allIds };

  // Subsequent pages via GET with bracket query syntax
  while (lastLen === 20) {
    pageNo += 1;
    const qp = new URLSearchParams();
    for (const [k, v] of Object.entries(combo.params)) {
      // convert 'spPokemon[]' to 'spPokemon[0]' style for GET? The site used spPokemon%5B0%5D=107
      qp.append(k, v);
    }
    qp.set('pageNo', String(pageNo));
    const url = BASE + 'list/?' + qp.toString();
    html = await fetchPage(url, false, null);
    ids = extractIds(html);
    allIds.push(...ids);
    lastLen = ids.length;
    if (lastLen === 0) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  const unique = [...new Set(allIds)];
  return { label: combo.label, pagesFetched: pageNo, total: allIds.length, unique: unique.length, ids: unique.slice(0, 200) };
}

(async () => {
  const results = {};
  for (const combo of COMBOS) {
    try {
      const r = await collectCombo(combo);
      results[combo.key] = r;
      console.log(`[${combo.key}] ${r.label} => total=${r.total} unique=${r.unique}`);
    } catch (e) {
      console.log(`[${combo.key}] ERROR: ${e.message}`);
      results[combo.key] = { label: combo.label, error: e.message };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('WROTE', OUT);
})();
