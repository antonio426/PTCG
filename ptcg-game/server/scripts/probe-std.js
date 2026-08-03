// Probe official card-search list endpoint with GET params.
// Tests: regulation=1 (standard, no keyword), spPokemon=107 (MEGA), keyword=超級+regulation=1
const BASE = 'https://asia.pokemon-card.com/tw/card-search/list/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function probe(label, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}?${qs}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const html = await res.text();
  const cards = (html.match(/<li class="card"/g) || []).length;
  // look for total / result count indicators
  const totalMatches = html.match(/共[^<]{0,20}件/g) || [];
  const resultMatches = html.match(/検索結果[^<]{0,30}/g) || [];
  const pageMatches = html.match(/pageNo=\d+/g) || [];
  const pagination = [...new Set(pageMatches)].slice(0, 6);
  console.log(`=== ${label} ===`);
  console.log(`URL: ${url}`);
  console.log(`status: ${res.status}, bytes: ${html.length}`);
  console.log(`li.card count: ${cards}`);
  console.log(`total markers: ${JSON.stringify(totalMatches)}`);
  console.log(`result markers: ${JSON.stringify(resultMatches)}`);
  console.log(`pageNo refs: ${JSON.stringify(pagination)}`);
  // find any element that mentions 件/張/件数 near 検索/結果/件
  const m = html.match(/(?:[\u4e00-\u9fff]{0,8})(\d{1,6})\s*件/g) || [];
  console.log(`NN件 markers: ${JSON.stringify([...new Set(m)].slice(0,8))}`);
  console.log();
}

(async () => {
  await probe('standard regulation=1 page1', { pageNo: 1, regulation: 1 });
  await probe('MEGA spPokemon=107 page1', { pageNo: 1, regulation: 1, spPokemon: 107 });
  await probe('keyword 超級 regulation=1 page1', { pageNo: 1, regulation: 1, keyword: '\u8d85\u7d1a' });
  await probe('keyword 超級 regulation=all page1', { pageNo: 1, regulation: 'all', keyword: '\u8d85\u7d1a' });
})();
