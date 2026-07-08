/**
 * Sample all unique h3 header values from scraped cards.
 * Reads official-standard-cards.json to get all card IDs,
 * then fetches a random sample to discover h3 values.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as cheerio from 'cheerio';

const OFFICIAL_DATA = path.resolve(__dirname, '../../../data-scraped/official-standard-cards.json');

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
  const raw = JSON.parse(fs.readFileSync(OFFICIAL_DATA, 'utf-8'));
  const allIds: number[] = raw.cards.map((c: any) => c.id).sort((a: number, b: number) => a - b);
  console.log(`Total: ${allIds.length} cards`);

  // Sample every 50th card (about 100 cards)
  const step = Math.max(1, Math.floor(allIds.length / 100));
  const sampleIds = allIds.filter((_, i) => i % step === 0).slice(0, 100);
  console.log(`Sampling ${sampleIds.length} cards (step=${step})`);

  const results: Record<string, number> = {};
  const evoResults: Record<string, number> = {};
  const combos: Record<string, number> = {};
  const errors: number[] = [];

  for (let i = 0; i < sampleIds.length; i++) {
    const id = sampleIds[i];
    try {
      const html = await fetchHtml(id);
      const $ = cheerio.load(html);
      const h3 = $('h3.commonHeader').first().text().trim();
      const evo = $('.evolveMarker').first().text().trim();
      results[h3] = (results[h3] || 0) + 1;
      if (evo) evoResults[evo] = (evoResults[evo] || 0) + 1;
      const key = `${h3} | evo:${evo || '(none)'}`;
      combos[key] = (combos[key] || 0) + 1;
    } catch (e: any) {
      errors.push(id);
    }
    if ((i + 1) % 20 === 0) console.log(`  Progress: ${i + 1}/${sampleIds.length}`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n=== h3 distribution ===');
  Object.entries(results).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  "${k}": ${v}`));

  console.log('\n=== Evolve markers ===');
  Object.entries(evoResults).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  "${k}": ${v}`));

  console.log('\n=== h3 + evo combos ===');
  Object.entries(combos).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  "${k}": ${v}`));

  if (errors.length) console.log(`\nErrors: ${errors.length} (IDs: ${errors.slice(0, 10).join(',')})`);
}

main().catch(e => console.error('FATAL:', e));
