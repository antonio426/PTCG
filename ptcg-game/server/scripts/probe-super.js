// probe-super.js — verify official "超級" keyword search counts under different filters
const base = 'https://asia.pokemon-card.com/tw/card-search/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function post(body) {
  const r = await fetch(base + 'list/', {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return r.text();
}

function extractIds(html) {
  return [...html.matchAll(/card-search\/detail\/(\d+)\//g)].map((m) => m[1]);
}

(async () => {
  const variants = [
    { label: 'kw=超級 + reg=1', body: { keyword: '超級', regulation: '1' } },
    { label: 'kw=超級 + reg=1 + cardType=1(Pokemon)', body: { keyword: '超級', regulation: '1', cardType: '1' } },
    { label: 'kw=超級 (no reg)', body: { keyword: '超級' } },
    { label: 'spPokemon[]=107 + reg=1', body: { regulation: '1', 'spPokemon[]': '107' } },
  ];
  for (const v of variants) {
    const h = await post(v.body);
    const ids = extractIds(h);
    const uniq = new Set(ids);
    const pag = h.includes('class="pagination"');
    console.log(v.label, '| page1 ids:', ids.length, '| unique:', uniq.size, '| hasPagination:', pag);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
