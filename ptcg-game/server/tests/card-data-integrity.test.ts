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
