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
import { isFossilCard } from '../game/fossils';

function isAbilityCovered(name: string): boolean {
  const n = normalizeAbilityName(name);
  return n in abilityEffects || PASSIVE_ABILITY_NAMES.has(n);
}

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const PRESET_DECKS = path.resolve(__dirname, '../../data/preset-decks.json');

interface PresetDeck { id: string; name: string; entries: { cardId: string; count: number }[] }

/** Card ids a player can actually meet in a real match here, i.e. anything the 56 preset decks
 * reference. The Standard-wide numbers below are the honest denominator, but most of that pool
 * is on cards nobody can draw in this game — the reachable subset is the actionable worklist.
 * Computed in-memory rather than by re-reading the JSON output: those files go stale the moment
 * a handler is added, and reading them back has already produced wrong gap counts twice. */
function reachableCardIds(): Set<string> {
  const decks = JSON.parse(fs.readFileSync(PRESET_DECKS, 'utf-8')) as PresetDeck[];
  const ids = new Set<string>();
  for (const d of decks) for (const e of d.entries) ids.add(e.cardId);
  return ids;
}

function main() {
  const cards = (JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')).data as MapCard[])
    .filter(c => c.legalities?.standard === 'Legal');
  const reachable = reachableCardIds();

  // ── Trainers ──
  // Pokémon Tool / Stadium cards get generic handling (attach-to-Pokémon / field-slot) even
  // without a trainerEffects entry — only tools.ts's numeric query effects (retreat cost etc.)
  // need a dedicated registration, so "no trainerEffects entry" alone doesn't mean "uncovered"
  // for them the way it does for a plain Item/Supporter.
  const trainers = cards.filter(c => c.supertype === 'Trainer');
  // Group by NORMALIZED name throughout: scraped names carry zero-width chars, so grouping by
  // the raw name splits one card into two entries -- inflating the unique-name denominator and
  // halving each half's reprint count, which is the number the worklist is sorted by. Commit
  // a0cde71 fixed the same class of bug on the comparison side; this is the grouping side.
  const trainerNames = [...new Set(trainers.map(c => normalizeCardName(c.name)))];
  const toolOrStadiumNames = new Set(
    trainers.filter(c => c.subtypes.includes('Pokémon Tool') || c.subtypes.includes('Stadium')).map(c => normalizeCardName(c.name))
  );
  // "陳舊的○○化石" are fully implemented, but as an engine-level data transform (fossils.ts +
  // playPokemon/discardFossil) rather than a trainerEffects entry — they deliberately never get
  // one. Without this exclusion they'd be reported uncovered forever.
  const fossilNames = new Set(trainers.filter(c => isFossilCard(c as never)).map(c => normalizeCardName(c.name)));
  const uncoveredTrainers = trainerNames.filter(
    n => !(n in trainerEffects) && !toolOrStadiumNames.has(n) && !fossilNames.has(n)
  );
  const toolNamesWithCustomEffect = [...toolOrStadiumNames].filter(hasToolEffect);

  console.log('=== Trainer Cards ===');
  console.log(`  Unique names: ${trainerNames.length}, with custom logic (trainerEffects/tools.ts): ${trainerNames.length - uncoveredTrainers.length} (${((trainerNames.length - uncoveredTrainers.length) / trainerNames.length * 100).toFixed(1)}%)`);
  console.log(`  Tool/Stadium names: ${toolOrStadiumNames.size} (generic attach/field-slot handling applies to all; ${toolNamesWithCustomEffect.length} also have a registered numeric effect in tools.ts)`);

  // ── Abilities ──
  const pokemon = cards.filter(c => c.supertype === 'Pokémon');
  const abilityNames = [...new Set(pokemon.flatMap(c => (c.abilities || []).map(a => normalizeAbilityName(a.name))))];
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
      // "太晶" is the Tera rule reminder text scraped into the attacks array as if it were an
      // attack — same pseudo-attack class as the "[特性]" entries. It's already implemented as a
      // passive (hasTeraBenchedImmunity, passiveAbilities.ts), so no attack handler should match it.
      if (normalizeCardName(a.name) === '太晶') continue;
      const key = `${normalizeCardName(p.name)}::${normalizeCardName(a.name)}`;
      if (!attackKeys.has(key)) { attackKeys.add(key); attackKeysWithText.push(key); attackTextByKey[key] = a.text; }
    }
  }
  const isAttackCovered = (k: string) => k in attackEffects || matchesGenericAttackTemplate(attackTextByKey[k]);
  const coveredAttacks = attackKeysWithText.filter(isAttackCovered);

  console.log('\n=== Attacks with special effect text ===');
  console.log(`  Unique Pokémon+attack combos: ${attackKeysWithText.length}, covered: ${coveredAttacks.length} (${(coveredAttacks.length / attackKeysWithText.length * 100).toFixed(1)}%)`);

  // ── Weighted by how many printed cards each uncovered name affects (reprint count = play frequency proxy) ──
  const trainerCounts: Record<string, number> = {};
  for (const t of trainers) { const n = normalizeCardName(t.name); trainerCounts[n] = (trainerCounts[n] || 0) + 1; }
  const topUncoveredTrainers = uncoveredTrainers
    .map(n => [n, trainerCounts[n]] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  console.log('\n=== Top 50 uncovered Trainer cards (by reprint count) ===');
  for (const [name, count] of topUncoveredTrainers) console.log(`  ${count}\t${name}`);

  const abilityCounts: Record<string, number> = {};
  for (const p of pokemon) for (const a of p.abilities || []) { const n = normalizeAbilityName(a.name); abilityCounts[n] = (abilityCounts[n] || 0) + 1; }
  const topUncoveredAbilities = abilityNames
    .filter(n => !isAbilityCovered(n))
    .map(n => [n, abilityCounts[n]] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  console.log('\n=== Top 30 uncovered abilities (by reprint count) ===');
  for (const [name, count] of topUncoveredAbilities) console.log(`  ${count}\t${name}`);

  // ── Narrowed to what the preset decks can actually put on the table ──
  const uncoveredTrainerSet = new Set(uncoveredTrainers);
  const uncoveredAbilitySet = new Set(abilityNames.filter(n => !isAbilityCovered(n)));
  const uncoveredAttackSet = new Set(attackKeysWithText.filter(k => !isAttackCovered(k)));

  const hits = { trainers: new Map<string, string[]>(), abilities: new Map<string, string[]>(), attacks: new Map<string, string[]>() };
  const add = (m: Map<string, string[]>, key: string, where: string) => {
    const arr = m.get(key); if (arr) arr.push(where); else m.set(key, [where]);
  };
  for (const c of cards) {
    if (!reachable.has(c.id)) continue;
    if (c.supertype === 'Trainer' && uncoveredTrainerSet.has(normalizeCardName(c.name))) add(hits.trainers, normalizeCardName(c.name), c.id);
    for (const a of c.abilities || []) {
      if (uncoveredAbilitySet.has(normalizeAbilityName(a.name))) add(hits.abilities, normalizeAbilityName(a.name), `${c.id} ${c.name}`);
    }
    for (const a of c.attacks || []) {
      // Must build the lookup key exactly like attackKeysWithText does above (both sides
      // normalized) — a raw-name lookup silently misses every card whose scraped name carries a
      // zero-width prefix, which is the whole reason this file normalizes.
      const key = `${normalizeCardName(c.name)}::${normalizeCardName(a.name)}`;
      if (uncoveredAttackSet.has(key)) add(hits.attacks, key, c.id);
    }
  }

  console.log('\n=== Reachable in the 56 preset decks (the actionable worklist) ===');
  for (const [label, m, total] of [
    ['Trainers', hits.trainers, uncoveredTrainerSet.size],
    ['Abilities', hits.abilities, uncoveredAbilitySet.size],
    ['Attacks', hits.attacks, uncoveredAttackSet.size],
  ] as const) {
    console.log(`  ${label}: ${m.size} reachable / ${total} Standard-wide`);
    for (const [name, where] of [...m].sort((a, b) => b[1].length - a[1].length)) console.log(`    ${name}\t[${where.join(', ')}]`);
  }

  // ── Save the full lists for future work ──
  const outDir = path.resolve(__dirname, '../../../data-scraped');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-trainers.json'), JSON.stringify(uncoveredTrainers, null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-abilities.json'), JSON.stringify(abilityNames.filter(n => !isAbilityCovered(n)), null, 2), 'utf-8');
  fs.writeFileSync(path.join(outDir, 'coverage-uncovered-attacks.json'), JSON.stringify(attackKeysWithText.filter(k => !isAttackCovered(k)), null, 2), 'utf-8');
  console.log('\nFull uncovered lists saved to data-scraped/coverage-uncovered-*.json');
}

main();
