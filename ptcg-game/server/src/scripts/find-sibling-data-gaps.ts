/**
 * Detects the OTHER class of "hidden bug" that coverage-report.ts can't see:
 * cards whose ability/attack text is missing from the scraped data entirely
 * (not "text exists but no handler" — "text should exist, per a sibling print
 * of the identical card, but was dropped during scrape/enrich").
 *
 * Heuristic: group Pokémon cards by (name, subtypes). Within a group, if some
 * prints have non-empty abilities/attacks and others have them missing, and
 * the prints otherwise look like the same real card (same hp, and — when both
 * sides actually have attack data — matching attack names), flag the missing
 * side as a backfill candidate, citing which sibling print to copy from.
 *
 * Run with: npx tsx src/scripts/find-sibling-data-gaps.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const OFFICIAL_SCRAPE = path.resolve(__dirname, '../../data/scraped-cards-all.json');

const clean = (s: string) => (s || '').replace(/[​-‏⁠]/g, '').replace(/^[特性]s*/, '');
const numerator = (s: string) => String(s || '').split('/')[0].replace(/^0+/, '');

/**
 * What the official card-search page lists for a print, as a set of skill names.
 *
 * This is the check that turns a 'medium' candidate into a verdict. The page keeps abilities and
 * attacks in the SAME .skill block and only sometimes prefixes 「[特性] 」, so a name in this set
 * is a name the card really has — and a name that is NOT in it, on a print the page does cover,
 * is a name the card does NOT have. Seven of the eight Standard candidates this tool used to
 * propose failed exactly that way: same name, same HP, genuinely different designs. Backfilling
 * them would have repeated the 振翼髮 SV8-059 mistake seven times over.
 *
 * Prints the scrape has no record for (promos are filed differently — see CLAUDE.md) return
 * undefined, which means "no opinion", not "contradicted".
 */
function officialSkillNames(cards: MapCard[]): (card: MapCard) => Set<string> | undefined {
  let index: Map<string, Set<string>> | null = null;
  return (card: MapCard) => {
    if (!index) {
      index = new Map();
      if (!fs.existsSync(OFFICIAL_SCRAPE)) return undefined;
      const list = JSON.parse(fs.readFileSync(OFFICIAL_SCRAPE, 'utf-8')).data as any[];
      for (const r of list) {
        if (!r?.set?.id || r.number === undefined) continue;
        const key = `${r.set.id}-${numerator(r.number)}`;
        const names = new Set<string>((r.attacks || []).map((a: any) => clean(a.name)));
        if (names.size > 0) index.set(key, names);
      }
    }
    const dash = card.id.lastIndexOf('-');
    return index.get(`${card.id.slice(0, dash)}-${numerator(card.id.slice(dash + 1))}`);
  };
}

interface Gap {
  name: string;
  field: 'abilities' | 'attacks';
  missingId: string;
  missingStandardLegal: boolean;
  sourceId: string;
  confidence: 'high' | 'medium';
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
}

function attackSignature(card: MapCard): string | null {
  if (isEmpty(card.attacks)) return null;
  return card.attacks!.map(a => `${a.name}:${a.cost.join(',')}:${a.damage}`).sort().join('|');
}

const officialSkills = officialSkillNames([]);

function main() {
  const cards = (JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')).data as MapCard[])
    .filter(c => c.supertype === 'Pokémon');

  const groups = new Map<string, MapCard[]>();
  for (const c of cards) {
    const key = `${c.name}::${(c.subtypes || []).join(',')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const gaps: Gap[] = [];

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const withAbilities = group.filter(c => !isEmpty(c.abilities));
    const withoutAbilities = group.filter(c => isEmpty(c.abilities));
    const withAttacks = group.filter(c => !isEmpty(c.attacks));
    const withoutAttacks = group.filter(c => isEmpty(c.attacks));

    for (const missing of withoutAbilities) {
      const source = withAbilities.find(s => s.hp === missing.hp
        && (attackSignature(s) === null || attackSignature(missing) === null || attackSignature(s) === attackSignature(missing)));
      if (!source) continue;
      // The official page settles it where it covers the print: an ability it does not list is
      // one this print does not have, however well the sibling matches.
      const listed = officialSkills(missing);
      if (listed && (source.abilities || []).some(a => !listed.has(clean(a.name)))) continue;
      const confidence = attackSignature(source) !== null && attackSignature(missing) !== null ? 'high' : 'medium';
      gaps.push({ name: missing.name, field: 'abilities', missingId: missing.id, missingStandardLegal: missing.legalities?.standard === 'Legal', sourceId: source.id, confidence });
    }
    for (const missing of withoutAttacks) {
      const source = withAttacks.find(s => s.hp === missing.hp);
      if (!source) continue;
      const listed = officialSkills(missing);
      if (listed && (source.attacks || []).some(a => !listed.has(clean(a.name)))) continue;
      gaps.push({ name: missing.name, field: 'attacks', missingId: missing.id, missingStandardLegal: missing.legalities?.standard === 'Legal', sourceId: source.id, confidence: 'medium' });
    }
  }

  const byLegalThenConfidence = [...gaps].sort((a, b) => {
    if (a.missingStandardLegal !== b.missingStandardLegal) return a.missingStandardLegal ? -1 : 1;
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  console.log(`=== Sibling data-gap candidates: ${gaps.length} ===`);
  console.log(`  standard-legal & missing: ${gaps.filter(g => g.missingStandardLegal).length}`);
  console.log(`  high confidence (attack signatures match exactly): ${gaps.filter(g => g.confidence === 'high').length}`);
  console.log('\n=== Top 40 (standard-legal first, then high-confidence first) ===');
  for (const g of byLegalThenConfidence.slice(0, 40)) {
    console.log(`  [${g.confidence}]${g.missingStandardLegal ? ' [standard]' : ''} ${g.name} (${g.missingId}) missing ${g.field} — copy from ${g.sourceId}`);
  }

  const outDir = path.resolve(__dirname, '../../../data-scraped');
  fs.writeFileSync(path.join(outDir, 'sibling-data-gaps.json'), JSON.stringify(byLegalThenConfidence, null, 2), 'utf-8');
  console.log('\nFull list saved to data-scraped/sibling-data-gaps.json');
}

main();
