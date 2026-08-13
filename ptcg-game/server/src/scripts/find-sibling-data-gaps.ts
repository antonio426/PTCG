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
      const confidence = attackSignature(source) !== null && attackSignature(missing) !== null ? 'high' : 'medium';
      gaps.push({ name: missing.name, field: 'abilities', missingId: missing.id, missingStandardLegal: missing.legalities?.standard === 'Legal', sourceId: source.id, confidence });
    }
    for (const missing of withoutAttacks) {
      const source = withAttacks.find(s => s.hp === missing.hp);
      if (!source) continue;
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
