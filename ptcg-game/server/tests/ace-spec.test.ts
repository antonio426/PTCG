import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAceSpec, ACE_SPEC_NAMES } from '@ptcg/shared';

const cards: any[] = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'cards.json'), 'utf8')).data;
const standard = cards.filter(c => c.legalities?.standard === 'Legal');
const norm = (n: string) => String(n).replace(/^[‌​\s]+/, '').trim();

/**
 * ACE SPEC status gates a real effect (「ACE消弭」 stops the opponent playing one) and a UI filter.
 * It used to be read straight off TCGdex's `rarity: 'ACE'`, which is incomplete.
 */
describe('isAceSpec', () => {
  it('accepts a card marked by rarity', () => {
    expect(isAceSpec({ name: '任何名字', rarity: 'ACE' })).toBe(true);
  });

  it('accepts a card the rarity field missed but the name list knows', () => {
    expect(isAceSpec({ name: '大師球', rarity: 'U' })).toBe(true);
  });

  it('sees through a scraped zero-width prefix', () => {
    expect(isAceSpec({ name: '‌大師球' })).toBe(true);
  });

  it('rejects an ordinary card', () => {
    expect(isAceSpec({ name: '博士的研究', rarity: 'U' })).toBe(false);
  });

  it('covers every rarity-marked card, so the name list is the broader of the two', () => {
    const missedByName = standard.filter(c => c.rarity === 'ACE' && !ACE_SPEC_NAMES.includes(norm(c.name)));
    expect(missedByName.map(c => `${c.id} ${c.name}`)).toEqual([]);
  });

  it('catches the Standard prints the rarity field alone does not', () => {
    // 23 of them at the time of writing, including two that a preset deck can put on the table.
    const rarityOnly = standard.filter(c => c.rarity === 'ACE');
    const union = standard.filter(c => isAceSpec(c));
    expect(union.length).toBeGreaterThan(rarityOnly.length);
    for (const id of ['SVK-017', 'MC-658']) {
      const card = cards.find(c => c.id === id);
      expect(card, `${id} should exist`).toBeDefined();
      expect(isAceSpec(card), `${id} ${card.name} should be ACE SPEC`).toBe(true);
      expect(card.rarity, `${id} is exactly the case the rarity field misses`).not.toBe('ACE');
    }
  });
});
