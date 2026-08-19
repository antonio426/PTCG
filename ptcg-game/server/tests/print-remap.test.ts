import { describe, it, expect } from 'vitest';
import { buildStandardByName, isStandard, pickReplacement, remapId, signature, stageOf } from '../src/card-api/printRemap';

/**
 * Legacy-id remapping is shared by /api/cards/remap and audit-preset-decks-standard.ts, and it
 * runs once over every user's saved decks. A wrong mapping silently swaps a card for a different
 * design; a non-deterministic one makes two runs disagree about the same deck.
 *
 * Cards here are the minimal MapCard shape the module actually reads.
 */
const card = (over: any) => ({
  supertype: 'Pokémon',
  subtypes: ['Basic'],
  legalities: { standard: 'Legal' },
  attacks: [],
  abilities: [],
  ...over,
}) as any;

const ROTATED = card({
  id: 'OLD-027', name: '輕飄飄', legalities: { standard: 'Banned' },
  set: { id: 'S5R' }, number: '27',
  attacks: [{ name: '飄浮', cost: ['Colorless'], damage: '10' }],
});

const SAME_DESIGN = card({
  id: 'SV5-100', name: '輕飄飄', set: { id: 'SV5' }, number: '100',
  attacks: [{ name: '飄浮', cost: ['Colorless'], damage: '10' }],
});

const DIFFERENT_DESIGN = card({
  id: 'SV9-100', name: '輕飄飄', set: { id: 'SV9' }, number: '100',
  attacks: [{ name: '自我再生', cost: ['Psychic'], damage: '' }],
});

describe('signature', () => {
  it('is order-independent, so two prints of one design match', () => {
    const a = card({ id: 'A', name: 'x', attacks: [{ name: '甲', cost: ['Fire'], damage: '10' }, { name: '乙', cost: [], damage: '20' }] });
    const b = card({ id: 'B', name: 'x', attacks: [{ name: '乙', cost: [], damage: '20' }, { name: '甲', cost: ['Fire'], damage: '10' }] });
    expect(signature(a)).toBe(signature(b));
  });

  it('separates prints whose attacks differ', () => {
    expect(signature(SAME_DESIGN)).not.toBe(signature(DIFFERENT_DESIGN));
  });
});

describe('stageOf', () => {
  it('reads the evolution stage out of subtypes', () => {
    expect(stageOf(card({ subtypes: ['Stage 1'] }))).toBe('Stage 1');
  });

  it('returns null when the print declares no stage', () => {
    expect(stageOf(card({ subtypes: [] }))).toBeNull();
  });
});

describe('isStandard', () => {
  it.each([
    [{ standard: 'Legal' }, true],
    [{ standard: 'Banned' }, false],
    [{}, false],
  ])('%o -> %s', (legalities, expected) => {
    expect(isStandard(card({ legalities }))).toBe(expected);
  });
});

describe('pickReplacement', () => {
  const byName = () => buildStandardByName([SAME_DESIGN, DIFFERENT_DESIGN]);

  it('prefers the print with an identical attack signature over a newer set', () => {
    // The whole point of the legacy-ID work: without the signature check the newest set wins and
    // the battle shows a different card's real attacks.
    const picked = pickReplacement(ROTATED, byName());
    expect(picked?.card.id).toBe(SAME_DESIGN.id);
    expect(picked?.exact).toBe(true);
  });

  it('falls back to the newest set when no signature matches, and says so', () => {
    const picked = pickReplacement(card({ ...ROTATED, attacks: [{ name: '不存在', cost: [], damage: '' }] }), byName());
    expect(picked?.card.id).toBe(DIFFERENT_DESIGN.id);
    expect(picked?.exact).toBe(false);
  });

  it('is deterministic — repeated runs pick the same print', () => {
    const noMatch = card({ ...ROTATED, attacks: [{ name: '不存在', cost: [], damage: '' }] });
    const a = pickReplacement(noMatch, byName())?.card.id;
    const b = pickReplacement(noMatch, buildStandardByName([DIFFERENT_DESIGN, SAME_DESIGN]))?.card.id;
    expect(a).toBe(b);
  });

  it('never crosses supertypes', () => {
    const trainerNamesake = card({ id: 'T-1', name: '輕飄飄', supertype: 'Trainer', subtypes: ['Item'], set: { id: 'SV9' } });
    expect(pickReplacement(ROTATED, buildStandardByName([trainerNamesake]))).toBeNull();
  });

  it('never crosses evolution stages', () => {
    const stage1 = card({ ...SAME_DESIGN, id: 'SV5-101', subtypes: ['Stage 1'] });
    expect(pickReplacement(ROTATED, buildStandardByName([stage1]))).toBeNull();
  });

  it('does not filter by stage when the old print declares none', () => {
    const noStage = card({ ...ROTATED, subtypes: [] });
    expect(pickReplacement(noStage, byName())?.card.id).toBe(SAME_DESIGN.id);
  });

  it('returns null when nothing shares the name', () => {
    expect(pickReplacement(card({ id: 'X', name: '沒人叫這個' }), byName())).toBeNull();
  });
});

describe('buildStandardByName', () => {
  it('indexes only Standard-legal prints', () => {
    const map = buildStandardByName([SAME_DESIGN, ROTATED]);
    expect(map.get('輕飄飄')?.map(c => c.id)).toEqual([SAME_DESIGN.id]);
  });
});

describe('remapId', () => {
  const byId = new Map<string, any>([
    [ROTATED.id, ROTATED],
    [SAME_DESIGN.id, SAME_DESIGN],
    [DIFFERENT_DESIGN.id, DIFFERENT_DESIGN],
  ]);
  const byName = buildStandardByName([SAME_DESIGN, DIFFERENT_DESIGN]);

  it('leaves an already-Standard id untouched', () => {
    expect(remapId(SAME_DESIGN.id, byId, byName)).toBe(SAME_DESIGN.id);
  });

  it('maps a rotated print to its Standard equivalent', () => {
    expect(remapId(ROTATED.id, byId, byName)).toBe(SAME_DESIGN.id);
  });

  it('returns null for an id nothing can resolve, so the caller keeps the original', () => {
    // validateDeck deliberately tolerates unknown ids as a final fallback.
    expect(remapId('totally-unknown-id', byId, byName)).toBeNull();
  });

  it('returns null rather than guessing when a non-Standard print has no replacement', () => {
    const orphan = card({ id: 'OLD-999', name: '孤兒卡', legalities: { standard: 'Banned' }, set: { id: 'S1' } });
    expect(remapId(orphan.id, new Map([[orphan.id, orphan]]), byName)).toBeNull();
  });
});
