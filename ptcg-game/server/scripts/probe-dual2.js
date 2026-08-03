const u = process.argv[2] || 'https://asia.pokemon-card.com/tw/card-search/detail/19621/';
fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } })
  .then(r => r.text())
  .then(h => {
    const h1 = h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    console.log('H1:', h1 ? h1[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'none');
    const cn = h.match(/<span class="collectorNumber">([\s\S]*?)<\/span>/);
    console.log('CN:', cn ? cn[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'none');
    const cardImgs = [...h.matchAll(/<img[^>]*src="([^"]*card-img[^"]*)"[^>]*>/g)].map(m => m[1]);
    console.log('CARD IMGS:', cardImgs.join(' | '));
    const skillNames = [...h.matchAll(/<span class="skillName">([\s\S]*?)<\/span>/g)].map(m => m[1].trim());
    console.log('SKILLNAMES:', JSON.stringify(skillNames));
    const commonHeader = h.match(/<h3 class="commonHeader">([\s\S]*?)<\/h3>/);
    console.log('COMMONHEADER:', commonHeader ? commonHeader[1].trim() : 'none');
    const products = [...h.matchAll(/expansionCodes=([A-Za-z0-9]+)[^>]*>([^<]+)<\/a>/g)].map(m => m[2].trim());
    console.log('PRODUCTS:', JSON.stringify(products));
  })
  .catch(e => console.log('ERR', e.message));
