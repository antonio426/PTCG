import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { hasAttackEffect, startAttackEffect } from '../src/game/effects/attacks';
import { moves } from '../src/game/moves';
import { stackAsPreEvolution } from '../src/game/damage';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, STAGE1_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const KANGASKHAN = makeCard({ name: '火箭隊的袋獸ex', hp: '230', types: ['Colorless'], subtypes: ['Basic', 'ex'] });
const ESPEON = makeCard({ name: '太陽伊布ex', hp: '270', types: ['Psychic'], subtypes: ['Stage 1', 'ex'] });
const PLAIN = makeCard({ name: '木頭鼠', hp: '300', types: ['Colorless'], subtypes: ['Basic'] });

const ctx0 = { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } as any;

const fire = (G: PtcgGameState, pokemon: string, attack: string) =>
  startAttackEffect(pokemon, attack, { G, playerIndex: 0, sourceCardId: G.players[0].active!.id } as any);

describe('registry lookup normalizes both halves of the key', () => {
  it('finds a handler through a zero-width-prefixed name', () => {
    // A raw-name key would miss, and the failure is invisible because the character doesn't print.
    expect(hasAttackEffect('‌火箭隊的袋獸ex', '惡棍衝擊')).toBe(true);
    expect(hasAttackEffect('火箭隊的袋獸ex', '‌ 惡棍衝擊')).toBe(true);
  });

  it('still says no for an unregistered attack', () => {
    expect(hasAttackEffect('火箭隊的袋獸ex', '不存在的招式')).toBe(false);
  });
});

describe('惡棍衝擊 (火箭隊的袋獸ex)', () => {
  function board(supporterNames: string[] = []) {
    const defender = makeGameCard(PLAIN, 1);
    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(KANGASKHAN, 0), supporterNamesPlayedThisTurn: supporterNames }),
        makePlayer({ active: defender, prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    return { G, defender };
  }

  it('deals its printed 120 with no qualifying Supporter played', () => {
    const { G, defender } = board();
    fire(G, '火箭隊的袋獸ex', '惡棍衝擊');
    expect(defender.damage).toBe(120);
  });

  it('adds 100 when a 火箭隊-named Supporter was played this turn', () => {
    const { G, defender } = board(['火箭隊的老大的指令']);
    fire(G, '火箭隊的袋獸ex', '惡棍衝擊');
    expect(defender.damage).toBe(220);
  });

  it('is not fooled by a Supporter from another family', () => {
    const { G, defender } = board(['博士的研究']);
    fire(G, '火箭隊的袋獸ex', '惡棍衝擊');
    expect(defender.damage).toBe(120);
  });

  it('reads through a scraped name carrying a zero-width prefix', () => {
    const { G, defender } = board(['‌火箭隊的老大的指令']);
    fire(G, '火箭隊的袋獸ex', '惡棍衝擊');
    expect(defender.damage).toBe(220);
  });
});

describe('阿賽斯特萊石 (太陽伊布ex)', () => {
  /** An opponent Stage 1 sitting on top of its Basic, with live attachments and damage. */
  function evolvedCard(damage = 0) {
    const basic = makeGameCard(BASIC_MON, 1);
    const stage1 = makeGameCard(STAGE1_MON, 1, {
      damage,
      attachedEnergy: [{ id: `e${Math.random()}`, type: 'Grass', cardData: BASIC_ENERGY }],
      statusConditions: ['Asleep'] as any,
    });
    stackAsPreEvolution(stage1, basic);
    return { basic, stage1 };
  }

  function board(opts: { activeDamage?: number; benchEvolved?: boolean } = {}) {
    const { basic, stage1 } = evolvedCard(opts.activeDamage ?? 0);
    const benched = opts.benchEvolved ? evolvedCard() : null;
    const G = makeState({
      players: [
        // The attacker needs prize cards of its own: handleKo increments takenPrizes only when
        // it actually pops one (see CLAUDE.md's note on status-conditions.test.ts).
        makePlayer({ active: makeGameCard(ESPEON, 0), prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)) }),
        makePlayer({
          active: stage1,
          bench: [benched ? benched.stage1 : makeGameCard(BASIC_MON, 1), null, null, null, null],
          deck: [makeGameCard(BASIC_MON, 1), makeGameCard(BASIC_MON, 1)],
          prizes: [makeGameCard(BASIC_MON, 1)],
        }),
      ],
    });
    return { G, basic, stage1, benched };
  }

  it('de-evolves the opponent Active by exactly one stage', () => {
    const { G, basic, stage1 } = board();
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(G.players[1].active?.id).toBe(basic.id);
    expect(G.players[1].active?.preEvolutions ?? []).toEqual([]);
    expect(G.players[1].deck.map(c => c.id)).toContain(stage1.id);
  });

  it('carries damage and attachments down to the card underneath', () => {
    const { G, basic } = board({ activeDamage: 30 });
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(basic.damage).toBe(30);
    expect(basic.attachedEnergy).toHaveLength(1);
  });

  it('clears Special Conditions, as evolution changes do', () => {
    const { G, basic } = board();
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(basic.statusConditions).toEqual([]);
  });

  it('hits every evolved Pokémon in play, not just the Active', () => {
    const { G, benched } = board({ benchEvolved: true });
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(G.players[1].bench[0]?.id).toBe(benched!.basic.id);
  });

  it('leaves a Pokémon that never evolved alone', () => {
    const { G } = board();
    const untouched = G.players[1].bench[0]!;
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(G.players[1].bench[0]?.id).toBe(untouched.id);
  });

  it('KOs a Pokémon whose carried damage now exceeds its lower HP', () => {
    // 70 damage survives the Stage 1's 100 HP but is lethal on the Basic's 60.
    const { G, basic } = board({ activeDamage: 70 });
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(G.players[1].discardPile.map(c => c.id)).toContain(basic.id);
    expect(G.players[0].takenPrizes).toBe(1);
  });

  it('does nothing at all when the opponent has no evolved Pokémon', () => {
    const G = makeState({
      players: [
        makePlayer({ active: makeGameCard(ESPEON, 0) }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1), deck: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    const before = G.players[1].deck.length;
    fire(G, '太陽伊布ex', '阿賽斯特萊石');
    expect(G.players[1].deck).toHaveLength(before);
  });
});

describe('蠱惑挪移 (振翼髮)', () => {
  // Unimplementable until the 古代/未來 subtypes were backfilled from the official card search:
  // no data source carried them, so the Ancient filter matched nothing.
  const ANCIENT = makeCard({
    name: '振翼髮', hp: '90', types: ['Psychic'], subtypes: ['Basic', 'Ancient'] as any,
    attacks: [{ name: '蠱惑挪移', cost: ['Colorless', 'Colorless'] as any, convertedEnergyCost: 2, damage: '', text: '選擇1隻自己的備戰區的「古代」寶可夢，將所選的寶可夢身上放置的傷害指示物，全部改放於對手的戰鬥寶可夢身上。' }],
  });
  const ANCIENT_BENCH = makeCard({ name: '古代鼠', hp: '120', types: ['Fighting'], subtypes: ['Basic', 'Ancient'] as any });
  const PLAIN_BENCH = makeCard({ name: '普通鼠', hp: '120', types: ['Colorless'], subtypes: ['Basic'] });
  const TANK = makeCard({ name: '木頭鼠', hp: '300', types: ['Colorless'], subtypes: ['Basic'] });

  function board(bench: (ReturnType<typeof makeGameCard> | null)[]) {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(ANCIENT, 0),
          bench: [...bench, null, null, null, null].slice(0, 5) as any,
          prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)),
        }),
        makePlayer({ active: makeGameCard(TANK, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    return G;
  }

  it('moves every counter from the only Ancient Bench Pokémon onto the defender', () => {
    const donor = makeGameCard(ANCIENT_BENCH, 0, { damage: 50 });
    const G = board([donor]);
    fire(G, '振翼髮', '蠱惑挪移');
    expect(donor.damage).toBe(0);
    expect(G.players[1].active?.damage).toBe(50);
  });

  it('resolves without asking when there is only one candidate', () => {
    const G = board([makeGameCard(ANCIENT_BENCH, 0, { damage: 20 })]);
    fire(G, '振翼髮', '蠱惑挪移');
    expect(G.pendingChoice).toBeNull();
  });

  it('asks which one when several Ancient Pokémon are damaged', () => {
    const G = board([
      makeGameCard(ANCIENT_BENCH, 0, { damage: 20 }),
      makeGameCard(ANCIENT_BENCH, 0, { damage: 40 }),
    ]);
    const step = fire(G, '振翼髮', '蠱惑挪移');
    expect(step).not.toBe('done');
    expect((step as any).options).toHaveLength(2);
  });

  it('ignores a Bench Pokémon that is not Ancient', () => {
    const plain = makeGameCard(PLAIN_BENCH, 0, { damage: 60 });
    const G = board([plain]);
    fire(G, '振翼髮', '蠱惑挪移');
    expect(plain.damage).toBe(60);
    expect(G.players[1].active?.damage).toBe(0);
  });

  it('ignores an undamaged Ancient Pokémon', () => {
    const G = board([makeGameCard(ANCIENT_BENCH, 0, { damage: 0 })]);
    expect(fire(G, '振翼髮', '蠱惑挪移')).toBe('done');
    expect(G.players[1].active?.damage).toBe(0);
  });

  it('KOs the defender when the moved counters are lethal', () => {
    const small = makeCard({ name: '小鼠', hp: '60', types: ['Colorless'], subtypes: ['Basic'] });
    const donor = makeGameCard(ANCIENT_BENCH, 0, { damage: 80 });
    const G = board([donor]);
    G.players[1].active = makeGameCard(small, 1);
    fire(G, '振翼髮', '蠱惑挪移');
    expect(G.players[1].discardPile.map(c => c.cardData.name)).toContain('小鼠');
    expect(G.players[0].takenPrizes).toBe(1);
  });
});

/**
 * 「選擇1個…持有的招式，作為這個招式使用」. These were unimplementable until buildAttackBoard /
 * applyAttackOutcome were lifted out of moves.attack — nothing else could resolve an attack.
 */
describe('copying another Pokémon\'s attack', () => {
  const HITTER = makeCard({
    name: '借用來源', hp: '100', types: ['Colorless'], subtypes: ['Basic'],
    attacks: [mkAttack('借來的一擊', ['Colorless'], '80')],
  });
  const TWO_ATTACKS = makeCard({
    name: '雙招來源', hp: '100', types: ['Colorless'], subtypes: ['Basic'],
    attacks: [mkAttack('小招', ['Colorless'], '10'), mkAttack('大招', ['Colorless'], '90')],
  });
  const BIG_TANK = makeCard({ name: '厚皮鼠', hp: '400', types: ['Colorless'], subtypes: ['Basic'] });

  function board(user: ReturnType<typeof makeCard>, over: {
    deckTop?: ReturnType<typeof makeGameCard>;
    bench?: (ReturnType<typeof makeGameCard> | null)[];
    oppActive?: ReturnType<typeof makeGameCard>;
  } = {}) {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(user, 0),
          bench: [...(over.bench ?? []), null, null, null, null].slice(0, 5) as any,
          deck: over.deckTop ? [over.deckTop] : [],
          prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)),
        }),
        makePlayer({
          active: over.oppActive ?? makeGameCard(BIG_TANK, 1),
          prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 1)),
        }),
      ],
    });
    return G;
  }

  describe('耀閃挑戰 (呆呆王)', () => {
    const SLOWKING = makeCard({ name: '呆呆王', hp: '120', types: ['Psychic'], subtypes: ['Stage 1'] });

    it('discards the top card and uses its attack when it is a rule-box-free Pokémon', () => {
      const top = makeGameCard(HITTER, 0);
      const G = board(SLOWKING, { deckTop: top });
      fire(G, '呆呆王', '耀閃挑戰');
      expect(G.players[0].discardPile.map(c => c.id)).toContain(top.id);
      expect(G.players[1].active?.damage).toBe(80);
    });

    it('discards but does nothing when the top card is not a Pokémon', () => {
      const top = makeGameCard(BASIC_ENERGY, 0);
      const G = board(SLOWKING, { deckTop: top });
      fire(G, '呆呆王', '耀閃挑戰');
      expect(G.players[0].discardPile.map(c => c.id)).toContain(top.id);
      expect(G.players[1].active?.damage).toBe(0);
    });

    it('skips a Pokémon with a rule box, as the text says', () => {
      const ruleBox = makeCard({
        name: '規則鼠ex', hp: '200', types: ['Colorless'], subtypes: ['Basic', 'ex'],
        attacks: [mkAttack('大招', ['Colorless'], '150')],
      });
      const G = board(SLOWKING, { deckTop: makeGameCard(ruleBox, 0) });
      fire(G, '呆呆王', '耀閃挑戰');
      expect(G.players[1].active?.damage).toBe(0);
    });

    it('asks which attack when the discarded Pokémon prints more than one', () => {
      const G = board(SLOWKING, { deckTop: makeGameCard(TWO_ATTACKS, 0) });
      const step = fire(G, '呆呆王', '耀閃挑戰');
      expect(step).not.toBe('done');
      expect((step as any).options).toHaveLength(2);
    });

    it('does nothing with an empty deck', () => {
      const G = board(SLOWKING);
      expect(fire(G, '呆呆王', '耀閃挑戰')).toBe('done');
    });
  });

  describe('暗黑底牌 (N的索羅亞克ex)', () => {
    const ZOROARK = makeCard({ name: 'N的索羅亞克ex', hp: '280', types: ['Darkness'], subtypes: ['Stage 1', 'ex'] });
    const N_MON = makeCard({
      name: 'N的索羅亞', hp: '70', types: ['Darkness'], subtypes: ['Basic'],
      attacks: [mkAttack('借來的一擊', ['Colorless'], '80')],
    });

    it('uses an attack from a Benched N-family Pokémon', () => {
      const G = board(ZOROARK, { bench: [makeGameCard(N_MON, 0)] });
      fire(G, 'N的索羅亞克ex', '暗黑底牌');
      expect(G.players[1].active?.damage).toBe(80);
    });

    it('ignores a Benched Pokémon outside the family', () => {
      const G = board(ZOROARK, { bench: [makeGameCard(HITTER, 0)] });
      expect(fire(G, 'N的索羅亞克ex', '暗黑底牌')).toBe('done');
      expect(G.players[1].active?.damage).toBe(0);
    });

    it('does nothing with an empty Bench', () => {
      expect(fire(board(ZOROARK), 'N的索羅亞克ex', '暗黑底牌')).toBe('done');
    });
  });

  describe('扮晶晶酒 (火箭隊的謎擬Q)', () => {
    const MIMIKYU = makeCard({ name: '火箭隊的謎擬Q', hp: '60', types: ['Psychic'], subtypes: ['Basic'] });
    const TERA_TEXT = '只要這隻寶可夢在備戰區，不會受到招式的傷害。';
    const TERA_MON = makeCard({
      name: '太晶鼠', hp: '300', types: ['Colorless'], subtypes: ['Basic'],
      attacks: [
        { name: '太晶', cost: ['Colorless'] as any, convertedEnergyCost: 1, damage: '70', text: TERA_TEXT },
      ],
    });

    it('uses an attack from the opponent\'s Tera Active', () => {
      const G = board(MIMIKYU, { oppActive: makeGameCard(TERA_MON, 1) });
      fire(G, '火箭隊的謎擬Q', '扮晶晶酒');
      // The copied attack resolves against the CURRENT board, so it hits the opponent's own Active.
      expect(G.players[1].active?.damage).toBe(70);
    });

    it('does nothing when the opponent\'s Active is not a Tera Pokémon', () => {
      const G = board(MIMIKYU, { oppActive: makeGameCard(BIG_TANK, 1) });
      expect(fire(G, '火箭隊的謎擬Q', '扮晶晶酒')).toBe('done');
      expect(G.players[1].active?.damage).toBe(0);
    });
  });
});

/**
 * The eight per-card attack handlers in effects/attacks.ts bypassed everything the generic path
 * checks: they wrote damage through applyWeaknessResistance (no damage immunity, no Tool/passive
 * bonuses) and placed counters / de-evolved without asking whether the target ignores opponents'
 * attack effects at all.
 */
describe('registered attack handlers respect the same protections as the generic path', () => {
  const plain = (name: string, hp: string, seat: 0 | 1) => makeGameCard(makeCard({ name, hp, subtypes: ['Basic'] as Subtype[] }), seat);
  const withPlainness = (name: string, hp: string, seat: 0 | 1) => makeGameCard(makeCard({
    name, hp, subtypes: ['Basic'] as Subtype[],
    abilities: [{ name: '純樸', text: '這隻寶可夢不會受到對手的寶可夢使用招式的效果的影響。', type: 'Ability' }],
  }), seat);

  const dragapult = () => {
    const c = makeGameCard(makeCard({
      name: '多龍巴魯托ex', hp: '320',
      attacks: [{ name: '幻影奇襲', cost: ['Psychic', 'Psychic'], convertedEnergyCost: 2, damage: '200', text: '在對手的備戰寶可夢身上，放置6個傷害指示物。' }],
    }), 0);
    c.attachedEnergy = [{ id: 'p1', type: 'Psychic' } as any, { id: 'p2', type: 'Psychic' } as any];
    return c;
  };

  it('does not place its bench counters on a Pokémon immune to attack effects', () => {
    const protectedBench = withPlainness('骨紋巨聲鱷', '150', 1);
    const openBench = plain('沙包鼠', '150', 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: dragapult() }),
        makePlayer({ active: plain('對手主戰', '330', 1), bench: [protectedBench, openBench, null, null, null] }),
      ],
    });
    moves.attack({ G, ctx: ctx0 } as any, 0);
    // The protected one is never offered as a counter target...
    const options = G.pendingChoice?.options?.map(o => o.id) ?? [];
    expect(options).not.toContain(protectedBench.id);
    expect(options).toContain(openBench.id);
    // ...and cannot be hit by naming it directly either.
    moves.resolveChoice({ G, ctx: ctx0 } as any, [protectedBench.id]);
    expect(protectedBench.damage).toBe(0);
  });

  it('routes its damage through the full breakdown, so damage immunity applies', () => {
    const immune = plain('對手主戰', '330', 1);
    immune.timedEffects = [{ kind: 'damageImmune', appliesOnTurn: 3 }];
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: dragapult() }), makePlayer({ active: immune })],
    });
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(immune.damage).toBe(0);
  });
});
