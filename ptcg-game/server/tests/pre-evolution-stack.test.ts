import { describe, it, expect } from 'vitest';
import {
  stackAsPreEvolution, flushPreEvolutionsTo, flushPreEvolutionsToDiscard, handleKo, prizesForKo,
} from '../src/game/damage';
import { BASIC_MON, STAGE1_MON, BASIC_ENERGY, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const STAGE2_MON = makeCard({
  id: 'TEST-006',
  name: '測試鼠終極',
  hp: '160',
  types: ['Colorless'],
  subtypes: ['Stage 2'],
  evolvesFrom: '測試鼠進化',
});

describe('stackAsPreEvolution', () => {
  it('stacks the old card under the new one instead of discarding it', () => {
    const basic = makeGameCard(BASIC_MON);
    const stage1 = makeGameCard(STAGE1_MON);
    stackAsPreEvolution(stage1, basic);
    expect(stage1.preEvolutions?.map(c => c.id)).toEqual([basic.id]);
  });

  it('keeps the stack ordered oldest-first through a second evolution', () => {
    const basic = makeGameCard(BASIC_MON);
    const stage1 = makeGameCard(STAGE1_MON);
    const stage2 = makeGameCard(STAGE2_MON);
    stackAsPreEvolution(stage1, basic);
    stackAsPreEvolution(stage2, stage1);
    expect(stage2.preEvolutions?.map(c => c.cardData.name)).toEqual([BASIC_MON.name, STAGE1_MON.name]);
    // The stack belongs to the top card alone — the middle card must not keep its own copy.
    expect(stage1.preEvolutions).toBeUndefined();
  });

  it('strips damage/energy/status/tool off the card being buried', () => {
    const basic = makeGameCard(BASIC_MON, 0, {
      damage: 30,
      statusConditions: ['Poisoned'] as any,
      attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
      attachedTool: makeGameCard(BASIC_ENERGY),
    });
    const stage1 = makeGameCard(STAGE1_MON);
    stackAsPreEvolution(stage1, basic);
    expect(basic.damage).toBe(0);
    expect(basic.statusConditions).toEqual([]);
    expect(basic.attachedEnergy).toEqual([]);
    expect(basic.attachedTool).toBeNull();
  });
});

describe('flushPreEvolutions', () => {
  it('moves the whole stack to the named zone and detaches it', () => {
    const basic = makeGameCard(BASIC_MON);
    const stage1 = makeGameCard(STAGE1_MON);
    const stage2 = makeGameCard(STAGE2_MON);
    stackAsPreEvolution(stage1, basic);
    stackAsPreEvolution(stage2, stage1);

    const deck: any[] = [];
    // 「將這隻寶可夢與附加的卡，全部放回自己的牌庫」 takes the stacked lower Stages along.
    flushPreEvolutionsTo(stage2, deck);
    expect(deck.map(c => c.cardData.name)).toEqual([BASIC_MON.name, STAGE1_MON.name]);
    expect(stage2.preEvolutions).toBeUndefined();
  });

  it('is a no-op for a Pokémon that never evolved', () => {
    const basic = makeGameCard(BASIC_MON);
    const discard: any[] = [];
    flushPreEvolutionsToDiscard(basic, discard);
    expect(discard).toEqual([]);
  });
});

describe('handleKo', () => {
  it('discards the whole evolution stack, not just the top card', () => {
    const basic = makeGameCard(BASIC_MON, 1);
    const stage1 = makeGameCard(STAGE1_MON, 1);
    stackAsPreEvolution(stage1, basic);

    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0) }),
        makePlayer({ active: stage1, bench: [makeGameCard(BASIC_MON, 1), null, null, null, null] }),
      ],
    });
    handleKo(G, 1, stage1.id);

    const discarded = G.players[1].discardPile.map(c => c.cardData.name);
    expect(discarded).toContain(BASIC_MON.name);
    expect(discarded).toContain(STAGE1_MON.name);
  });
});

describe('prizesForKo', () => {
  it.each([
    [['Basic'], 1],
    [['Basic', 'ex'], 2],
    [['Basic', 'V'], 2],
    [['VMAX'], 2],
  ])('%s Pokémon is worth %i prize(s)', (subtypes, expected) => {
    const card = makeGameCard(makeCard({ name: '測試', subtypes: subtypes as any }));
    expect(prizesForKo(card)).toBe(expected);
  });

  it('gives 3 prizes for a 超級 ex', () => {
    const card = makeGameCard(makeCard({ name: '超級測試鼠ex', subtypes: ['Stage 2', 'ex'] as any }));
    expect(prizesForKo(card)).toBe(3);
  });
});
