// Probe official card-search list endpoint: POST vs GET, pagination structure.
const BASE = 'https://asia.pokemon-card.com/tw/card-search/list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(label, url, init) {
  const res = await fetch(url, init);
  const html = await res.text();
  const cards = (html.match(/<li class="card"/g) || []).length;
  const ids = [...html.matchAll(/card-search\/detail\/(\d+)\//g)].map(m => m[1]);
  const pages = [...new Set([...html.matchAll(/pageNo=(\d+)/g)].map(m => m[1]))];
  // pagination markup
  let pager = '';
  const pi = html.search(/pager|pagination|paging/i);
  if (pi >= 0) pager = html.slice(pi, pi + 600).replace(/\s+/g, ' ').slice(0, 400);
  console.log(`=== ${label} ===`);
  console.log(`status ${res.status} bytes ${html.length} cards ${cards} firstIds ${ids.slice(0,3)} pages ${pages.slice(0,8)}`);
  if (pager) console.log(`pager: ${pager}`);
  console.log();
}

(async () => {
  // sanity: GET with expansionCodes=M6 (known to work)
  await probe('GET expansionCodes=M6 p1', `${BASE}?pageNo=1&expansionCodes=M6`, { headers: { 'User-Agent': UA } });
  // GET no params
  await probe('GET no params', `${BASE}`, { headers: { 'User-Agent': UA } });
  // POST regulation=1 p1
  await probe('POST regulation=1 p1', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 1 }).toString()
  });
  // POST regulation=1 spPokemon=107 p1
  await probe('POST regulation=1 spPokemon=107 p1', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 1, 'spPokemon[]': 107 }).toString()
  });
  // POST regulation=1 keyword=超級 p1
  await probe('POST regulation=1 keyword=超級 p1', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 1, keyword: '\u8d85\u7d1a' }).toString()
  });
  // POST regulation=all keyword=超級 p1
  await probe('POST regulation=all keyword=超級 p1', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 'all', keyword: '\u8d85\u7d1a' }).toString()
  });
})();
