import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { abilityEffects, canUseAbility } from '../src/game/effects/abilities';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });

const DARK_ENERGY = makeCard({
  id: 'TEST-DK', name: '基礎惡能量', supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Darkness'],
});

const MONKEY = makeCard({
  id: 'TEST-MONKEY', name: '願增猿', hp: '110', types: ['Psychic'], subtypes: ['Basic'],
  abilities: [{
    name: '腎上腺腦力', type: 'Ability',
    text: '若這隻寶可夢身上附有【惡】能量卡，則在自己的回合時可使用1次。選擇最多3個自己的1隻場上寶可夢身上放置的傷害指示物，改放於對手的1隻場上寶可夢身上。',
  }],
});

/**
 * 腎上腺腦力 is conditional on public board state: a Darkness Energy on the holder, and some
 * damage of your own to move. Abilities had no gate at all — getLegalMoves offered any
 * not-yet-used once-per-turn ability and useAbility marked it used even when start() bailed out
 * immediately, so an ability whose condition wasn't met looked exactly like it failed to fire,
 * AND cost the turn's use.
 */
describe('腎上腺腦力 (願增猿)', () => {
  function board(opts: { dark: boolean; ownDamage: number }) {
    const monkey = makeGameCard(MONKEY, 0, {
      attachedEnergy: [opts.dark
        ? { id: 'd1', type: 'Darkness', cardData: DARK_ENERGY }
        : { id: 'g1', type: 'Grass', cardData: BASIC_ENERGY }],
    });
    const hurt = makeGameCard(BASIC_MON, 0, { damage: opts.ownDamage });
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: monkey, bench: [hurt, null, null, null, null], prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    return { G, monkey, hurt, ctx: ctxFor(G) };
  }

  const offered = (G: PtcgGameState, id: string) =>
    getLegalMoves(G, 0).some(m => m.type === 'use_ability' && m.payload?.cardId === id);

  it('is offered with a Darkness Energy attached and damage to move', () => {
    const { G, monkey } = board({ dark: true, ownDamage: 30 });
    expect(offered(G, monkey.id)).toBe(true);
  });

  it.each([
    ['no Darkness Energy attached', { dark: false, ownDamage: 30 }],
    ['nothing of yours is damaged', { dark: true, ownDamage: 0 }],
  ])('is not offered when %s', (_label, opts) => {
    const { G, monkey } = board(opts as { dark: boolean; ownDamage: number });
    expect(offered(G, monkey.id)).toBe(false);
  });

  it.each([
    ['no Darkness Energy attached', { dark: false, ownDamage: 30 }],
    ['nothing of yours is damaged', { dark: true, ownDamage: 0 }],
  ])('a forced use with %s does not spend the once-per-turn slot', (_label, opts) => {
    const { G, monkey, ctx } = board(opts as { dark: boolean; ownDamage: number });
    moves.useAbility({ G, ctx } as any, monkey.id);
    expect(G.pendingChoice).toBeNull();
    expect(G.players[0].abilitiesUsedThisTurn).toEqual([]);
  });

  it('moves the chosen counters from your Pokémon onto the opponent\'s', () => {
    const { G, monkey, hurt, ctx } = board({ dark: true, ownDamage: 30 });
    moves.useAbility({ G, ctx } as any, monkey.id);

    // pick source -> pick how many -> pick opponent target
    for (let step = 0; step < 3; step++) {
      const options = getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice');
      expect(options.length, `step ${step} had no resolution`).toBeGreaterThan(0);
      // last option = the largest count, i.e. move all 3 counters
      moves.resolveChoice({ G, ctx } as any, options[options.length - 1].payload!.selection as string[]);
    }

    expect(hurt.damage).toBe(0);
    expect(G.players[1].active?.damage).toBe(30);
    expect(G.players[0].abilitiesUsedThisTurn).toContain(monkey.id);
  });

  it('caps the move at 3 counters even with more damage available', () => {
    const { G, monkey, hurt, ctx } = board({ dark: true, ownDamage: 90 });
    moves.useAbility({ G, ctx } as any, monkey.id);
    for (let step = 0; step < 3; step++) {
      const options = getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice');
      moves.resolveChoice({ G, ctx } as any, options[options.length - 1].payload!.selection as string[]);
    }
    expect(hurt.damage).toBe(60);
    expect(G.players[1].active?.damage).toBe(30);
  });
});

/**
 * Registry-wide, mirroring trainer-gating.test.ts: a gated ability must be neither offered nor
 * able to spend its once-per-turn use when its own gate says no.
 */
describe('canPlay gating holds for every gated ability in the registry', () => {
  const GATED = Object.keys(abilityEffects).filter(name => !!abilityEffects[name].canPlay);

  it('the registry actually has gated abilities to check', () => {
    expect(GATED.length).toBeGreaterThan(0);
  });

  it.each(GATED)('%s', name => {
    const holder = makeGameCard(makeCard({
      name: `持有者-${name}`, hp: '100', types: ['Colorless'], subtypes: ['Basic'],
      abilities: [{ name, type: 'Ability', text: '' }],
    }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: holder }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    if (canUseAbility(name, { G, playerIndex: 0, sourceCardId: holder.id } as any)) return;

    expect(
      getLegalMoves(G, 0).some(m => m.type === 'use_ability' && m.payload?.cardId === holder.id),
      `${name} was offered despite its gate being false`,
    ).toBe(false);

    moves.useAbility({ G, ctx: ctxFor(G) } as any, holder.id);
    expect(G.players[0].abilitiesUsedThisTurn, `${name} burned its once-per-turn use on a no-op`).toEqual([]);
  });
});
