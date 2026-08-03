/**
 * diff-mega.js — Diff official MEGA cards vs our local library.
 *
 * Inputs:
 *   server/data/audit/official-mega-details.json   (138 official MEGA, from collect-mega.js)
 *   server/data/cards-final.json                   (our 7551-card library)
 *   server/data/scraped-m6.json                    (73 M6 cards, includes 2 MEGA)
 *
 * Output: server/data/audit/mega-diff-report.json + console report
 *
 * Run from ptcg-game/server:  node scripts/diff-mega.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const outFile = path.join(AUDIT_DIR, 'mega-diff-report.json');

const official = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, 'official-mega-details.json'), 'utf-8'));
const local = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards-final.json'), 'utf-8')).data;
const m6 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'scraped-m6.json'), 'utf-8'));

// Strip whitespace AND leading evolve-marker prefix (基礎/1階進化/2階進化) so
// official names like "基礎 超級烈空坐ex" normalize to "超級烈空坐ex".
const cleanName = (n) => (n || '').replace(/\s+/g, '').replace(/^(基礎|1階進化|2階進化)/, '');

const isMega = (c) => c.supertype === 'Pokémon' && /^超級.*ex$/.test(cleanName(c.name));
const localMega = local.filter(isMega);
const localMegaNames = new Set(localMega.map((c) => cleanName(c.name)));

// M6 MEGA cards (not yet merged)
const m6Mega = m6.filter((c) => /^超級.*ex$/.test(cleanName(c.name)));
const m6MegaNames = new Set(m6Mega.map((c) => cleanName(c.name)));

// Official: unique names + per-name entries
const offNames = official.map((c) => cleanName(c.name));
const uniqueOfficialNames = [...new Set(offNames)].sort();

const missingNames = uniqueOfficialNames.filter(
  (n) => !localMegaNames.has(n) && !m6MegaNames.has(n)
);

const report = {
  officialCount: official.length,
  uniqueOfficialNames: uniqueOfficialNames.length,
  localMegaCount: localMega.length,
  m6MegaCount: m6Mega.length,
  localPlusM6Count: localMega.length + m6Mega.length,
  missingNameCount: missingNames.length,
  missingNames,
  officialByName: uniqueOfficialNames.map((n) => ({
    name: n,
    officialEntries: official.filter((c) => cleanName(c.name) === n).map((c) => ({
      id: c.id, collector: c.collectorNumber, product: c.product,
    })),
    inLocal: localMegaNames.has(n),
    inM6: m6MegaNames.has(n),
  })),
  localMega: localMega.map((c) => ({ id: c.id, name: c.name, number: c.number, set: c.set && c.set.name })),
  m6Mega: m6Mega.map((c) => ({ id: c.id, name: c.name, collector: c.collectorNumber, product: c.product })),
};

fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');

console.log(`=== MEGA DIFF REPORT ===`);
console.log(`Official MEGA entries : ${report.officialCount} (unique names: ${report.uniqueOfficialNames})`);
console.log(`Our local MEGA        : ${report.localMegaCount}`);
console.log(`M6-to-merge MEGA      : ${report.m6MegaCount}`);
console.log(`Missing MEGA names    : ${report.missingNameCount}`);
console.log(`\nMissing names:`);
report.missingNames.forEach((n) => {
  const entries = official.filter((c) => cleanName(c.name) === n);
  console.log(`  ${n} — ${entries.map((e) => `${e.collector} (${e.product})`).join(' | ')}`);
});
console.log(`\nFull report → ${outFile}`);
