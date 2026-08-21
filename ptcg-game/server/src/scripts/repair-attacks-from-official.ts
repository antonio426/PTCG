/**
 * Repairs `attacks` on cards whose stored copy disagrees with the official card page.
 *
 * backfill-attacks-from-official.ts only ever fills an EMPTY attacks array, so it cannot see the
 * failure this fixes: a print that kept ONE attack carrying another one's energy cost. 赫拉克羅斯
 * M6-001 is the shape of it — the official page prints 扣殺抽出 (1 Grass, 20 damage) and 十萬馬力
 * (Grass/Grass/Colorless, 130), while cards.json holds a single 扣殺抽出 costing FOUR energy, i.e.
 * the first attack's name and damage with both attacks' costs concatenated. Every symptom of the
 * card is wrong from there: it can't be used when it should, the AI reads the wrong cost, and no
 * coverage or clause audit can tell, because they only ever see what is in the file.
 *
 * The official scrape is the authority for attacks here (it is per-skill and complete, verified
 * against the live page), but NOT for abilities — the site does not reliably mark them, so an
 * ability the official record lacks stays exactly as TCGdex has it.
 *
 * Matching is set+number only. The name-only fallback the other backfills allow is deliberately
 * not used: this REPLACES data rather than filling a hole, so a wrong match would destroy a card.
 *
 * Run: npx tsx src/scripts/repair-attacks-from-official.ts [--apply] [--limit N]
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED = path.resolve(__dirname, '../../data/scraped-cards-all.json');
const apply = process.argv.includes('--apply');
const limit = process.argv.includes('--limit') ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : Infinity;

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

/** Zero-width characters ride along in scraped names; the 「[特性] 」 prefix marks an ability. */
const clean = (n: unknown) => String(n ?? '').replace(/[​‌‍\s]/g, '');
const isAbilityEntry = (n: unknown) => /^\[特性\]/.test(clean(n));
// The marker is stored as 太晶 or [太晶] depending on the print — six cards kept a collapsed
// attack because only the bare form was recognised.
const isTeraMarker = (n: unknown) => clean(n) === '太晶' || clean(n) === '[太晶]';

const officialByKey = new Map<string, any>();
for (const c of official) {
  const k = keyOf(c);
  if (k && !officialByKey.has(k)) officialByKey.set(k, c);
}

/** Fullwidth and ASCII notation are both in the dataset already and the engine reads either
 * (parseBaseNumber accepts x and ×), so a difference of notation is NOT a data defect — comparing
 * without normalising made 1237 cards look broken when the real disagreements were a fraction of
 * that. */
const normalizeDamage = (d: unknown) => String(d ?? '').replace(/×/g, 'x').replace(/＋/g, '+').replace(/－/g, '-').trim();
const signature = (attacks: any[]) => attacks
  .map(a => `${clean(a.name)}|${(a.cost ?? []).join('+')}|${normalizeDamage(a.damage)}`)
  .join(' / ');

/** Every ability name this dataset knows for a card of that NAME — the official page does not
 * reliably mark abilities (骨紋巨聲鱷's 純樸 and <火箭隊的>鈴鐺響's 鈴鈴吵鬧 are both listed among its
 * "attacks"), so without this the repair would file abilities as attacks: the exact corruption
 * patch-skill-misclassification.ts was written to undo. */
const abilityNamesByCardName = new Map<string, Set<string>>();
for (const c of file.data) {
  for (const ab of c.abilities ?? []) {
    if (!abilityNamesByCardName.has(c.name)) abilityNamesByCardName.set(c.name, new Set());
    abilityNamesByCardName.get(c.name)!.add(clean(ab.name));
  }
}

let checked = 0, repaired = 0, unmatched = 0, agreed = 0, skippedNoCost = 0;
let skippedAbility = 0, skippedWouldLose = 0;
const examples: string[] = [];
const needsALook: string[] = [];

for (const card of file.data) {
  if (card.supertype !== 'Pokémon') continue;
  // --all extends the repair past the Standard pool. It finds nothing: the scrape is built from
  // the official site's STANDARD id list, so non-Standard prints have no official record to
  // compare against — repairing them needs a different source, not a wider filter.
  if (!process.argv.includes('--all') && card.legalities?.standard !== 'Legal') continue;
  const k = keyOf(card);
  if (!k) { unmatched++; continue; }
  const off = officialByKey.get(k);
  if (!off) { unmatched++; continue; }

  const theirs = (off.attacks ?? []).filter((a: any) => !isAbilityEntry(a.name) && !isTeraMarker(a.name) && clean(a.name));
  if (theirs.length === 0) continue;
  checked++;

  const ours = (card.attacks ?? []).filter(a => !isTeraMarker(a.name));
  if (signature(ours) === signature(theirs)) { agreed++; continue; }

  // The official page renders energy costs as images; a scrape that captured none of them for this
  // card would otherwise "repair" a real cost into nothing. Zero-cost attacks are real (含羞苞,
  // 阿羅拉 三地鼠…), so the guard is "they lost EVERY cost while we have some", not "any missing".
  const theirTotalCost = theirs.reduce((n: number, a: any) => n + (a.cost?.length ?? 0), 0);
  const ourTotalCost = ours.reduce((n: number, a: any) => n + (a.cost?.length ?? 0), 0);
  if (theirTotalCost === 0 && ourTotalCost > 0) { skippedNoCost++; continue; }

  const knownAbilities = abilityNamesByCardName.get(card.name);
  if (knownAbilities && theirs.some((a: any) => knownAbilities.has(clean(a.name)))) { skippedAbility++; continue; }

  // Never delete an attack we hold and they do not list: this replaces the array wholesale, and a
  // one-sided scrape must not be allowed to erase a real attack. Those go to the report instead.
  //
  // The 太晶 marker is the exception, and skipping it wholesale was itself a bug: it comes from
  // TCGdex and the official page never lists it, so 88 prints whose ONLY unmatched entry was the
  // marker were skipped entirely and kept their collapsed attack. The marker is carried across
  // instead — the engine reads it (canAttack refuses a damage-less marker), so it must survive.
  const theirNames = new Set(theirs.map((a: any) => clean(a.name)));
  const marker = ours.filter(a => isTeraMarker(a.name));
  const wouldLose = ours.filter(a => !theirNames.has(clean(a.name)) && !isTeraMarker(a.name));
  if (wouldLose.length > 0) {
    skippedWouldLose++;
    if (needsALook.length < 15) needsALook.push(`${card.id} ${card.name}: ours has ${wouldLose.map(a => clean(a.name)).join('/')}, official does not`);
    continue;
  }

  if (repaired < limit) {
    if (examples.length < 12) examples.push(`${card.id} ${card.name}\n    was: ${signature(ours) || '(none)'}\n    now: ${signature(theirs)}`);
    card.attacks = [
      ...marker,
      ...theirs.map((a: any) => ({
        name: String(a.name ?? '').replace(/[​‌‍]/g, '').trim(),
        cost: a.cost ?? [],
        convertedEnergyCost: (a.cost ?? []).length,
        damage: a.damage ?? '',
        text: a.text ?? '',
      })),
    ];
    repaired++;
  }
}

console.log(`Standard-legal Pokémon compared against the official page: ${checked}`);
console.log(`  already agreed: ${agreed}`);
console.log(`  repaired: ${repaired}`);
console.log(`  skipped (official scrape captured no energy costs at all): ${skippedNoCost}`);
console.log(`  skipped (official lists one of our ABILITIES as an attack): ${skippedAbility}`);
console.log(`  skipped (repair would drop an attack we hold): ${skippedWouldLose}`);
console.log(`  no official record for that set+number: ${unmatched}`);
if (needsALook.length) {
  console.log('\nneeds a manual look (we hold an attack the official page does not list):');
  for (const n of needsALook) console.log('  ' + n);
}
console.log('\nexamples:');
for (const e of examples) console.log('  ' + e);

if (apply) {
  fs.writeFileSync(CARDS, JSON.stringify(file, null, 2), 'utf-8');
  console.log(`\nwritten -> ${CARDS}`);
} else {
  console.log('\n(dry run — pass --apply to write)');
}
