/** probe-card-li.js — dump one full <li class="card"> item from M6 list page 4 */
const main = async () => {
  const res = await fetch('https://asia.pokemon-card.com/tw/card-search/list/?pageNo=4&expansionCodes=M6', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();
  const idx = html.indexOf('class="card"');
  console.log('first li index:', idx);
  // print surrounding region after first <li class="card">
  const liStart = html.indexOf('<li class="card">', idx - 200);
  const slice = html.slice(liStart, liStart + 1800);
  console.log(slice);
};
main().catch((e) => { console.error(e); process.exit(1); });
