import { describe, it, expect } from 'vitest';
import {
  chainTracesBackTo, evolvesFromMatches, extractSpeciesName, getEvolutionChains,
  getEvolutionLineage, hasEvolvesFrom, inferEvolvesFromSpecies,
} from '../src/game/evolutionChains';
import { isFossilCard, fossilAsPokemon } from '../src/game/fossils';
import { makeCard } from './fixtures';

/**
 * TCGdex's zh-tw locale never populates `evolvesFrom`, so evolution is resolved through a static
 * species chain plus a longest-match search inside the printed name. These specs use real species
 * from that table — the whole point of the module is that it works for decorated printed names
 * (ex/V/超級/owner prefixes) that a naive exact-name lookup would miss.
 */
const CHAINS = getEvolutionChains();

describe('the chain table is loaded and sane', () => {
  it('has entries', () => {
    expect(Object.keys(CHAINS).length).toBeGreaterThan(100);
  });

  it('knows the starter line used throughout these specs', () => {
    expect(CHAINS['火恐龍']).toBe('小火龍');
    expect(CHAINS['噴火龍']).toBe('火恐龍');
  });

  it('contains no card that evolves from itself', () => {
    expect(Object.entries(CHAINS).filter(([child, parent]) => child === parent)).toEqual([]);
  });
});

describe('extractSpeciesName', () => {
  it('reads a bare species name', () => {
    expect(extractSpeciesName('噴火龍')).toBe('噴火龍');
  });

  it.each(['噴火龍ex', '超級噴火龍Xex', '瑪俐的噴火龍'])('finds the species inside %s', name => {
    expect(extractSpeciesName(name)).toBe('噴火龍');
  });

  it('prefers the longest match, so a shorter species inside a longer name loses', () => {
    // 火恐龍 contains no other species, but 噴火龍 vs 火恐龍 must not be confused.
    expect(extractSpeciesName('火恐龍')).toBe('火恐龍');
  });

  it('returns undefined for a name with no known species in it', () => {
    expect(extractSpeciesName('博士的研究')).toBeUndefined();
  });
});

describe('inferEvolvesFromSpecies', () => {
  it('resolves one hop back', () => {
    expect(inferEvolvesFromSpecies('噴火龍')).toBe('火恐龍');
  });

  it('works through a decorated printed name', () => {
    expect(inferEvolvesFromSpecies('噴火龍ex')).toBe('火恐龍');
  });

  it('returns undefined for a Basic', () => {
    expect(inferEvolvesFromSpecies('小火龍')).toBeUndefined();
  });
});

describe('hasEvolvesFrom', () => {
  it('trusts real TCGdex data when present', () => {
    expect(hasEvolvesFrom({ name: '任何東西', evolvesFrom: '某某' })).toBe(true);
  });

  it('falls back to the species chain when the field is missing', () => {
    expect(hasEvolvesFrom({ name: '噴火龍' })).toBe(true);
  });

  it('is false for a Basic with no field', () => {
    expect(hasEvolvesFrom({ name: '小火龍' })).toBe(false);
  });
});

describe('evolvesFromMatches', () => {
  it('compares by exact printed name when TCGdex supplied the field', () => {
    expect(evolvesFromMatches({ name: '噴火龍', evolvesFrom: '火恐龍' }, '火恐龍')).toBe(true);
    expect(evolvesFromMatches({ name: '噴火龍', evolvesFrom: '火恐龍' }, '小火龍')).toBe(false);
  });

  it('compares by species when falling back, so decoration on either side is fine', () => {
    expect(evolvesFromMatches({ name: '噴火龍ex' }, '火恐龍')).toBe(true);
  });

  it('rejects a two-hop jump — evolution is one stage at a time', () => {
    expect(evolvesFromMatches({ name: '噴火龍ex' }, '小火龍')).toBe(false);
  });

  it('rejects an unrelated target', () => {
    expect(evolvesFromMatches({ name: '噴火龍ex' }, '妙蛙草')).toBe(false);
  });
});

describe('getEvolutionLineage', () => {
  it('walks all the way back to the root Basic', () => {
    expect(getEvolutionLineage('噴火龍')).toEqual(['火恐龍', '小火龍']);
  });

  it('is empty for a Basic', () => {
    expect(getEvolutionLineage('小火龍')).toEqual([]);
  });

  it('is empty for a name with no known species', () => {
    expect(getEvolutionLineage('博士的研究')).toEqual([]);
  });
});

describe('chainTracesBackTo', () => {
  it('accepts a Stage 2 over its root Basic — what Rare Candy needs', () => {
    expect(chainTracesBackTo({ name: '噴火龍ex' }, '小火龍')).toBe(true);
  });

  it('accepts the intermediate stage too', () => {
    expect(chainTracesBackTo({ name: '噴火龍' }, '火恐龍')).toBe(true);
  });

  it('rejects a Basic from a different line', () => {
    expect(chainTracesBackTo({ name: '噴火龍ex' }, '妙蛙種子')).toBe(false);
  });

  it('rejects a card tracing back to itself', () => {
    expect(chainTracesBackTo({ name: '小火龍' }, '小火龍')).toBe(false);
  });
});

describe('fossils', () => {
  const FOSSIL_RULE = '這張卡可作為HP60的【無】屬性的【基礎】寶可夢放置於場上。這張卡不會陷入特殊狀態，無法撤退。';
  const fossil = makeCard({
    name: '陳舊的頭蓋骨化石', supertype: 'Trainer', subtypes: ['Item'], rules: [FOSSIL_RULE],
  });

  it('recognizes a fossil from its printed rules text, not a name list', () => {
    // Deliberate: any future fossil reprint or new fossil name is picked up automatically.
    expect(isFossilCard(fossil)).toBe(true);
  });

  it.each([
    ['an ordinary Item', makeCard({ name: '精靈球', supertype: 'Trainer', subtypes: ['Item'], rules: ['擲1次硬幣。'] })],
    ['an Item with no rules', makeCard({ name: '無規則', supertype: 'Trainer', subtypes: ['Item'] })],
    ['a Pokémon', makeCard({ name: '小火龍', hp: '60' })],
  ])('does not mistake %s for a fossil', (_label, card) => {
    expect(isFossilCard(card)).toBe(false);
  });

  it('produces a Basic Pokémon view with the printed HP and type', () => {
    const view = fossilAsPokemon(fossil);
    expect(view.supertype).toBe('Pokémon');
    expect(view.subtypes).toEqual(['Basic']);
    expect(view.hp).toBe('60');
    expect(view.types).toEqual(['Colorless']);
    expect(view.isFossil).toBe(true);
  });

  it('gives it no attacks and no retreat cost', () => {
    const view = fossilAsPokemon(fossil);
    expect(view.attacks).toEqual([]);
    expect(view.convertedRetreatCost).toBe(0);
  });

  it('leaves the original card untouched, so a search for Items still finds it', () => {
    fossilAsPokemon(fossil);
    expect(fossil.supertype).toBe('Trainer');
    expect(fossil.subtypes).toEqual(['Item']);
  });

  it('reads a non-Colorless fossil type from the rules text', () => {
    const fireFossil = makeCard({
      name: '火化石', supertype: 'Trainer', subtypes: ['Item'],
      rules: ['這張卡可作為HP70的【火】屬性的【基礎】寶可夢放置於場上。'],
    });
    const view = fossilAsPokemon(fireFossil);
    expect(view.hp).toBe('70');
    expect(view.types).toEqual(['Fire']);
  });
});
