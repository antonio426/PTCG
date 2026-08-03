/** probe-list.js — dump M6 search list page card titles (id + title) */
const main = async () => {
  const out = [];
  for (let pageNo = 1; pageNo <= 4; pageNo++) {
    const url = `https://asia.pokemon-card.com/tw/card-search/list/?pageNo=${pageNo}&expansionCodes=M6`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    // find card list items
    const items = [...html.matchAll(/<a href="\/tw\/card-search\/detail\/(\d+)\/?"[^>]*>([\s\S]*?)<\/a>/g)];
    out.push(`--- page ${pageNo} (${items.length} links) ---`);
    for (const m of items) {
      const inner = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      out.push(`${m[1]} :: ${inner.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(out.join('\n'));
};
main().catch((e) => { console.error(e); process.exit(1); });
