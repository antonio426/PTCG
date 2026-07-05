const cheerio = require('cheerio');

async function main() {
  const res = await fetch('https://asia.pokemon-card.com/tw/card-search/detail/19148/');
  const html = await res.text();
  const $ = cheerio.load(html);

  console.log('=== FULL HTML KEY SECTIONS ===\n');

  console.log('--- Title ---');
  console.log($('title').text().trim(), '\n');

  console.log('--- .commonHeader (card name) ---');
  console.log($('.commonHeader').text().trim(), '\n');

  console.log('--- .hitPoint (HP) ---');
  console.log($('.hitPoint').text().trim(), '\n');

  console.log('--- Energy Images (type) ---');
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('energy') || src.includes('Energy')) {
      console.log(`  [${i}] ${src}  alt="${$(el).attr('alt')}"`);
    }
  });

  console.log('\n--- Skill Blocks ---');
  $('[class*="skill"]').each((i, el) => {
    const cls = $(el).attr('class') || '';
    console.log(`\n[${i}] class="${cls}"`);
    console.log($(el).text().trim().slice(0, 500));
  });

  console.log('\n--- .subInformation (weak/resist/retreat) ---');
  console.log($('.subInformation').text().trim().slice(0, 500));

  console.log('\n--- .evolveMarker ---');
  console.log($('.evolveMarker').text().trim());

  console.log('\n--- Card Info sections ---');
  $('.cardInfo, .infoTxt, .detailTxt, .dataBlock, .cardNumber, .regulationMark, .regulation').each((i, el) => {
    console.log(`[${i}] class="${$(el).attr('class')}"`, $(el).text().trim().slice(0, 300));
  });

  console.log('\n--- Regulation mark (search text) ---');
  $('body *').each((i, el) => {
    const text = $(el).text().trim();
    if (text.match(/[レ規制]|Regulation/i) && text.length < 100 && text.length > 0) {
      const tag = el.type === 'tag' ? el.name : '?';
      const cls = $(el).attr('class') || '';
      if (tag !== 'html' && tag !== 'body' && tag !== 'head') {
        console.log(`<${tag} class="${cls}" /> "${text}"`);
      }
    }
  });

  console.log('\n--- Card Image URL ---');
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('card-img') || src.includes('cardimg')) {
      console.log(`[${i}] ${src}`);
    }
  });

  console.log('\n--- Expansion Info ---');
  $('a[href*="expansion"]').each((i, el) => {
    console.log(`[${i}] href="${$(el).attr('href')}" text="${$(el).text().trim()}"`);
  });
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('expansion') || src.includes('Expansion') || src.includes('exp_')) {
      console.log(`[${i}] ${src} alt="${$(el).attr('alt')}"`);
    }
  });

  console.log('\n=== DONE ===');
}

main().catch(console.error);
