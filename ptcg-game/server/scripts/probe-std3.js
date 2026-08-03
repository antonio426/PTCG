// Determine how the official site applies the standard (regulation=1) filter.
const BASE = 'https://asia.pokemon-card.com/tw/card-search/list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(label, url, init) {
  const res = await fetch(url, init);
  const html = await res.text();
  const cards = (html.match(/<li class="card"/g) || []).length;
  const ids = [...html.matchAll(/card-search\/detail\/(\d+)\//g)].map(m => m[1]);
  const pages = [...new Set([...html.matchAll(/pageNo=(\d+)/g)].map(m => m[1]))];
  console.log(`${label}: status ${res.status} cards ${cards} firstIds ${ids.slice(0,5)} pages ${pages.slice(0,6)}`);
}

(async () => {
  // A) POST regulation=1 at page 269: if standard=5343 (268 pages of 20), page 269 empty
  await probe('POST {regulation:1} p269', `${BASE}?pageNo=269`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 1 }).toString()
  });
  // B) POST regulation=1 p268 (last page if 5343)
  await probe('POST {regulation:1} p268', `${BASE}?pageNo=268`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ regulation: 1 }).toString()
  });
  // C) POST keyword=超級 NO regulation, p1 (all-regulations 超級)
  await probe('POST {keyword:超級} p1', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ keyword: '\u8d85\u7d1a' }).toString()
  });
  // D) GET with query-string state as pagination hrefs use (regulation=1&spPokemon[0]=107)
  const qs = new URLSearchParams({ pageNo: 1, regulation: 1, 'spPokemon[0]': 107 });
  await probe('GET qs spPokemon[0]=107', `${BASE}?${qs}`, { headers: { 'User-Agent': UA } });
  // E) GET keyword=超級&regulation=1 (plain query)
  const qs2 = new URLSearchParams({ pageNo: 1, regulation: 1, keyword: '\u8d85\u7d1a' });
  await probe('GET qs keyword', `${BASE}?${qs2}`, { headers: { 'User-Agent': UA } });
  // F) POST keyword=超級&regulation=1&cardType=all (browser-like full form)
  await probe('POST full-form kw+reg', `${BASE}?pageNo=1`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ keyword: '\u8d85\u7d1a', regulation: 1, cardType: 'all' }).toString()
  });
})();
