/**
 * Batch download all card images to local cache.
 *
 * Usage:
 *   npx tsx scripts/download-all-images.ts
 *
 * This script fetches all cards from the local API, then triggers the
 * image proxy for each card's small (low) and large (high) images.
 * The proxy caches everything locally under server/data/images/ .
 *
 * For cards where the CDN has no image, the proxy falls back to the
 * Pokemon Asia official site (by card name search).
 *
 * Flags:
 *   --high-only   Only download high-res images (skip low)
 *   --concurrency=N  Max parallel downloads (default 5)
 *   --api-base=URL   API base URL (default http://localhost:3001)
 */

import * as http from 'http';

const API_BASE = process.argv.find(a => a.startsWith('--api-base='))?.split('=')[1] || 'http://localhost:3001';
const CONCURRENCY = parseInt(
  process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '5',
  10
);
const HIGH_ONLY = process.argv.includes('--high-only');

interface CardImage {
  small: string;
  large: string;
}

interface ApiCard {
  id: string;
  images: CardImage;
}

function apiGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get(`${API_BASE}${path}`, (res) => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${path}: ${(data + '').slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function fetchImageAndWait(url: string): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve) => {
    http.get(`${API_BASE}${url}`, (res) => {
      // Read the body to completion (needed for proxy to write cache)
      let data: Buffer[] = [];
      res.on('data', (c: Buffer) => data.push(c));
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0 });
      });
    }).on('error', (e) => resolve({ ok: false, status: 0 }));
  });
}

async function main() {
  console.log(`Fetching cards from ${API_BASE}/api/cards ...`);
  const cards: ApiCard[] = await apiGet('/api/cards');
  console.log(`Found ${cards.length} cards`);

  // Deduplicate by image URL
  // Always download the high variant (the proxy caches it for both low and high requests)
  const seenUrls = new Set<string>();
  const tasks: { id: string; url: string; variant: string }[] = [];

  for (const card of cards) {
    const url = card.images.large;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    tasks.push({ id: card.id, url, variant: 'high' });
  }

  console.log(`Unique image URLs to download: ${tasks.length}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  // Process in batches with concurrency control
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(t => fetchImageAndWait(t.url).then(r => ({ task: t, result: r })))
    );

    for (const { task, result } of results) {
      if (result.ok) {
        downloaded++;
      } else if (result.status === 404) {
        failed++;
      } else {
        skipped++;
      }
    }

    const pct = Math.min(100, Math.round((i + batch.length) / tasks.length * 100));
    process.stdout.write(`\rProgress: ${pct}% (${i + batch.length}/${tasks.length}) - Downloaded: ${downloaded}, Failed: ${failed}, Skipped: ${skipped}  `);
  }

  console.log('\n');
  console.log('=== Download Complete ===');
  console.log(`Total unique URLs: ${tasks.length}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed (404): ${failed}`);
  console.log(`Skipped (errors): ${skipped}`);

  // Summary: count by set
  const cardSet = new Map<string, { total: number; ok: number }>();
  for (const card of cards) {
    const setId = card.id.split('-')[0];
    if (!cardSet.has(setId)) cardSet.set(setId, { total: 0, ok: 0 });
    cardSet.get(setId)!.total++;
    // Check if images exist locally
  }

  console.log(`\nSets with potential missing images (check locally):`);
  for (const [setId, info] of cardSet) {
    if (info.ok < info.total) {
      console.log(`  ${setId}: ${info.ok}/${info.total} images`);
    }
  }
}

main().catch(console.error);
