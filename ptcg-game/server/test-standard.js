const https = require('https');

const normId = (id) => id.toLowerCase().replace(/^0+/, '').replace(/-0+/g, '-');

// Check the matching logic: fetch first few cards from zh-tw and English standard
Promise.all([
  new Promise(resolve => {
    https.get('https://api.tcgdex.net/v2/zh-tw/cards', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
  }),
  new Promise(resolve => {
    https.get('https://api.tcgdex.net/v2/en/cards?legal.standard=true', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
  })
]).then(([zhCards, enCards]) => {
  const enStd = new Set(enCards.map(c => normId(c.id)));
  console.log('English standard cards:', enCards.length);

  // Check first 10 zh-tw cards
  zhCards.slice(0, 10).forEach(c => {
    const nid = normId(c.id);
    const match = enStd.has(nid);
    console.log(c.id + ' -> ' + nid + ' -> ' + (match ? 'STANDARD' : 'not standard'));
  });

  // Total matching count
  const totalMatch = zhCards.filter(c => enStd.has(normId(c.id))).length;
  console.log('Total zh-tw cards matching standard:', totalMatch, 'out of', zhCards.length);

  // Show some non-matching zh-tw cards
  const nonMatching = zhCards.filter(c => !enStd.has(normId(c.id))).slice(0, 10);
  console.log('Non-matching examples:');
  nonMatching.forEach(c => console.log('  ' + c.id + ' (set: ' + c.set?.id + ') localId: ' + c.localId));
});
