/** probe-dual.js — inspect dual-card pages 19621-19623 (h1, skill header, effect) */
const main = async () => {
  for (const id of [19613, 19621, 19622, 19623]) {
    const res = await fetch(`https://asia.pokemon-card.com/tw/card-search/detail/${id}/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const h1 = html.match(/<h1 class="pageHeader cardDetail">([\s\S]*?)<\/h1>/);
    const h1text = h1 ? h1[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : 'NONE';
    const h3 = html.match(/<h3 class="commonHeader">([\s\S]*?)<\/h3>/);
    const h3text = h3 ? h3[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : 'NONE';
    const eff = html.match(/<p class="skillEffect">([\s\S]*?)<\/p>/);
    const efftext = eff ? eff[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) : 'NONE';
    const num = html.match(/<span class="collectorNumber">([\s\S]*?)<\/span>/);
    const numtext = num ? num[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : 'NONE';
    console.log(`${id} | h1=${h1text} | h3=${h3text} | num=${numtext}`);
    console.log(`   effect: ${efftext}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
