/**
 * Repairs two ways a Pokémon's skills get mis-stored in `server/data/cards.json`.
 *
 * 1. NAMELESS ATTACKS. TCGdex ships placeholder `{cost: []}` attack entries for cards it hasn't
 *    filled in. Once the official backfill supplies the real skill, the placeholder stays behind
 *    as an attack with no name, no damage and no text — which the engine offers as a real, free,
 *    blank attack (getLegalMoves has no reason to doubt it).
 *
 * 2. ABILITIES FILED AS ATTACKS. The official page is the only source for the newest sets (MC-*
 *    is not in TCGdex at all), and it does NOT reliably print the 「[特性] 」 prefix that
 *    scrape-all-official-data.ts keys off: 骨紋巨聲鱷 MC-144's 純樸 renders as a plain `.skill`
 *    block with an empty cost and damage, exactly like a zero-cost attack. It was therefore
 *    merged in as an attack — and took the slot of the print's real attack (閃焰獨唱會), so that
 *    print both lost its ability and lost its attack.
 *
 *    The repair only fires on the reciprocal confirmation CLAUDE.md describes: another print of
 *    the SAME card name files the same skill as an ability, AND that print's attack matches the
 *    cost/damage currently stored on the broken one — i.e. two independent signals that these are
 *    the same design, one of them mis-parsed. Anything short of that is reported, not patched.
 *
 * Run: npx tsx src/scripts/patch-skill-misclassification.ts [--apply]
 */
import * as fs from 'fs';
import * as path from 'path';

const CARDS = path.resolve(__dirname, '../../data/cards.json');
const apply = process.argv.includes('--apply');

const file = JSON.parse(fs.readFileSync(CARDS, 'utf-8')) as { timestamp?: number; data: any[] };
const cards = file.data;

const sameSignature = (a: any, b: any) =>
  (a?.damage || '') === (b?.damage || '') &&
  JSON.stringify(a?.cost || []) === JSON.stringify(b?.cost || []);

let namelessDropped = 0;
let reclassified = 0;
const skipped: string[] = [];

for (const c of cards) {
  if (!Array.isArray(c.attacks)) continue;
  const before = c.attacks.length;
  c.attacks = c.attacks.filter((a: any) => (a?.name || '').trim());
  namelessDropped += before - c.attacks.length;
  if (c.attacks.length === 0) delete c.attacks;
}

/** name -> the ability list of whichever print of that card carries one. */
const abilitiesByCardName = new Map<string, any[]>();
for (const c of cards) {
  if ((c.abilities || []).length && !abilitiesByCardName.has(c.name)) abilitiesByCardName.set(c.name, c.abilities);
}

for (const c of cards) {
  const knownAbilities = abilitiesByCardName.get(c.name);
  if (!knownAbilities || (c.abilities || []).length) continue;
  const conflict = (c.attacks || []).find((a: any) =>
    knownAbilities.some(ab => (ab.name || '').trim() === (a.name || '').trim()));
  if (!conflict) continue;

  // The sibling print that got it right: same name, has the ability, and has a real attack.
  const sibling = cards.find(x => x.name === c.name && x.id !== c.id
    && (x.abilities || []).length && (x.attacks || []).length);
  if (!sibling) { skipped.push(`${c.id} ${c.name}: no sibling print with both an ability and an attack`); continue; }
  const siblingAttack = sibling.attacks.find((a: any) => sameSignature(a, conflict));
  if (!siblingAttack) { skipped.push(`${c.id} ${c.name}: sibling attack cost/damage does not match the stored entry`); continue; }

  c.abilities = knownAbilities.map(ab => ({ ...ab }));
  c.attacks = (c.attacks || []).map((a: any) => (a === conflict ? { ...siblingAttack } : a));
  reclassified++;
  console.log(`reclassified ${c.id} ${c.name}: 「${conflict.name}」 -> ability, attack restored as 「${siblingAttack.name}」`);
}

console.log(`nameless attack entries dropped: ${namelessDropped}`);
console.log(`abilities recovered from the attack list: ${reclassified}`);
for (const s of skipped) console.log(`  skipped (needs a manual look): ${s}`);

if (apply) {
  fs.writeFileSync(CARDS, JSON.stringify(file, null, 2), 'utf-8');
  console.log(`written -> ${CARDS}`);
} else {
  console.log('(dry run — pass --apply to write)');
}
