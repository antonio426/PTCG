const https = require('https');
const cheerio = require('cheerio');

function fetchHtml(id) {
  return new Promise((res, rej) => {
    https.get(`https://asia.pokemon-card.com/tw/card-search/detail/${id}/`, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

async function main() {
  const ids = [9761, 9762, 9763, 17113, 17180, 14885, 7335, 1063, 16721];
  for (const id of ids) {
    try {
      const html = await fetchHtml(id);
      const $ = cheerio.load(html);
      const h3 = $('h3.commonHeader').first().text().trim();
      const evo = $('.evolveMarker').first().text().trim();
      const name = $('.commonDetailHeader h2').first().text().trim();
      const set = $('.expansionLinkColumn a').first().text().trim();
      console.log(`ID=${id} name="${name}" h3="${h3}" evo="${evo}" set="${set}"`);
    } catch (e) {
      console.log(`ID=${id} ERROR: ${e.message}`);
    }
  }
}

main().catch(e => console.error(e));
