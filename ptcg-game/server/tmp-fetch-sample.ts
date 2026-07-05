import * as cheerio from 'cheerio';

async function main() {
  // Test with a Pokémon card (蘭螳花ex ID 19148)
  const res = await fetch('https://asia.pokemon-card.com/tw/card-search/detail/19148/');
  const html = await res.text();
  const $ = cheerio.load(html);

  console.log('=== FULL HTML KEY SECTIONS ===');

  // Card name
  console.log('\n--- Title ---');
  console.log($('title').text().trim());

  // Common header (name)
  console.log('\n--- commonHeader ---');
  console.log($('.commonHeader').text().trim());

  // HP
  console.log('\n--- hitPoint ---');
  console.log($('.hitPoint').text().trim());

  // Energy type icons
  console.log('\n--- Energy Images ---');
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('energy') || src.includes('Energy')) {
      console.log(`  [${i}]`, src, 'alt:', $(el).attr('alt'));
    }
  });

  // All skill blocks
  console.log('\n--- Skill Blocks ---');
  $('.skillBlock, .skillBlock01, .skillBlock02, [class*="skill"]').each((i, el) => {
    const cls = $(el).attr('class') || '';
    if (cls.includes('skill')) {
      console.log(`\n[${i}] class=${cls}`);
      console.log($(el).text().trim().slice(0, 500));
    }
  });

  // Sub information (weakness, resistance, retreat)
  console.log('\n--- subInformation ---');
  console.log($('.subInformation').text().trim().slice(0, 300));

  // Evolve marker
  console.log('\n--- evolveMarker ---');
  console.log($('.evolveMarker').text().trim());

  // Card number / regulation mark
  console.log('\n--- Card Info area ---');
  // Try various selectors
  $('.cardInfo, .infoTxt, .detailTxt, .dataBlock, .cardNumber, .regulationMark, .regulation').each((i, el) => {
    console.log(`[${i}] class=${$(el).attr('class')}`, $(el).text().trim().slice(0, 200));
  });

  // Look for regulation mark in text
  console.log('\n--- Text containing レギュ or 標準 or 規制 ---');
  $('*').each((i, el) => {
    const text = $(el).text().trim();
    if (text.match(/[レ規制]|Regulation|regulation/)) {
      const tag = el.tagName;
      const cls = $(el).attr('class') || '';
      if (tag !== 'html' && tag !== 'body' && tag !== 'head') {
        console.log(`<${tag} class="${cls}">`, text.slice(0, 200));
      }
    }
  });

  // Image URL
  console.log('\n--- Main Card Image ---');
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('card-img') || src.includes('cardimg')) {
      console.log(`[${i}]`, src);
    }
  });

  // Expansion/set info
  console.log('\n--- Expansion Links ---');
  $('a[href*="expansion"]').each((i, el) => {
    console.log(`[${i}]`, $(el).attr('href'), $(el).text().trim());
  });

  // Any image with expansion in name
  console.log('\n--- Expansion Images ---');
  $('img').each((i, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('expansion') || src.includes('Expansion') || src.includes('exp_')) {
      console.log(`[${i}]`, src, 'alt:', $(el).attr('alt'));
    }
  });
}

main().catch(console.error);
