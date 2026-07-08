/**
 * Check what h3 headers exist on official card pages.
 */
import * as https from 'https';
import * as cheerio from 'cheerio';

function fetchHtml(id: number): Promise<string> {
  return new Promise((res, rej) => {
    https.get(`https://asia.pokemon-card.com/tw/card-search/detail/${id}/`, (r) => {
      let d = '';
      r.on('data', (c: string) => d += c);
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

async function main() {
  const ids = [
    9761, 9762, 9763,   // SV5K cards
    17113, 17180,        // MC / trainer deck cards
    14885,               // SV8a
    7335,                // SVHM
    1063,                // SV1a
    16721,               // SV10
  ];

  for (const id of ids) {
    try {
      const html = await fetchHtml(id);
      const $ = cheerio.load(html);
      const h3 = $('h3.commonHeader').first().text().trim();
      const evo = $('.evolveMarker').first().text().trim();
      const name = $('.commonDetailHeader h2').first().text().trim();
      const set = $('.expansionLinkColumn a').first().text().trim();
      console.log(`ID=${id} name="${name}" h3="${h3}" evo="${evo}" set="${set}"`);
    } catch (e: any) {
      console.log(`ID=${id} ERROR: ${e.message}`);
    }
  }
}

main().catch(e => console.error(e));
