import { describe, it, expect, beforeEach } from 'vitest';
import type { Card, Subtype } from '@ptcg/shared';
import { useDeckStore, sameNameCopyCount, isBasicEnergyCard } from '../src/stores/deckStore';

const card = (id: string, name: string, over: Partial<Card> = {}): Card => ({
  id,
  name,
  supertype: 'Pokémon',
  subtypes: ['Basic'] as Subtype[],
  set: { id: 'TEST', name: 'Test', series: 'Test', printedTotal: 1, total: 1, releaseDate: '' },
  number: id.split('-')[1] ?? '1',
  legalities: { standard: 'Legal' },
  images: { small: '', large: '' },
  ...over,
} as Card);

/** Two different prints of the same Pokémon — the case the per-id count got wrong. */
const PIKA_A = card('SV1-025', '皮卡丘');
const PIKA_B = card('SV5-025', '皮卡丘');
const RAICHU = card('SV1-026', '雷丘', { subtypes: ['Stage 1'] as Subtype[] });
const GRASS_ENERGY = card('SVE-001', '基本草能量', { supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] });
const CATALOG = [PIKA_A, PIKA_B, RAICHU, GRASS_ENERGY];

const setDeck = (cards: string[]) =>
  useDeckStore.setState({ currentDeck: { id: null, name: 'test', cards }, dirty: false });

const repeat = (id: string, n: number) => Array.from({ length: n }, () => id);

/** A legal 60-card baseline: 4 皮卡丘 + 1 雷丘 + 55 basic energy. */
const legalDeck = () => [...repeat(PIKA_A.id, 4), RAICHU.id, ...repeat(GRASS_ENERGY.id, 55)];

beforeEach(() => setDeck([]));

describe('isBasicEnergyCard', () => {
  it.each([
    [GRASS_ENERGY, true],
    [PIKA_A, false],
    [undefined, false],
  ])('%o -> %s', (c, expected) => {
    expect(isBasicEnergyCard(c as Card | undefined)).toBe(expected);
  });
});

describe('sameNameCopyCount', () => {
  it('counts across different prints of the same name', () => {
    const deck = [...repeat(PIKA_A.id, 2), ...repeat(PIKA_B.id, 2)];
    expect(sameNameCopyCount(deck, PIKA_A.id, CATALOG)).toBe(4);
  });

  it('does not count a different name', () => {
    expect(sameNameCopyCount([...repeat(RAICHU.id, 4)], PIKA_A.id, CATALOG)).toBe(0);
  });

  it('reports 0 for Basic Energy, which is exempt from the limit', () => {
    expect(sameNameCopyCount(repeat(GRASS_ENERGY.id, 30), GRASS_ENERGY.id, CATALOG)).toBe(0);
  });

  it('falls back to counting the exact id when the catalog is unavailable', () => {
    const deck = [...repeat(PIKA_A.id, 2), ...repeat(PIKA_B.id, 2)];
    expect(sameNameCopyCount(deck, PIKA_A.id)).toBe(2);
  });

  it('falls back to the id for a card the catalog does not know', () => {
    expect(sameNameCopyCount(repeat('scr-legacy', 3), 'scr-legacy', CATALOG)).toBe(3);
  });
});

describe('validateDeck size rules', () => {
  const validate = () => useDeckStore.getState().validateDeck(CATALOG);

  it('accepts a legal 60-card deck', () => {
    setDeck(legalDeck());
    expect(validate()).toEqual({ valid: true, errors: [] });
  });

  it('rejects a deck under 60 cards', () => {
    setDeck(legalDeck().slice(0, 59));
    expect(validate().errors.some(e => e.includes('至少需要 60'))).toBe(true);
  });

  it('rejects a deck over 60 cards', () => {
    setDeck([...legalDeck(), GRASS_ENERGY.id]);
    expect(validate().errors.some(e => e.includes('最多只能有 60'))).toBe(true);
  });

  it('requires at least one Basic Pokémon', () => {
    setDeck([...repeat(RAICHU.id, 4), ...repeat(GRASS_ENERGY.id, 56)]);
    expect(validate().errors).toContain('牌組至少需要 1 隻基礎寶可夢');
  });
});

describe('the 4-copy limit is per name, not per print', () => {
  const validate = () => useDeckStore.getState().validateDeck(CATALOG);

  it('rejects 4 of one print plus 4 of another print of the same Pokémon', () => {
    // Counting by id let this through as "4 and 4"; the rules see 8 copies of 皮卡丘.
    setDeck([...repeat(PIKA_A.id, 4), ...repeat(PIKA_B.id, 4), ...repeat(GRASS_ENERGY.id, 52)]);
    const { valid, errors } = validate();
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('皮卡丘') && e.includes('8'))).toBe(true);
  });

  it('accepts 2 of one print plus 2 of another — still 4 copies of the name', () => {
    setDeck([...repeat(PIKA_A.id, 2), ...repeat(PIKA_B.id, 2), RAICHU.id, ...repeat(GRASS_ENERGY.id, 55)]);
    expect(validate().valid).toBe(true);
  });

  it('exempts Basic Energy from the limit entirely', () => {
    setDeck(legalDeck()); // 55 copies of one Basic Energy
    expect(validate().errors.some(e => e.includes('基本草能量'))).toBe(false);
  });

  it('tolerates unknown legacy ids rather than rejecting the deck', () => {
    // Deliberate: decks saved before the print repoint still carry ids the catalog lost.
    setDeck([...repeat('scr-legacy', 8), ...repeat(PIKA_A.id, 1), ...repeat(GRASS_ENERGY.id, 51)]);
    expect(validate().errors.some(e => e.includes('scr-legacy'))).toBe(false);
  });
});

describe('addCard respects the per-name limit', () => {
  it('refuses a 5th copy of a name spread across two prints', () => {
    setDeck([...repeat(PIKA_A.id, 2), ...repeat(PIKA_B.id, 2)]);
    useDeckStore.getState().addCard(PIKA_A.id, false, CATALOG);
    expect(useDeckStore.getState().currentDeck.cards).toHaveLength(4);
  });

  it('allows a 4th copy', () => {
    setDeck([...repeat(PIKA_A.id, 2), ...repeat(PIKA_B.id, 1)]);
    useDeckStore.getState().addCard(PIKA_B.id, false, CATALOG);
    expect(useDeckStore.getState().currentDeck.cards).toHaveLength(4);
  });

  it('lets Basic Energy past the limit', () => {
    setDeck(repeat(GRASS_ENERGY.id, 10));
    useDeckStore.getState().addCard(GRASS_ENERGY.id, true, CATALOG);
    expect(useDeckStore.getState().currentDeck.cards).toHaveLength(11);
  });

  it('refuses to exceed 60 cards', () => {
    setDeck(legalDeck());
    useDeckStore.getState().addCard(GRASS_ENERGY.id, true, CATALOG);
    expect(useDeckStore.getState().currentDeck.cards).toHaveLength(60);
  });
});
