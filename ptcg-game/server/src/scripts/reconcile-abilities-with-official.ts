/**
 * Reconciles `abilities` on cards.json against the official card pages.
 *
 * The stored scrape (`scraped-cards-all.json`) was produced by a parser that dropped every
 * 「[特性] 」-prefixed skill block — the bug CLAUDE.md records as fixed in the SCRIPT, while the
 * captured FILE was never re-run. So the file carried almost no abilities (18 of 5160 records),
 * and any check against it read as "our abilities are unsupported" when the truth was "the scrape
 * never had them". Re-scrape first, then run this.
 *
 * Two directions, deliberately treated differently:
 *  - MISSING: the page shows an ability we don't have -> add it. The page is the authority and the
 *    addition is safe.
 *  - UNSUPPORTED: we hold an ability the page doesn't show. That IS a real defect (振翼髮 SV8-059
 *    carries 暗夜羽擊, an ability-negation effect that its printed card does not have — the live
 *    page contains no such text), but removing data needs more care than adding it, so it only
 *    happens with --remove-unsupported and only when the page parsed cleanly enough to list at
 *    least one skill.
 *
 * Run: npx tsx src/scripts/reconcile-abilities-with-official.ts [--apply] [--remove-unsupported]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const apply = process.argv.includes('--apply');
const removeUnsupported = process.argv.includes('--remove-unsupported');

const file = JSON.parse(fs.readFileSync(CARDS, 'utf-8')) as { timestamp?: number; data: MapCard[] };
const scraped = JSON.parse(fs.readFileSync(SCRAPED, 'utf-8'));
const official: any[] = Array.isArray(scraped) ? scraped : (scraped.data ?? []);

const numOf = (n: unknown) => {
  const m = String(n ?? '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const keyOf = (c: any) => {
  const set = c.set?.id;
  const num = numOf(String(c.number ?? '').split('/')[0]);
  return set && num !== null ? `${String(set).toLowerCase()}-${num}` : null;
};
const clean = (n: unknown) => String(n ?? '').replace(/[​‌‍\s]/g, '').replace(/^\[特性\]/, '');

const officialByKey = new Map<string, any>();
for (const c of official) {
  const k = keyOf(c);
  if (k && !officialByKey.has(k)) officialByKey.set(k, c);
}

let added = 0, removed = 0, agreed = 0, unmatched = 0, unsupported = 0;
const addedExamples: string[] = [];
const unsupportedExamples: string[] = [];

for (const card of file.data) {
  if (card.supertype !== 'Pokémon') continue;
  if (card.legalities?.standard !== 'Legal') continue;
  const k = keyOf(card);
  const off = k ? officialByKey.get(k) : undefined;
  if (!off) { unmatched++; continue; }
  // A page with no skill block at all was not parsed usefully — it says nothing either way.
  const skillCount = (off.attacks?.length ?? 0) + (off.abilities?.length ?? 0);
  if (skillCount === 0) { unmatched++; continue; }

  const theirs = (off.abilities ?? []) as { name: string; text: string; type?: string }[];
  const ourNames = new Set((card.abilities ?? []).map(a => clean(a.name)));
  const theirNames = new Set(theirs.map(a => clean(a.name)));

  const missing = theirs.filter(a => !ourNames.has(clean(a.name)));
  if (missing.length > 0) {
    if (addedExamples.length < 12) addedExamples.push(`${card.id} ${card.name} += ${missing.map(a => a.name).join(', ')}`);
    card.abilities = [...(card.abilities ?? []), ...missing.map(a => ({ name: a.name.trim(), text: a.text ?? '', type: 'Ability' as const }))];
    added += missing.length;
  }

  const extra = (card.abilities ?? []).filter(a => !theirNames.has(clean(a.name)));
  if (extra.length > 0) {
    unsupported++;
    if (unsupportedExamples.length < 15) unsupportedExamples.push(`${card.id} ${card.name}: ${extra.map(a => a.name).join(', ')}`);
    if (removeUnsupported) {
      card.abilities = (card.abilities ?? []).filter(a => theirNames.has(clean(a.name)));
      if (card.abilities.length === 0) delete card.abilities;
      removed += extra.length;
    }
  } else if (missing.length === 0) {
    agreed++;
  }
}

console.log(`abilities added from the official page: ${added}`);
console.log(`prints holding an ability the page does not show: ${unsupported}${removeUnsupported ? ` (removed ${removed})` : ' (reported only)'}`);
console.log(`prints already in agreement: ${agreed}`);
console.log(`no usable official record: ${unmatched}`);
if (addedExamples.length) {
  console.log('\nadded:');
  for (const e of addedExamples) console.log('  ' + e);
}
if (unsupportedExamples.length) {
  console.log('\nunsupported (verify against the live page before removing):');
  for (const e of unsupportedExamples) console.log('  ' + e);
}

if (apply) {
  fs.writeFileSync(CARDS, JSON.stringify(file, null, 2), 'utf-8');
  console.log(`\nwritten -> ${CARDS}`);
} else {
  console.log('\n(dry run — pass --apply to write)');
}
