import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moves } from '../src/game/moves';
import { asAttachedEnergy, discardAttachedEnergy } from '../src/game/effects/primitives';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * Energy removed from a Pokémon must reach the discard pile — it doesn't vanish, and effects
 * that search or count the discard pile depend on it being there.
 *
 * The bug this file exists for: `AttachedEnergy.cardData` is optional (backward compatibility),
 * and every ability/Trainer attach site built the object inline as `{ id, type }`, so any energy
 * NOT attached by hand had no card behind it. `discardAttachedEnergy` then dropped it silently
 * and the card left the game. Reported live on 超級快龍ex's 龍之滑翔.
 */

const DRAGONITE = makeCard({
  name: '超級快龍ex', hp: '370', types: ['Dragon'], subtypes: ['Stage 2', 'ex'],
  attacks: [mkAttack('龍之滑翔', ['Water', 'Lightning', 'Lightning'], '330', '選擇2個這隻寶可夢身上附加的能量，將其丟棄。')],
});
const TANK = makeCard({ name: '木頭鼠', hp: '400', types: ['Colorless'], subtypes: ['Basic'] });
const LIGHTNING_ENERGY = makeCard({
  id: 'TEST-100', name: '基礎雷能量', supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Lightning'],
});

describe('asAttachedEnergy', () => {
  it('always carries the card behind the energy', () => {
    const attached = asAttachedEnergy(makeGameCard(LIGHTNING_ENERGY, 0));
    expect(attached.cardData).toBeDefined();
    expect(attached.type).toBe('Lightning');
  });

  it('honors a type override for effects that attach energy AS another type', () => {
    const attached = asAttachedEnergy(makeGameCard(BASIC_ENERGY, 0), 'Lightning');
    expect(attached.type).toBe('Lightning');
    expect(attached.cardData?.name).toBe(BASIC_ENERGY.name);
  });

  it('falls back to Colorless for an energy card printing no type', () => {
    const typeless = makeCard({ name: '無屬性能量', supertype: 'Energy', subtypes: ['Special Energy'] });
    expect(asAttachedEnergy(makeGameCard(typeless, 0)).type).toBe('Colorless');
  });

  it('round-trips into the discard pile', () => {
    const G = makeState();
    discardAttachedEnergy(G, 0, asAttachedEnergy(makeGameCard(LIGHTNING_ENERGY, 0)));
    expect(G.players[0].discardPile.map(c => c.cardData.name)).toEqual([LIGHTNING_ENERGY.name]);
  });
});

describe('龍之滑翔 discards its own energy into the discard pile', () => {
  /** `viaEffect` models energy put there by an ability/Trainer rather than attached from hand. */
  function board(viaEffect: boolean) {
    const attacker = makeGameCard(DRAGONITE, 0, {
      attachedEnergy: [
        asAttachedEnergy(makeGameCard(BASIC_ENERGY, 0), 'Water'),
        ...(viaEffect
          ? [asAttachedEnergy(makeGameCard(LIGHTNING_ENERGY, 0)), asAttachedEnergy(makeGameCard(LIGHTNING_ENERGY, 0))]
          : [
              { id: 'l1', type: 'Lightning', cardData: LIGHTNING_ENERGY },
              { id: 'l2', type: 'Lightning', cardData: LIGHTNING_ENERGY },
            ]),
      ],
    });
    const G: PtcgGameState = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: attacker, prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(TANK, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    return { G, attacker, ctx: { currentPlayer: '0', turn: G.turn, events: { endTurn: vi.fn() } } };
  }

  it.each([[false], [true]])('energy attached via an effect = %s', viaEffect => {
    const { G, attacker, ctx } = board(viaEffect);
    // Three attached, two to discard — a real choice, so the attack raises one.
    moves.attack({ G, ctx } as any, 0);
    expect(G.pendingChoice?.effectKey).toBe('attack_self_energy_discard');

    const toDiscard = attacker.attachedEnergy.slice(1).map(e => e.id);
    moves.resolveChoice({ G, ctx } as any, toDiscard);

    expect(attacker.attachedEnergy).toHaveLength(1);
    expect(G.players[0].discardPile).toHaveLength(2);
    expect(G.players[0].discardPile.map(c => c.cardData.name)).toEqual(['基礎雷能量', '基礎雷能量']);
  });

  it('deals its damage as well', () => {
    const { G, ctx } = board(true);
    moves.attack({ G, ctx } as any, 0);
    expect(G.players[1].active?.damage).toBe(330);
  });
});

/**
 * Source guard: no attach site may build an AttachedEnergy inline again. This is the durable half
 * of the fix — 37 sites had drifted into the broken shape, and nothing about `{ id, type }` fails
 * to compile, so only a scan like this can keep them from coming back.
 */
describe('every attach site goes through asAttachedEnergy', () => {
  const GAME_DIR = join(__dirname, '..', 'src', 'game');
  const FILES = ['moves.ts', 'effects/abilities.ts', 'effects/trainers.ts', 'effects/attacks.ts', 'effects/primitives.ts'];

  it.each(FILES)('%s', file => {
    const src = readFileSync(join(GAME_DIR, file), 'utf8');
    // Inline object literals pushed onto attachedEnergy that don't SET a cardData property.
    // Matching on the bare word `cardData` is not enough: the most common broken shape was
    // `{ id: e.id, type: e.cardData.types?.[0] || 'Colorless' }`, which mentions cardData while
    // reading the type and still ships an attachment with no card behind it.
    const offenders = [...src.matchAll(/attachedEnergy\.push\(\{[^)]*?\}\)/gs)]
      .map(m => m[0])
      .filter(m => !/cardData\s*:/.test(m));
    expect(offenders, `build these with asAttachedEnergy() instead`).toEqual([]);
  });
});
