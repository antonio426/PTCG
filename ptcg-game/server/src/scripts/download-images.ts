import * as fs from 'fs';
import * as path from 'path';
import { fetchAllSets, fetchAllCards } from '../card-api/tcgdex';

const CDN = 'https://assets.tcgdex.net';

const IMAGES_DIR = path.resolve(__dirname, '../../data/images');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  if (fs.existsSync(dest)) return true; // already downloaded
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('Loading sets...');
  const sets = await fetchAllSets();
  console.log(`Loaded ${sets.length} sets`);

  // Build a set-id → set mapping quickly by re-fetching from API with detail
  // (fetchAllSets returns minimal data, we need the raw set for details)
  // Instead, just use the card data which has set.id in each card

  console.log('Loading all cards...');
  const cards = await fetchAllCards();
  console.log(`Loaded ${cards.length} cards`);

  ensureDir(IMAGES_DIR);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const card of cards) {
    const setId = card.set.id;
    const localId = card.localId;
    const setDir = path.join(IMAGES_DIR, setId);
    ensureDir(setDir);

    const destPath = path.join(setDir, `${localId}.png`);

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      skipped++;
      continue;
    }

    // Correct format: https://assets.tcgdex.net/zh-tw/{setId}/{localId}/high.png
    const imageUrl = `${CDN}/zh-tw/${setId}/${localId}/high.png`;
    const ok = await downloadImage(imageUrl, destPath);

    if (ok) {
      downloaded++;
    } else {
      failed++;
      console.warn(`Failed: ${card.id} (${card.name})`);
    }

    if ((downloaded + failed + skipped) % 200 === 0) {
      console.log(`Progress: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped`);
    }
  }

  console.log(`\nDone! ${downloaded} downloaded, ${failed} failed, ${skipped} skipped`);
}

main().catch(console.error);
