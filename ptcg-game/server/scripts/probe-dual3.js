const u = 'https://asia.pokemon-card.com/tw/card-search/detail/19621/';
fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  .then(r => r.text())
  .then(h => {
    const h3s = [...h.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    console.log('ALL H3:', JSON.stringify(h3s));
    const allNumSpans = [...h.matchAll(/<span class="[^"]*collector[^"]*">([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    console.log('collector spans:', JSON.stringify(allNumSpans));
    const imgBlocks = [...h.matchAll(/<div class="cardImage[^"]*">([\s\S]*?)<\/div>/g)].map(m => m[1].slice(0, 300));
    console.log('imgBlocks count:', imgBlocks.length);
    imgBlocks.forEach((b, i) => console.log('imgBlock' + i + ':', b.replace(/\s+/g, ' ').slice(0, 200)));
    const main = h.match(/<main[\s\S]*?<\/main>/);
    const txt = main ? main[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    console.log('MAIN TEXT:', txt.slice(0, 1500));
  })
  .catch(e => console.log('ERR', e.message));
