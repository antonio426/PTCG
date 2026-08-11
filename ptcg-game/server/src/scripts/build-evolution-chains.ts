/**
 * One-off data-generation script: builds a static Traditional-Chinese species evolution-chain
 * table (child species name -> immediate pre-evolution species name) from PokeAPI, independent
 * of TCGdex — whose zh-tw locale doesn't populate `evolveFrom` for any card (confirmed live:
 * every Stage 1/Stage 2/VMAX/VSTAR card in cards.json is missing evolvesFrom). Evolution chains
 * are a fixed property of the species, not the card/set, so a single species-level table covers
 * every card regardless of which TCGdex data gap affected it.
 *
 * Output: server/data/evolution-chains.json — { [childSpeciesZhName]: parentSpeciesZhName }
 *
 * Run with: npx tsx src/scripts/build-evolution-chains.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const GRAPHQL_URL = 'https://beta.pokeapi.co/graphql/v1beta';
const ZH_HANT_LANGUAGE_ID = 4;

interface SpeciesRow {
  id: number;
  name: string;
  evolves_from_species_id: number | null;
  pokemon_v2_pokemonspeciesnames: { name: string }[];
}

async function main() {
  const query = `query {
    pokemon_v2_pokemonspecies(limit: 2000) {
      id
      name
      evolves_from_species_id
      pokemon_v2_pokemonspeciesnames(where: {language_id: {_eq: ${ZH_HANT_LANGUAGE_ID}}}) {
        name
      }
    }
  }`;

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`PokeAPI GraphQL request failed: ${res.status}`);
  const json = await res.json() as { data: { pokemon_v2_pokemonspecies: SpeciesRow[] } };
  const species = json.data.pokemon_v2_pokemonspecies;
  console.log(`Fetched ${species.length} species from PokeAPI.`);

  const idToZhName = new Map<number, string>();
  let missingZhName = 0;
  for (const s of species) {
    const zh = s.pokemon_v2_pokemonspeciesnames[0]?.name;
    if (zh) idToZhName.set(s.id, zh);
    else missingZhName++;
  }
  console.log(`${idToZhName.size} species have a zh-Hant name (${missingZhName} missing).`);

  const chains: Record<string, string> = {};
  let unresolvedParent = 0;
  for (const s of species) {
    if (s.evolves_from_species_id === null) continue;
    const childName = idToZhName.get(s.id);
    const parentName = idToZhName.get(s.evolves_from_species_id);
    if (!childName) continue;
    if (!parentName) { unresolvedParent++; continue; }
    chains[childName] = parentName;
  }
  console.log(`Built ${Object.keys(chains).length} evolution-chain entries (${unresolvedParent} had an unresolved parent name).`);

  const outPath = path.resolve(__dirname, '../../data/evolution-chains.json');
  fs.writeFileSync(outPath, JSON.stringify(chains, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${outPath}`);

  // Spot-check a few well-known chains.
  const samples = ['妙蛙草', '皮卡丘', '噴火龍', '超夢'];
  for (const s of samples) {
    console.log(`  ${s} <- ${chains[s] ?? '(not found / is Basic)'}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
