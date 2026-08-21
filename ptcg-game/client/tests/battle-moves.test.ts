import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card, LegalAction, Subtype } from '@ptcg/shared';
import { bucketLegalMoves, UNSURFACED_BY_DESIGN } from '../src/lib/battleMoves';

/**
 * The UI renders entirely from the server's `legalMoves`, so the interesting failure isn't a
 * disagreement about legality — it's a move type that no surface claims, which the player is
 * offered and can never take. `discard_fossil` was in exactly that state: the server has always
 * offered it for a Fossil in play and Battle.tsx only ever used the string as a log label.
 *
 * The list of types is read out of the server's own validation.ts rather than hardcoded, so a
 * newly added move type fails here until the UI decides where it goes.
 */
const VALIDATION = join(__dirname, '..', '..', 'server', 'src', 'game', 'validation.ts');
const serverMoveTypes = [...new Set(
  [...readFileSync(VALIDATION, 'utf8').matchAll(/type: '([a-z_]+)'/g)].map(m => m[1]),
)].sort();

const card = (id: string, name: string, over: Partial<Card> = {}): Card => ({
  id, name, supertype: 'Pokémon', subtypes: ['Basic'] as Subtype[],
  set: { id: 'TEST', name: 'Test', series: 'Test', printedTotal: 1, total: 1, releaseDate: '' },
  number: '1', legalities: { standard: 'Legal' }, images: { small: '', large: '' },
  ...over,
} as Card);

const HAND = [card('SV1-001', '皮卡丘'), card('SV1-002', '基本雷能量', { supertype: 'Energy' })];
/** One move of every type the server can emit, hand-linked ones pointing at a real hand card. */
const oneOfEach = (): LegalAction[] => serverMoveTypes.map(type => ({
  type,
  description: type,
  payload: { cardId: HAND[0].id },
} as LegalAction));

describe('every legal move type has a UI surface', () => {
  it('reads a plausible set of move types out of the server', () => {
    expect(serverMoveTypes.length).toBeGreaterThan(10);
    expect(serverMoveTypes).toContain('attack');
    expect(serverMoveTypes).toContain('discard_fossil');
  });

  it('buckets every one of them, except the ones excluded on purpose', () => {
    const { unsurfaced } = bucketLegalMoves(oneOfEach(), HAND);
    expect(unsurfaced.map(m => m.type).sort()).toEqual([...UNSURFACED_BY_DESIGN].sort());
  });

  it('keeps hand-card moves on their own card', () => {
    const moves: LegalAction[] = [
      { type: 'attach_energy', description: 'attach', payload: { cardId: HAND[1].id, targetId: 'x' } },
      { type: 'play_pokemon', description: 'play', payload: { cardId: HAND[0].id, benchPosition: 0 } },
      { type: 'end_turn', description: 'end' },
    ] as LegalAction[];
    const { handCardActions, quickActions, unsurfaced } = bucketLegalMoves(moves, HAND);
    expect(handCardActions.map(a => a.cardData.id).sort()).toEqual([HAND[0].id, HAND[1].id].sort());
    expect(quickActions.map(m => m.type)).toEqual(['end_turn']);
    expect(unsurfaced).toEqual([]);
  });

  it('does not lose a hand move whose card is no longer in hand', () => {
    // A stale move (card already played by another surface) must show up as unsurfaced rather than
    // vanishing quietly — that is the shape of "the UI silently drops something the server offered".
    const moves = [{ type: 'play_pokemon', description: 'play', payload: { cardId: 'GONE-1' } }] as LegalAction[];
    expect(bucketLegalMoves(moves, HAND).unsurfaced.map(m => m.type)).toEqual(['play_pokemon']);
  });
});
