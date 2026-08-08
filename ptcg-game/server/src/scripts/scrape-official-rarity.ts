/**
 * Scrape rarity codes for every official Standard-format card by ID.
 *
 * The official card detail page does NOT expose rarity anywhere in its
 * markup (verified by inspection). But the search form's rarity checkboxes
 * (rarity[]=1..21) let us filter results by rarity code, so we run one
 * paginated search per rarity value (under regulation=1 = Standard) and
 * record which card IDs come back — far cheaper than trying to scrape
 * rarity off 5,000+ individual detail pages (which isn't even possible).
 *
 * Output: data-scraped/official-rarity-map.json — { [id: number]: string }
 */
import * as fs from 'fs';
import * as path from 'path';

const SEARCH_URL = 'https://asia.pokemon-card.com/tw/card-search/list/';
const OUTPUT_DIR = path.resolve(__dirname, '../../../data-scraped');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'official-rarity-map.json');

const REQUEST_DELAY_MS = 150;

// value -> official short code, from the search form's rarity[] checkboxes
const RARITY_CODES: Record<number, string> = {
  1: 'C', 2: 'U', 3: 'R', 4: 'RR', 5: 'RRR', 6: 'PR', 7: 'TR', 8: 'SR',
  9: 'HR', 10: 'UR', 11: '無標記', 12: 'K', 13: 'A', 14: 'AR', 15: 'SAR',
  16: 'S', 17: 'SSR', 18: 'ACE', 19: 'BWR', 20: 'MUR', 21: 'MA',
};

async function fetchRarityPage(rarityValue: number, pageNo: number): Promise<{ ids: number[]; totalPages: number }> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `regulation=1&rarity%5B%5D=${rarityValue}&page=1&pageNo=${pageNo}`,
  });
  if (!res.ok) return { ids: [], totalPages: 0 };
  const html = await res.text();
  const ids = [...html.matchAll(/detail\/(\d+)\//g)].map(m => parseInt(m[1], 10));
  const pagesMatch = html.match(/resultTotalPages"[^>]*>[^\d]*(\d+)/);
  const totalPages = pagesMatch ? parseInt(pagesMatch[1], 10) : (ids.length > 0 ? pageNo : 0);
  return { ids: [...new Set(ids)], totalPages };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const rarityById = new Map<number, string>();

  for (const [valueStr, code] of Object.entries(RARITY_CODES)) {
    const value = parseInt(valueStr, 10);
    const first = await fetchRarityPage(value, 1);
    let ids = [...first.ids];
    const totalPages = first.totalPages;

    for (let p = 2; p <= totalPages; p++) {
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      const { ids: pageIds } = await fetchRarityPage(value, p);
      ids.push(...pageIds);
    }

    for (const id of ids) rarityById.set(id, code);
    console.log(`  ${code} (rarity[]=${value}): ${ids.length} cards across ${totalPages} page(s)`);
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  }

  const output: Record<number, string> = {};
  for (const [id, code] of rarityById) output[id] = code;

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nTotal unique IDs with rarity: ${rarityById.size}`);
  console.log(`Saved to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
