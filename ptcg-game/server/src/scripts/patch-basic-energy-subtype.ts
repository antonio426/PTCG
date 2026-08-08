/**
 * Fix Basic Energy cards mislabeled with subtypes ['Special Energy'] instead of
 * ['Basic Energy'] — root cause was scrape-missing-card-data.ts unconditionally
 * assigning 'Special Energy' to any card whose header text contained "能量",
 * without checking the "基本X能量" naming pattern. Also grants them
 * legalities.standard = 'Legal' since Basic Energy cards are always Standard-legal
 * regardless of regulation mark / print.
 *
 * Run with: npx tsx src/scripts/patch-basic-energy-subtype.ts
 */
import fs from 'fs';
import path from 'path';

const BASIC_ENERGY_RE = /^基本[【\[]([^】\]]+)[】\]]能量$/;

function patchFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    console.log(`skip (not found): ${filePath}`);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const isWrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.data;
  const list: any[] = isWrapped ? raw.data : raw;
  const cards: any[] = Array.isArray(list) ? list : Object.values(list);

  let patched = 0;
  for (const c of cards) {
    if (c.supertype === 'Energy' && BASIC_ENERGY_RE.test(c.name || '') && !(c.subtypes || []).includes('Basic Energy')) {
      c.subtypes = ['Basic Energy'];
      c.legalities = { ...(c.legalities || {}), standard: 'Legal' };
      patched++;
      console.log(`  patched ${c.id} ${c.name}`);
    }
  }

  console.log(`${filePath}: patched ${patched} cards`);
  if (patched > 0) {
    const out = isWrapped ? raw : list;
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf-8');
  }
}

const dataDir = path.join(__dirname, '..', '..', 'data');
patchFile(path.join(dataDir, 'cards.json'));
patchFile(path.join(dataDir, 'cards-final.json'));
