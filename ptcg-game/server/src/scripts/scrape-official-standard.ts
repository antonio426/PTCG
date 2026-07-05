import * as fs from 'fs';
import * as path from 'path';

const SEARCH_URL = 'https://asia.pokemon-card.com/tw/card-search/list/';
const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail';

/** Results saved outside the server data dir so it never mixes with TCGdex cache */
const OUTPUT_DIR = path.resolve(__dirname, '../../../data-scraped');
const CARDS_FILE = path.join(OUTPUT_DIR, 'official-standard-cards.json');
const IDS_FILE = path.join(OUTPUT_DIR, 'official-standard-ids.json');

interface OfficialCard {
  id: number;
  name: string;
  regulation: string;
  expansionCode: string;
  cardNumber: string;
}

interface IdOnly {
  id: number;
}

const TOTAL_PAGES = 258;
const PAGE_SIZE = 20;
const DETAIL_CONCURRENCY = 10;
const REQUEST_DELAY_MS = 200;

/** Fetch one search page and extract card detail links */
async function fetchCardIdsFromPage(pageNo: number): Promise<IdOnly[]> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `regulation=1&page=1&pageNo=${pageNo}`,
  });
  if (!res.ok) {
    console.warn(`  Page ${pageNo}: HTTP ${res.status} — skipping`);
    return [];
  }
  const html = await res.text();
  const ids: IdOnly[] = [];
  const regex = /detail\/(\d+)\//g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    ids.push({ id: parseInt(match[1], 10) });
  }
  return ids;
}

/** Fetch card detail page and extract info */
async function fetchCardDetail(id: number): Promise<OfficialCard | null> {
  try {
    const res = await fetch(`${DETAIL_BASE}/${id}/`);
    if (!res.ok) return null;
    const html = await res.text();

    // Card name from breadcrumb: <li class="current">NAME</li>
    const nameMatch = html.match(/<li class="current">\s*([^<]+?)\s*<\/li>/);
    if (!nameMatch) return null;  // no name = not a real card detail page
    let name = nameMatch[1].trim();
    if (!name) return null;
    // Decode HTML entities like &lt; and &gt; that the TW site uses for trainer-owned Pokemon
    name = name.replace(/&lt;/g, '').replace(/&gt;/g, '');

    // Regulation mark: <span class="alpha">J</span>
    const regMatch = html.match(/<span class="alpha">\s*([A-Z])\s*<\/span>/);
    const regulation = regMatch ? regMatch[1] : '?';

    // Card number: <span class="collectorNumber">001/081</span>
    const cardNumMatch = html.match(/<span class="collectorNumber">\s*([^<]+?)\s*<\/span>/);
    const cardNumber = cardNumMatch ? cardNumMatch[1] : '';

    // Expansion code from image: twhk_exp_M5.png → M5
    const expMatch = html.match(/twhk_exp_([A-Za-z0-9]+)\.png/);
    const expansionCode = expMatch ? expMatch[1] : '';

    return { id, name, regulation, expansionCode, cardNumber };
  } catch {
    return null;
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── Phase 1: Collect all card IDs from all search pages ──
  console.log('=== Phase 1: Collecting card IDs from 258 search pages ===');
  const allIds = new Set<number>();

  for (let pageNo = 1; pageNo <= TOTAL_PAGES; pageNo++) {
    const ids = await fetchCardIdsFromPage(pageNo);
    for (const { id } of ids) allIds.add(id);
    if (pageNo % 10 === 0 || pageNo === TOTAL_PAGES) {
      console.log(`  Page ${pageNo}/${TOTAL_PAGES}: ${allIds.size} unique IDs collected`);
    }
    // Brief delay to be polite
    if (pageNo < TOTAL_PAGES) {
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  const sortedIds = [...allIds].sort((a, b) => a - b);
  console.log(`\nTotal unique card IDs from standard search: ${sortedIds.length}`);
  console.log(`  Range: ${sortedIds[0]} – ${sortedIds[sortedIds.length - 1]}`);

  // Save intermediate ID list
  fs.writeFileSync(IDS_FILE, JSON.stringify(sortedIds, null, 2), 'utf-8');
  console.log(`  Saved IDs to ${IDS_FILE}`);

  // ── Phase 2: Fetch detail pages for every card ──
  console.log('\n=== Phase 2: Fetching card details ===');
  const cards: OfficialCard[] = [];
  let failed = 0;
  let emptyPages = 0;

  for (let i = 0; i < sortedIds.length; i += DETAIL_CONCURRENCY) {
    const batch = sortedIds.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(id => fetchCardDetail(id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        cards.push(result.value);
      } else {
        failed++;
      }
    }

    // Check if this batch looks like non-card pages (all null)
    const allNull = results.every(r => r.status === 'fulfilled' && r.value === null);
    if (allNull) emptyPages++;

    const done = Math.min(i + DETAIL_CONCURRENCY, sortedIds.length);
    if (done % 200 === 0 || done >= sortedIds.length) {
      const progressPct = (done / sortedIds.length * 100).toFixed(1);
      console.log(`  Progress: ${done}/${sortedIds.length} (${progressPct}%) — Collected: ${cards.length}, Failed: ${failed}${allNull ? ' (all-null batch)' : ''}`);
    }

    // Rate limiting delay
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\n=== Phase 2 Complete ===`);
  console.log(`  Total IDs processed: ${sortedIds.length}`);
  console.log(`  Cards collected: ${cards.length}`);
  console.log(`  Failed/empty: ${failed}`);
  console.log(`  All-null batches: ${emptyPages}`);

  // ── Save results ──
  const output = {
    totalSearchPages: TOTAL_PAGES,
    totalCardIds: sortedIds.length,
    collected: cards.length,
    failed,
    emptyPages,
    cards,
  };

  fs.writeFileSync(CARDS_FILE, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n  Saved results to ${CARDS_FILE}`);

  // ── Summary statistics ──
  const regDist: Record<string, number> = {};
  let unnamed = 0;
  for (const card of cards) {
    if (!card.name) { unnamed++; continue; }
    regDist[card.regulation] = (regDist[card.regulation] || 0) + 1;
  }

  console.log('\n=== Regulation Mark Distribution ===');
  for (const [reg, count] of Object.entries(regDist).sort()) {
    console.log(`  ${reg === '?' ? 'unknown' : reg}: ${count}`);
  }
  if (unnamed > 0) console.log(`  (no name extracted): ${unnamed}`);

  // Simple cross-reference estimate
  const totalStdExpected = cards.length;
  console.log(`\nTotal standard cards collected: ${totalStdExpected}`);
  console.log(`TCGdex zh-tw total: 7436`);
  console.log(`Currently marked standard: ~1459`);
  console.log(`Gap to investigate: ${totalStdExpected - 1459}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
