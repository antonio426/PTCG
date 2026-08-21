import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one test file that deliberately reads `server/data/cards.json` — everything else uses
 * synthetic fixtures on purpose (see CLAUDE.md), but these are assertions ABOUT the curated
 * dataset, so they'd be meaningless against a fixture.
 *
 * Scoped to Standard-legal Pokémon: those are the cards a game can actually put on the table,
 * and older non-Standard sets carry known unrepaired gaps that would make this noise.
 */
const cards: any[] = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'cards.json'), 'utf8')).data;
const standardPokemon = cards.filter(
  c => c.supertype === 'Pokémon' && c.legalities?.standard === 'Legal',
);

describe('cards.json retreat costs', () => {
  it('has a meaningful number of Standard-legal Pokémon to check', () => {
    expect(standardPokemon.length).toBeGreaterThan(2000);
  });

  it('never stores a zero-length retreatCost array', () => {
    // Free retreat is real (~3% of Pokémon) but is represented by OMITTING the field, matching
    // how the official scrape represents it. An empty array would be a third state that
    // effectiveRetreatCost and the audit script would each read differently.
    const empty = standardPokemon.filter(c => Array.isArray(c.retreatCost) && c.retreatCost.length === 0);
    expect(empty.map(c => c.id)).toEqual([]);
  });

  it('keeps retreatCost and convertedRetreatCost in agreement', () => {
    const inconsistent = standardPokemon
      .filter(c => Array.isArray(c.retreatCost) && c.convertedRetreatCost !== c.retreatCost.length)
      .map(c => `${c.id} ${c.name}: ${c.retreatCost.length} vs ${c.convertedRetreatCost}`);
    expect(inconsistent).toEqual([]);
  });

  it('only ever uses Colorless symbols for retreat', () => {
    const odd = standardPokemon
      .filter(c => Array.isArray(c.retreatCost) && c.retreatCost.some((e: string) => e !== 'Colorless'))
      .map(c => c.id);
    expect(odd).toEqual([]);
  });

  it('stays within the printed range of 1-5', () => {
    const outOfRange = standardPokemon
      .filter(c => Array.isArray(c.retreatCost) && (c.retreatCost.length < 1 || c.retreatCost.length > 5))
      .map(c => `${c.id}: ${c.retreatCost.length}`);
    expect(outOfRange).toEqual([]);
  });

  /**
   * The regression this file exists for. Every card in the scrape-merged sets (MC, SVM, M*,
   * SV11W/B, …) had been written with a retreat cost of exactly 2 — 1,476 cards, reported live
   * on 幼基拉斯 SVM-062 printing 1 but costing 2 in game. A real set spreads across 1-4; the
   * highest natural concentration in any Standard set is 63%, so a set where one value dominates
   * is a bulk-fill artifact, not a card pool.
   */
  it('no set is dominated by a single retreat value', () => {
    const bySet = new Map<string, number[]>();
    for (const c of standardPokemon) {
      if (!Array.isArray(c.retreatCost)) continue;
      const setId = c.set?.id ?? '?';
      const arr = bySet.get(setId);
      if (arr) arr.push(c.retreatCost.length); else bySet.set(setId, [c.retreatCost.length]);
    }

    const suspicious: string[] = [];
    for (const [setId, values] of bySet) {
      if (values.length < 15) continue; // too few cards for the shape to mean anything
      const counts = new Map<number, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      const top = Math.max(...counts.values());
      const share = top / values.length;
      if (share > 0.85) suspicious.push(`${setId}: ${(share * 100).toFixed(0)}% of ${values.length} cards share one value`);
    }
    expect(suspicious).toEqual([]);
  });
});

describe('cards.json energy classification', () => {
  // Unlike the retreat checks these run over ALL prints, not just Standard: the deck builder's
  // Standard filter is a user-toggleable checkbox, so every print in the catalog can end up in a
  // deck — and the 4-copy limit's Basic Energy exemption keys directly on these subtypes. A
  // mislabeled SV-P print of 雙重渦輪能量 once made 60 copies of a Special Energy legal.
  const energies = cards.filter(c => c.supertype === 'Energy');

  it('has a meaningful number of Energy prints to check', () => {
    expect(energies.length).toBeGreaterThan(300);
  });

  it('gives every Energy print exactly one of Basic Energy / Special Energy', () => {
    const bad = energies
      .filter(c => c.subtypes?.includes('Basic Energy') === c.subtypes?.includes('Special Energy'))
      .map(c => `${c.id} ${c.name}: ${JSON.stringify(c.subtypes)}`);
    expect(bad).toEqual([]);
  });

  it('classifies every 基本X能量-named print as Basic Energy', () => {
    // Brackets and the 基本 prefix are both optional on real prints (基本火能量 promos,
    // 【惡】能量 special art) — the scraper once only recognized the fully-bracketed form and
    // mislabeled 40+ Basic Energy prints as Special, wrongly capping them at 4 per deck.
    const basicName = /^(基本[【\[]?.[】\]]?|[【\[].[】\]])能量$/;
    const bad = energies
      .filter(c => basicName.test(c.name) !== !!c.subtypes?.includes('Basic Energy'))
      .map(c => `${c.id} ${c.name}: ${JSON.stringify(c.subtypes)}`);
    expect(bad).toEqual([]);
  });

  it('never puts an energy subtype on a non-Energy card, or an Energy supertype on a non-能量 name', () => {
    // Starter-deck pages were once scraped into Energy entries for 巢穴球/活力頭帶/學習裝置 —
    // supertype Energy + subtype Basic Energy on an Item means unlimited copies of it in a deck.
    const bad = cards
      .filter(c => c.supertype === 'Energy'
        ? !c.name.includes('能量')
        : c.subtypes?.some((s: string) => s === 'Basic Energy' || s === 'Special Energy'))
      .map(c => `${c.id} ${c.name} (${c.supertype})`);
    expect(bad).toEqual([]);
  });

  it('never lets one printed name span supertypes or Basic/Special classes', () => {
    // A name IS the card in the TCG rules (the 4-copy limit counts names); prints of one name
    // disagreeing about what kind of card it is means one of them is scraper junk — this is how
    // 厲害釣竿's phantom 70-HP "Pokémon" print was found.
    const classOf = (c: any) => c.supertype === 'Energy'
      ? (c.subtypes?.includes('Basic Energy') ? 'Energy/Basic' : 'Energy/Special')
      : c.supertype;
    const byName = new Map<string, Set<string>>();
    for (const c of cards) {
      if (!byName.has(c.name)) byName.set(c.name, new Set());
      byName.get(c.name)!.add(classOf(c));
    }
    const bad = [...byName].filter(([, kinds]) => kinds.size > 1).map(([name, kinds]) => `${name}: ${[...kinds]}`);
    expect(bad).toEqual([]);
  });
});

/**
 * Skill classification. The official page is the only source for the newest sets (MC-* isn't in
 * TCGdex at all), and it does NOT reliably print the 「[特性] 」 prefix the scraper keys off — so an
 * ability can land in `attacks`, taking the real attack's slot with it. Neither coverage nor the
 * clause audit can see that: to them the card simply has a differently-named attack.
 */
describe('cards.json skill classification', () => {
  const standardWithSkills = cards.filter(c => c.legalities?.standard === 'Legal');

  it('never stores a nameless attack', () => {
    // TCGdex ships placeholder `{cost: []}` entries for cards it hasn't filled in; once the
    // official backfill supplies the real skill, the placeholder is left behind as an attack with
    // no name, no damage and no text — offered by the engine as a real (free, blank) attack.
    const nameless = standardWithSkills.filter(c => (c.attacks || []).some((a: any) => !(a.name || '').trim()));
    expect(nameless.map(c => c.id)).toEqual([]);
  });

  it('never files a skill as an attack when another print of the same card calls it an ability', () => {
    // The reciprocal check CLAUDE.md describes, applied to classification rather than to gaps:
    // 骨紋巨聲鱷 SV8-019 prints 純樸 as an Ability, so MC-144 listing 純樸 among its attacks was
    // provably a mis-parse — and it had swallowed that print's real attack.
    const abilityNamesByCard = new Map<string, Set<string>>();
    for (const c of cards) {
      for (const a of c.abilities || []) {
        if (!abilityNamesByCard.has(c.name)) abilityNamesByCard.set(c.name, new Set());
        abilityNamesByCard.get(c.name)!.add((a.name || '').trim());
      }
    }
    const conflicts: string[] = [];
    for (const c of standardWithSkills) {
      const abilityNames = abilityNamesByCard.get(c.name);
      if (!abilityNames) continue;
      for (const a of c.attacks || []) {
        if (abilityNames.has((a.name || '').trim())) conflicts.push(`${c.id} ${c.name}::${a.name}`);
      }
    }
    expect(conflicts).toEqual([]);
  });
});

/**
 * cards.json vs the official scrape.
 *
 * The merge that built this dataset once collapsed a card's skills into one — 赫拉克羅斯 M6-001 kept
 * a single attack carrying BOTH attacks' Energy costs, and a third of Standard-legal Pokémon were
 * in that state. Nothing caught it: every coverage and clause audit reads cards.json, so an attack
 * that isn't in the file isn't a gap. This compares against the other source, which is the only way
 * to see it. If a refetch or a re-merge reintroduces the collapse, this fails.
 *
 * Skipped deliberately: the 太晶 marker (ours only, from TCGdex), abilities the site does not mark
 * (it prefixes 「[特性] 」 only sometimes, so a name may legitimately sit in either list), and prints
 * with no official record.
 */
describe('cards.json agrees with the official scrape', () => {
  const scraped: any[] = (() => {
    const raw = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'scraped-cards-all.json'), 'utf8'));
    return Array.isArray(raw) ? raw : (raw.data ?? []);
  })();

  const numOf = (n: unknown) => {
    const m = String(n ?? '').match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const keyOf = (c: any) => {
    const num = numOf(String(c.number ?? '').split('/')[0]);
    return c.set?.id && num !== null ? `${String(c.set.id).toLowerCase()}-${num}` : null;
  };
  const clean = (n: unknown) => String(n ?? '').replace(/[​‌‍\s]/g, '').replace(/^\[特性\]/, '');
  const officialByKey = new Map<string, any>();
  for (const c of scraped) {
    const k = keyOf(c);
    if (k && !officialByKey.has(k)) officialByKey.set(k, c);
  }

  const standardPokemonWithOfficial = standardPokemon
    .map(c => ({ card: c, off: officialByKey.get(keyOf(c) ?? '') }))
    .filter(x => x.off && ((x.off.attacks?.length ?? 0) + (x.off.abilities?.length ?? 0)) > 0);

  it('has an official record for nearly every Standard Pokémon', () => {
    expect(standardPokemonWithOfficial.length).toBeGreaterThan(standardPokemon.length * 0.95);
  });

  it('never loses an attack the official page lists', () => {
    const missing: string[] = [];
    for (const { card, off } of standardPokemonWithOfficial) {
      const ourNames = new Set([...(card.attacks ?? []), ...(card.abilities ?? [])].map((a: any) => clean(a.name)));
      for (const a of off.attacks ?? []) {
        const n = clean(a.name);
        if (!n || n === '太晶') continue;
        if (!ourNames.has(n)) missing.push(`${card.id} ${card.name}::${n}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('never merges another attack’s Energy cost into one', () => {
    // The exact shape of the shipped bug: our single attack costs what several of theirs cost.
    const wrong: string[] = [];
    for (const { card, off } of standardPokemonWithOfficial) {
      const theirs = new Map<string, number>();
      for (const a of off.attacks ?? []) theirs.set(clean(a.name), (a.cost ?? []).length);
      for (const a of card.attacks ?? []) {
        const n = clean(a.name);
        if (!theirs.has(n)) continue;
        const ours = (a.cost ?? []).length;
        if (ours !== theirs.get(n)) wrong.push(`${card.id} ${card.name}::${n} costs ${ours}, official says ${theirs.get(n)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never loses an ability the official page marks with 「[特性]」', () => {
    const missing: string[] = [];
    for (const { card, off } of standardPokemonWithOfficial) {
      const ourNames = new Set((card.abilities ?? []).map((a: any) => clean(a.name)));
      for (const a of off.abilities ?? []) {
        if (!ourNames.has(clean(a.name))) missing.push(`${card.id} ${card.name}::${clean(a.name)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
