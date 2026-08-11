import * as fs from 'fs';
import * as path from 'path';

// TCGdex's zh-tw locale never populates `evolvesFrom` — confirmed live: every Stage 1/Stage 2/
// VMAX/VSTAR card in cards.json is missing it, not just some. Evolution chains are a fixed
// property of the species (not the card/set), so a static table built once from PokeAPI (see
// scripts/build-evolution-chains.ts) covers every card regardless of which TCGdex field is
// missing — independent of TCGdex's own data gaps entirely.
// Keyed by bare Traditional-Chinese species name (e.g. "妙蛙草" -> "妙蛙種子").
const CHAINS: Record<string, string> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../data/evolution-chains.json'), 'utf-8')
);

// Longest-first so a greedy substring search prefers a more specific species name over a shorter
// one that happens to also appear inside it (e.g. a short Basic species name inside a longer
// decorated evolved form's printed name).
const KNOWN_SPECIES = Array.from(new Set([...Object.keys(CHAINS), ...Object.values(CHAINS)]))
  .sort((a, b) => b.length - a.length);

/** Card names in this dataset are usually a bare species name, sometimes with a trailing rarity/
 * form suffix (ex/V/VMAX/VSTAR/GX) or an owner/variant prefix (超級/N的/遠古/...). Rather than
 * enumerate every decoration convention, find the longest known species name that appears
 * anywhere in the printed name. */
export function extractSpeciesName(cardName: string): string | undefined {
  return KNOWN_SPECIES.find(species => cardName.includes(species));
}

/** Best-effort pre-evolution species name for a card whose own `evolvesFrom` field is missing.
 * Returns undefined if the card's species couldn't be resolved, or has no earlier stage
 * (it's a Basic). */
export function inferEvolvesFromSpecies(cardName: string): string | undefined {
  const species = extractSpeciesName(cardName);
  return species ? CHAINS[species] : undefined;
}

/** True if this card evolves from something — i.e. it's not a Basic — using real TCGdex data
 * when present and the species-chain fallback otherwise. Prefer this over checking
 * `cardData.evolvesFrom` directly anywhere card effects need "is this an evolved Pokémon". */
export function hasEvolvesFrom(cardData: { name: string; evolvesFrom?: string }): boolean {
  return !!(cardData.evolvesFrom || inferEvolvesFromSpecies(cardData.name));
}

/** True if `cardData` evolves from a card named `targetName` — real TCGdex data compares by
 * exact printed name as before; the inferred fallback compares by bare species name, since it
 * can't know the target's exact decorated printed name. */
export function evolvesFromMatches(cardData: { name: string; evolvesFrom?: string }, targetName: string): boolean {
  if (cardData.evolvesFrom) return cardData.evolvesFrom === targetName;
  const inferred = inferEvolvesFromSpecies(cardData.name);
  return !!inferred && inferred === extractSpeciesName(targetName);
}
