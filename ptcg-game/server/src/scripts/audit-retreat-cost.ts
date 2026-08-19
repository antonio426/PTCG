/**
 * Cross-checks every card's retreat cost in cards.json (TCGdex) against the official
 * Traditional-Chinese card-search scrape (scraped-cards-all.json), which is an independent
 * source — TCGdex is wrong for individual prints (reported live on 幼基拉斯 SVM-062, printed
 * with 1 but stored as 2), and retreat cost is load-bearing: it gates canRetreat and the
 * energy the player has to discard.
 *
 * Matching reuses the established set+number strategy (see reconcile-official-data.ts):
 * set id + numeric part of the card number as the primary key, skipping rather than guessing
 * whenever a card can't be matched unambiguously.
 *
 * Read-only. Writes a report to data-scraped/retreat-cost-audit.json; apply fixes with
 * --apply, which patches cards.json in place.
 */
import * as fs from 'fs';
import * as path from 'path';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_ALL = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const OUT_DIR = path.resolve(__dirname, '../../../data-scraped');

interface AnyCard {
  id: string;
  name: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  set?: { id: string };
  number?: string;
  retreatCost?: string[];
  convertedRetreatCost?: number;
  legalities?: { standard?: string };
}

function parseNumerator(num: string): number | null {
  const m = num.match(/^0*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseTcgdexNumber(num: string): number | null {
  const m = num.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function key(setId: string | undefined, num: number | null): string | null {
  if (num === null || !setId) return null;
  return `${setId.toLowerCase()}-${num}`;
}

const normalizeName = (n: string | undefined) =>
  String(n ?? '').replace(/^[‌​\s]+/, '').replace(/^\[特性\]\s*/, '').trim();

/** Retreat cost as a plain count. Prefers the array length, which is what the game reads. */
function retreatOf(c: AnyCard): number | null {
  if (Array.isArray(c.retreatCost)) return c.retreatCost.length;
  if (typeof c.convertedRetreatCost === 'number') return c.convertedRetreatCost;
  return null;
}

function main() {
  const apply = process.argv.includes('--apply');
  const wrapper = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')) as { timestamp: number; data: AnyCard[] };
  const cards = wrapper.data;

  const scrapedRaw = JSON.parse(fs.readFileSync(SCRAPED_ALL, 'utf-8'));
  const scraped: AnyCard[] = Array.isArray(scrapedRaw) ? scrapedRaw : scrapedRaw.data;

  // Build the official index. A set+number that resolves to more than one scraped record is
  // ambiguous and dropped entirely rather than picking one — same caution as the other scripts.
  const byKey = new Map<string, AnyCard[]>();
  const add = (k: string | null, s: AnyCard) => {
    if (!k) return;
    const arr = byKey.get(k);
    if (arr) arr.push(s); else byKey.set(k, [s]);
  };
  for (const s of scraped) {
    if (retreatOf(s) === null) continue;
    add(key(s.set?.id, parseNumerator(s.number ?? '')), s);
    // Promos: the official site files them under set "SV" with a number like "110/SV-P", while
    // cards.json uses set "SV-P" and a number field of literally "P" — no digits at all, so the
    // normal key can never be built for them. Index them under an SV-P key taken from the
    // official number's prefix so the 175 promo cards are comparable at all.
    if (/\/SV-P$/i.test(String(s.number ?? ''))) add(key('SV-P', parseNumerator(s.number ?? '')), s);
  }

  // Secondary index for the name-only fallback (the same last-resort the backfill scripts use):
  // only usable when every official print of that name agrees on one retreat cost, since two
  // prints of the same Pokémon genuinely can differ.
  const retreatByName = new Map<string, Set<number>>();
  for (const s of scraped) {
    const r = retreatOf(s);
    if (r === null) continue;
    const n = normalizeName(s.name).replace(/[<>「」]/g, '');
    const set = retreatByName.get(n);
    if (set) set.add(r); else retreatByName.set(n, new Set([r]));
  }

  let checked = 0, missingOfficial = 0, ambiguous = 0, nameMismatch = 0, agree = 0;
  const nameOnly: { id: string; name: string; ours: number; official: number; standard: boolean }[] = [];
  const mismatches: {
    id: string; name: string; set: string; number: string; standard: boolean;
    ours: number; official: number; officialId: string;
  }[] = [];

  function tryNameOnly(c: AnyCard, ours: number): void {
    const vals = retreatByName.get(normalizeName(c.name).replace(/[<>「」]/g, ''));
    if (!vals || vals.size !== 1) return; // no official print, or they disagree -> can't say
    const only = [...vals][0];
    if (only === ours) return;
    nameOnly.push({ id: c.id, name: normalizeName(c.name), ours, official: only, standard: c.legalities?.standard === 'Legal' });
  }

  for (const c of cards) {
    // Only Pokémon have a retreat cost; Trainers/Energy legitimately have none.
    if (c.supertype !== 'Pokémon') continue;
    const ours = retreatOf(c);
    if (ours === null) continue;
    checked++;

    // Promo `number` is literally "P"; the printed number only survives in the id (SV-P-110).
    const ourNumber = c.set?.id === 'SV-P' ? c.id.replace(/^SV-P-/, '') : (c.number ?? '');
    const k = key(c.set?.id, parseTcgdexNumber(ourNumber));
    const candidates = k ? byKey.get(k) : undefined;
    if (!candidates) { missingOfficial++; tryNameOnly(c, ours); continue; }
    // A set+number can resolve to several scraped records because the official site lists art
    // variants of the same card separately. That's only ambiguous if they DISAGREE about the
    // retreat cost — when every candidate prints the same number, the card's retreat cost is
    // known regardless of which variant we matched, so use it rather than throwing the card away.
    const distinct = new Set(candidates.map(c => retreatOf(c)));
    if (distinct.size > 1) { ambiguous++; tryNameOnly(c, ours); continue; }

    const official = candidates[0];
    // The official record's own name must agree, or the set+number match is meaningless.
    // Official names carry an owner prefix on some prints (火箭隊的幼基拉斯 vs <火箭隊的>幼基拉斯),
    // so compare on containment in either direction rather than equality.
    const a = normalizeName(c.name).replace(/[<>「」]/g, '');
    const b = normalizeName(official.name).replace(/[<>「」]/g, '');
    if (!a.includes(b) && !b.includes(a)) { nameMismatch++; tryNameOnly(c, ours); continue; }

    const theirs = retreatOf(official)!;
    if (theirs === ours) { agree++; continue; }
    mismatches.push({
      id: c.id, name: normalizeName(c.name), set: c.set?.id ?? '?', number: c.number ?? '?',
      standard: c.legalities?.standard === 'Legal',
      ours, official: theirs, officialId: official.id,
    });
  }

  mismatches.sort((x, y) => Number(y.standard) - Number(x.standard) || x.id.localeCompare(y.id));
  const standardMismatches = mismatches.filter(m => m.standard);

  console.log(`Pokémon with a retreat cost in cards.json: ${checked}`);
  console.log(`  cross-checked against the official scrape: ${agree + mismatches.length}`);
  console.log(`    agree:    ${agree}`);
  console.log(`    MISMATCH: ${mismatches.length}  (${standardMismatches.length} Standard-legal)`);
  console.log(`  not comparable: ${missingOfficial} no official record, ${ambiguous} ambiguous set+number, ${nameMismatch} name disagreed`);

  if (standardMismatches.length > 0) {
    console.log('\nStandard-legal mismatches (ours -> official):');
    for (const m of standardMismatches) {
      console.log(`  ${m.id}\t${m.name}\t${m.ours} -> ${m.official}\t[${m.officialId}]`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'retreat-cost-audit.json'),
    JSON.stringify({ checked, agree, mismatches, nameOnly, notComparable: { missingOfficial, ambiguous, nameMismatch } }, null, 2),
    'utf-8',
  );
  const nameOnlyStd = nameOnly.filter(n => n.standard);
  console.log(`  name-only fallback (no usable set+number match, every official print of that name agrees): ${nameOnly.length} disagree (${nameOnlyStd.length} Standard-legal)`);
  for (const n of nameOnlyStd) console.log(`    ${n.id}\t${n.name}\t${n.ours} -> ${n.official}`);

  console.log('\nReport -> data-scraped/retreat-cost-audit.json');

  if (!apply) {
    console.log('Read-only. Re-run with --apply to write the official values into cards.json.');
    return;
  }

  const byId = new Map(cards.map(c => [c.id, c]));
  let patched = 0;
  const applyNameOnly = process.argv.includes('--apply-name-fallback');
  for (const m of [...mismatches, ...(applyNameOnly ? nameOnly.map(n => ({ ...n, set: '', number: '', officialId: '' })) : [])]) {
    const card = byId.get(m.id);
    if (!card) continue;
    // Retreat cost is always Colorless on every real card — the printed symbol is the count.
    card.retreatCost = Array.from({ length: m.official }, () => 'Colorless');
    card.convertedRetreatCost = m.official;
    patched++;
  }
  fs.writeFileSync(CARDS_CACHE, JSON.stringify({ ...wrapper, data: cards }, null, 2), 'utf-8');
  console.log(`Patched ${patched} cards in cards.json.`);
}

main();
