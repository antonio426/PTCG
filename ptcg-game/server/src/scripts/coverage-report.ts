/**
 * Reports how much of the standard-legal card pool has real game-logic coverage
 * in server/src/game/effects/ vs. is still relying on the generic fallback
 * (flat damage / no-op discard for trainers not in the registry).
 *
 * Run with: npx tsx src/scripts/coverage-report.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';
import { trainerEffects } from '../game/effects/trainers';
import { abilityEffects } from '../game/effects/abilities';
import { attackEffects } from '../game/effects/attacks';
import { matchesGenericAttackTemplate } from '../game/effects/genericAttacks';
import { hasToolEffect } from '../game/effects/tools';
import { PASSIVE_ABILITY_NAMES } from '../game/effects/passiveAbilities';
import { normalizeAbilityName, normalizeCardName } from '../game/effects/types';

function isAbilityCovered(name: string): boolean {
  const n = normalizeAbilityName(name);
  return n in abilityEffects || PASSIVE_ABILITY_NAMES.has(n);
}

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');

function main() {
  const cards = (JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')).data as MapCard[])
    .filter(c => c.legalities?.standard === 'Legal');

  // ── Trainers ──
  // Pokémon Tool / Stadium cards get generic handling (attach-to-Pokémon / field-slot) even
  // without a trainerEffects entry — only tools.ts's numeric query effects (retreat cost etc.)
  // need a dedicated registration, so "no trainerEffects entry" alone doesn't mean "uncovered"
  // for them the way it does for a plain Item/Supporter.
  const trainers = cards.filter(c => c.supertype === 'Trainer');
  const trainerNames = [...new Set(trainers.map(c => c.name))];
  const toolOrStadiumNames = new Set(
    trainers.filter(c => c.subtypes.includes('Pokémon Tool') || c.subtypes.includes('Stadium')).map(c => c.name)
  );
  const uncoveredTrainers = trainerNames.filter(n => !(normalizeCardName(n) in trainerEffects) && !toolOrStadiumNames.has(n));
  const toolNamesWithCustomEffect = [...toolOrStadiumNames].filter(hasToolEffect);

  console.log('=== Trainer Cards ===');
  console.log(`  Unique names: ${trainerNames.length}, with custom logic (trainerEffects/tools.ts): ${trainerNames.length - uncoveredTrainers.length} (${((trainerNames.length - uncoveredTrainers.length) / trainerNames.length * 100).toFixed(1)}%)`);
  console.log(`  Tool/Stadium names: ${toolOrStadiumNames.size} (generic attach/field-slot handling applies to all; ${toolNamesWithCustomEffect.length} also have a registered numeric effect in tools.ts)`);

  // ── Abilities ──
  const pokemon = cards.filter(c => c.supertype === 'Pokémon');
  const abilityNames = [...new Set(pokemon.flatMap(c => (c.abilities || []).map(a => a.name)))];
  const coveredAbilities = abilityNames.filter(isAbilityCovered);

  console.log('\n=== Abilities ===');
  console.log(`  Unique names: ${abilityNames.length}, covered: ${coveredAbilities.length} (${(coveredAbilities.length / abilityNames.length * 100).toFixed(1)}%)`);

  // ── Attacks with special text (the rest use the default flat-damage path, which is correct for them) ──
  const attackKeys = new Set<string>();
  const attackKeysWithText: string[] = [];
  const attackTextByKey: Record<string, string> = {};
  for (const p of pokemon) {
    for (const a of p.attacks || []) {
      if (!a.text?.trim()) continue; // plain flat-damage attacks don't need a handler
      const key = `${p.name}::${a.name}`;
      if (!attackKeys.has(key)) { attackKeys.add(key); attackKeysWithText.push(key); attackTextByKey[key] = a.text; }
    }
  }
  const isAttackCovered = (k: string) => k in attackEffects || matchesGenericAttackTemplate(attackTextByKey[k]);
  const coveredAttacks = attackKeysWithText.filter(isAttackCovered);

  console.log('\n=== Attacks with special effect text ===');
  console.log(`  Unique Pokémon+attack combos: ${attackKeysWithText.length}, covered: ${coveredAttacks.length} (${(coveredAttacks.length / attackKeysWithText.length * 100).toFixed(1)}%)`);

  // ── Weighted by how many printed cards each uncovered name affects (reprint count = play frequency proxy) ──
  const trainerCounts: Record<string, number> = {};
  for (const t of trainers) trainerCounts[t.name] = (trainerCounts[t.name] || 0) + 1;
  const topUncoveredTrainers = uncoveredTrainers
    .map(n => [n, trainerCounts[n]] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  console.log('\n=== Top 50 uncovered Trainer cards (by reprint count) ===');
  for (const [name, count] of topUncoveredTrainers) console.log(`  ${count}\t${name}`);

  const abilityCounts: Record<string, number> = {};
  for (const p of pokemon) for (const a of p.abilities || []) abilityCounts[a.name] = (abilityCounts[a.name] || 0) + 1;
  const topUncoveredAbilities = abilityNames
    .filter(n => !isAbilityCovered(n))
    .map(n => [n, abilityCounts[n]] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  console.log('\n=== Top 30 uncovered abilities (by reprint count) ===');
  for (const [name, count] of topUncoveredAbilities) console.log(`  ${count}\t${name}`);

  // ── Save the full lists for future work ──
  const outDir = path.resolve(__dirname, '../../../data-scraped');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-trainers.json'), JSON.stringify(uncoveredTrainers, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-abilities.json'), JSON.stringify(abilityNames.filter(n => !isAbilityCovered(n)), null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-attacks.json'), JSON.stringify(attackKeysWithText.filter(k => !isAttackCovered(k)), null, 2), 'utf-8');
  console.log('\nFull uncovered lists saved to data-scraped/coverage-uncovered-*.json');
}

main();
