const cheerio = require('cheerio');
const fs = require('fs');

async function main() {
  // Fetch 3 card types: Pokémon, Trainer, Energy
  const urls = [
    ['19148', 'Pokémon'],
    ['3597', 'Trainer (觀光客)'],
    ['16556', 'Pokémon (another)'],
  ];

  for (const [id, label] of urls) {
    console.log(`\n\n========== ${label} (ID ${id}) ==========`);
    const res = await fetch(`https://asia.pokemon-card.com/tw/card-search/detail/${id}/`);
    const html = await res.text();
    
    // Save full HTML for analysis
    fs.writeFileSync(`tmp-card-${id}.html`, html);
    console.log(`HTML saved (${html.length} bytes)`);

    const $ = cheerio.load(html);

    // Show the main card detail area
    console.log('\n--- #detail, .detailBlock ---');
    $('#detail, .detailBlock').each((i, el) => {
      console.log(`[${i}] class="${$(el).attr('class')}"`);
      console.log($(el).text().trim().slice(0, 100));
    });

    // Show layout structure
    console.log('\n--- Main layout divs ---');
    $('.contentsInner > div, main > div, .wrapper > div, .commonInner').each((i, el) => {
      const cls = $(el).attr('class') || '';
      if (cls) {
        const text = $(el).text().trim().slice(0, 80);
        console.log(`div.${cls} [${text.length} chars] "${text}"`);
      }
    });

    // Show the info area
    console.log('\n--- .infoTxt, .detailTxt ---');
    $('.infoTxt, .detailTxt, .cardInfoWrap, .cardDetailWrap').each((i, el) => {
      console.log(`[${i}] class="${$(el).attr('class')}"`);
      console.log('  ', $(el).text().trim().slice(0, 300));
    });

    // Look for HP number
    console.log('\n--- Elements with HP in text ---');
    $('*').each((i, el) => {
      const text = $(el).text().trim();
      if (text.match(/^HP[ 　]*[0-9]+/)) {
        console.log(`<${el.type === 'tag' ? el.name : '?'} class="${$(el).attr('class') || ''}"> "${text}"`);
      }
    });

    // Look for retreat cost
    console.log('\n--- Elements with 撤退 in text ---');
    $('*').each((i, el) => {
      const text = $(el).text().trim();
      if (text.match(/撤退/) && text.length < 200) {
        console.log(`<${el.type === 'tag' ? el.name : '?'} class="${$(el).attr('class') || ''}"> "${text}"`);
      }
    });

    // Look for card number pattern (e.g. 001/165 or 006/165)
    console.log('\n--- Elements with card number patterns ---');
    $('*').each((i, el) => {
      const text = $(el).text().trim();
      if (text.match(/[0-9]{2,3}\/[0-9]{2,3}/)) {
        console.log(`<${el.type === 'tag' ? el.name : '?'} class="${$(el).attr('class') || ''}"> "${text}"`);
      }
    });

    // Look for regulation mark (H, I, J)
    console.log('\n--- Regulation mark (letter) ---');
    $('*').each((i, el) => {
      const text = $(el).text().trim();
      if (text.match(/^[HIJ]$/) && $(el).children().length === 0) {
        console.log(`<${el.type === 'tag' ? el.name : '?'} class="${$(el).attr('class') || ''}"> "${text}"`);
      }
    });
  }

  console.log('\n\n========== DONE ==========');
}

main().catch(console.error);
