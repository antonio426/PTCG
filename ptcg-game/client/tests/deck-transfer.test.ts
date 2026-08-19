import { describe, it, expect } from 'vitest';
import type { Card, Subtype } from '@ptcg/shared';
import { deckToText, textToDeck, deckToJson, jsonToDeck, MAX_DECK_CARDS } from '../src/utils/deckTransfer';

const card = (id: string, name: string, over: Partial<Card> = {}): Card => ({
  id, name,
  supertype: 'Pokémon',
  subtypes: ['Basic'] as Subtype[],
  set: { id: 'TEST', name: 'Test', series: 'Test', printedTotal: 1, total: 1, releaseDate: '' },
  number: id.split('-').pop() ?? '1',
  legalities: { standard: 'Legal' },
  images: { small: '', large: '' },
  ...over,
} as Card);

const PIKA_A = card('SV1-025', '皮卡丘');
const PIKA_B = card('SV5-025', '皮卡丘', { legalities: {} });
const BALL = card('SV1-100', '高級球', { supertype: 'Trainer', subtypes: ['Item'] as Subtype[] });
const ENERGY = card('SVE-001', '基本草能量', { supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] });
const PROMO = card('SV-P-110', '輕身鱈ex', { subtypes: ['Basic', 'ex'] as Subtype[] });
const CATALOG = [PIKA_A, PIKA_B, BALL, ENERGY, PROMO];

const repeat = (id: string, n: number) => Array.from({ length: n }, () => id);

/**
 * A deck is the user's own data; a round trip that drops, duplicates or re-points a card is
 * silent data loss. These pin the trip in both directions.
 */
describe('deck text round trip', () => {
  it('survives a full deck exactly', () => {
    const deck = [...repeat(PIKA_A.id, 4), ...repeat(BALL.id, 4), ...repeat(ENERGY.id, 52)];
    const restored = textToDeck(deckToText('測試牌組', deck, CATALOG), CATALOG);
    expect(restored.unresolved).toEqual([]);
    expect(restored.cardIds.slice().sort()).toEqual(deck.slice().sort());
  });

  it('keeps two prints of the same name apart', () => {
    // Without the id on each line this collapses to eight copies of one print.
    const deck = [...repeat(PIKA_A.id, 4), ...repeat(PIKA_B.id, 4)];
    const restored = textToDeck(deckToText('雙印刷', deck, CATALOG), CATALOG);
    expect(restored.cardIds.filter(id => id === PIKA_A.id)).toHaveLength(4);
    expect(restored.cardIds.filter(id => id === PIKA_B.id)).toHaveLength(4);
  });

  it('keeps a print the catalog no longer knows', () => {
    // Decks saved before a print rotated out still reference it; deckStore tolerates unknown ids
    // on purpose, so the transfer layer must not be the thing that deletes them.
    const deck = [...repeat('scr-legacy-1', 2), ...repeat(PIKA_A.id, 2)];
    const text = deckToText('舊牌組', deck, CATALOG);
    expect(text).toContain('scr-legacy-1');
    const restored = textToDeck(text, CATALOG);
    expect(restored.cardIds.filter(id => id === 'scr-legacy-1')).toHaveLength(2);
  });

  it('handles a promo id with two hyphens', () => {
    const restored = textToDeck(deckToText('promo', repeat(PROMO.id, 3), CATALOG), CATALOG);
    expect(restored.cardIds).toEqual(repeat(PROMO.id, 3));
  });

  it('groups by supertype under Chinese headings', () => {
    const text = deckToText('分組', [PIKA_A.id, BALL.id, ENERGY.id], CATALOG);
    expect(text).toContain('## 寶可夢');
    expect(text).toContain('## 訓練家');
    expect(text).toContain('## 能量');
  });
});

describe('text import parsing', () => {
  it('accepts a bare count and name', () => {
    expect(textToDeck('4 皮卡丘', CATALOG).cardIds).toEqual(repeat(PIKA_A.id, 4));
  });

  it.each(['4x 皮卡丘', '4× 皮卡丘', '4 皮卡丘'])('accepts the %s form', line => {
    expect(textToDeck(line, CATALOG).cardIds).toHaveLength(4);
  });

  it('prefers a Standard-legal print when only the name is given', () => {
    // PIKA_B has the same name but no Standard legality.
    expect(textToDeck('1 皮卡丘', CATALOG).cardIds).toEqual([PIKA_A.id]);
  });

  it('lets the printed id override the name', () => {
    expect(textToDeck(`1 皮卡丘 ${PIKA_B.id}`, CATALOG).cardIds).toEqual([PIKA_B.id]);
  });

  it('skips comments and blank lines', () => {
    expect(textToDeck('# 我的牌組\n\n4 皮卡丘\n', CATALOG).cardIds).toHaveLength(4);
  });

  it('reports lines it cannot resolve instead of dropping them silently', () => {
    const res = textToDeck('4 不存在的卡\nnonsense', CATALOG);
    expect(res.unresolved).toEqual(['4 不存在的卡', 'nonsense']);
    expect(res.cardIds).toEqual([]);
  });

  it('caps at a legal deck size and says it truncated', () => {
    const res = textToDeck(`70 ${ENERGY.name}`, CATALOG);
    expect(res.cardIds).toHaveLength(MAX_DECK_CARDS);
    expect(res.truncated).toBe(true);
  });
});

describe('deck JSON round trip', () => {
  it('survives exactly', () => {
    const deck = [...repeat(PIKA_A.id, 4), ...repeat(ENERGY.id, 56)];
    const restored = jsonToDeck(deckToJson('JSON 牌組', deck), 'fallback');
    expect(restored.name).toBe('JSON 牌組');
    expect(restored.cardIds).toEqual(deck);
  });

  it('falls back to a supplied name when the file has none', () => {
    expect(jsonToDeck(JSON.stringify({ cards: [PIKA_A.id] }), '檔名').name).toBe('檔名');
  });

  it.each([
    ['not json at all', 'nonsense'],
    ['no cards array', JSON.stringify({ name: 'x' })],
    ['cards not strings', JSON.stringify({ name: 'x', cards: [1, 2] })],
  ])('rejects %s', (_label, raw) => {
    expect(() => jsonToDeck(raw, 'f')).toThrow();
  });

  it('caps an oversized file at a legal deck size', () => {
    const huge = JSON.stringify({ name: 'x', cards: repeat(ENERGY.id, 200) });
    expect(jsonToDeck(huge, 'f').cardIds).toHaveLength(MAX_DECK_CARDS);
  });
});
