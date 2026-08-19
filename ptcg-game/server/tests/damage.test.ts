import { describe, it, expect } from 'vitest';
import { applyWeaknessResistance, effectiveMaxHp } from '../src/game/damage';
import { makeCard, makeGameCard, makeState } from './fixtures';

const attacker = (type: string) =>
  makeGameCard(makeCard({ name: '攻擊方', hp: '100', types: [type] as any }));

const defender = (opts: { weakness?: string; resistance?: string; weaknessType?: string; resistanceType?: string }) =>
  makeGameCard(makeCard({
    name: '防禦方',
    hp: '100',
    types: ['Colorless'],
    weaknesses: opts.weakness ? [{ type: (opts.weaknessType ?? 'Fire') as any, value: opts.weakness }] : undefined,
    resistances: opts.resistance ? [{ type: (opts.resistanceType ?? 'Fire') as any, value: opts.resistance }] : undefined,
  }));

describe('weakness', () => {
  // The printed value uses several different multiplication signs across the card pool; matching
  // only one variant silently disables weakness for every card printed with another.
  it.each(['×2', 'x2', 'X2', ' ×2 '])('doubles damage for a %s weakness', value => {
    expect(applyWeaknessResistance(50, attacker('Fire'), defender({ weakness: value }))).toBe(100);
  });

  it('does nothing when the attacker type does not match', () => {
    expect(applyWeaknessResistance(50, attacker('Water'), defender({ weakness: '×2' }))).toBe(50);
  });

  it('does nothing when the defender has no weakness', () => {
    expect(applyWeaknessResistance(50, attacker('Fire'), defender({}))).toBe(50);
  });

  it('is skipped when the attack ignores weakness', () => {
    expect(applyWeaknessResistance(50, attacker('Fire'), defender({ weakness: '×2' }), undefined, false, true)).toBe(50);
  });

  it('an override forces the given type to be weak regardless of what is printed', () => {
    // 妖精領域-style team-wide weakness override.
    expect(applyWeaknessResistance(50, attacker('Water'), defender({ weakness: '×2' }), 'Water')).toBe(100);
  });
});

describe('resistance', () => {
  // The printed value is the signed correction, so it must be ADDED. Subtracting it flips the
  // sign and makes Resistance *increase* damage — a bug this repo actually shipped.
  it.each(['-30', '－30', '−30'])('reduces damage for a %s resistance', value => {
    expect(applyWeaknessResistance(50, attacker('Fire'), defender({ resistance: value }))).toBe(20);
  });

  it('never drives damage below zero', () => {
    expect(applyWeaknessResistance(10, attacker('Fire'), defender({ resistance: '-30' }))).toBe(0);
  });

  it('does nothing when the attacker type does not match', () => {
    expect(applyWeaknessResistance(50, attacker('Water'), defender({ resistance: '-30' }))).toBe(50);
  });

  it('is skipped when the attack ignores resistance', () => {
    expect(applyWeaknessResistance(50, attacker('Fire'), defender({ resistance: '-30' }), undefined, true)).toBe(50);
  });
});

describe('weakness and resistance together', () => {
  it('doubles first, then subtracts — 50 -> 100 -> 70', () => {
    const d = makeGameCard(makeCard({
      name: '雙修正',
      hp: '100',
      types: ['Colorless'],
      weaknesses: [{ type: 'Fire' as any, value: '×2' }],
      resistances: [{ type: 'Fire' as any, value: '-30' }],
    }));
    expect(applyWeaknessResistance(50, attacker('Fire'), d)).toBe(70);
  });

  it('leaves 0 damage at 0 rather than inventing a hit', () => {
    expect(applyWeaknessResistance(0, attacker('Fire'), defender({ weakness: '×2' }))).toBe(0);
  });
});

describe('effectiveMaxHp', () => {
  const G = makeState();

  it('reads the printed HP', () => {
    expect(effectiveMaxHp(G, makeGameCard(makeCard({ name: 'A', hp: '130' })))).toBe(130);
  });

  it('returns 0 for a card with no HP (Trainer/Energy), so no KO check ever fires on it', () => {
    expect(effectiveMaxHp(G, makeGameCard(makeCard({ name: 'B', supertype: 'Trainer', subtypes: ['Item'] })))).toBe(0);
  });
});
