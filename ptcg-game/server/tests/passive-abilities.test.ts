import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { effectiveMaxHp } from '../src/game/damage';
import {
  areAbilitiesNegated, isDamageBlocked, isImmuneToOpponentAttackEffects, isStadiumPlayBlocked,
} from '../src/game/effects/passiveAbilities';
import { BASIC_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * Standard-wide passive abilities beyond the preset-reachable set — the custom-deck coverage
 * push. Every ability here is a pure board query wired into an existing hook (areAbilitiesNegated,
 * isDamageBlocked, getPassiveMaxHpBonus, the trainer play gates), plus the shared
 * isImmuneToOpponentAttackEffects query this batch introduced — which is ALSO what finally
 * enforces 薄霧能量/硬岩【鬥】能量 in real attacks (the specialEnergy predicate existed but no
 * engine path consulted it).
 */

const withAbility = (name: string, over: Parameters<typeof makeCard>[0] = {}) => makeCard({
  name: '持有者' + name, hp: '120', subtypes: ['Basic'] as Subtype[],
  abilities: [{ name, type: 'Ability', text: 'x' }],
  ...over,
});

const SPECIAL_ENERGY_ATTACHMENT = {
  id: 'se-1', type: 'Colorless',
  cardData: makeCard({ name: '扣殺能量', supertype: 'Energy', subtypes: ['Special Energy'] as Subtype[] }),
};

const plainBoard = (mineActive: any, theirsActive: any, extra: { myBench?: any[]; theirBench?: any[] } = {}) => makeState({
  turn: 3, currentPlayer: 0, phase: 'main',
  players: [
    makePlayer({ active: mineActive, bench: [...(extra.myBench ?? []), null, null, null, null, null].slice(0, 5) }),
    makePlayer({ active: theirsActive, bench: [...(extra.theirBench ?? []), null, null, null, null, null].slice(0, 5) }),
  ],
});

describe('黏著束縛 (海兔獸): Benched Stage 2 abilities negated on both sides', () => {
  const holder = makeGameCard(withAbility('黏著束縛'), 1);
  const stage2 = makeGameCard(makeCard({
    name: '二階受害者', hp: '150', subtypes: ['Stage 2'] as Subtype[],
    abilities: [{ name: '某特性', type: 'Ability', text: 'x' }],
  }), 0);

  it('negates a Benched Stage 2 while the holder is Benched', () => {
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { myBench: [stage2], theirBench: [holder] });
    expect(areAbilitiesNegated(G, stage2)).toBe(true);
  });

  it('does not negate an ACTIVE Stage 2, nor anything once the holder is Active', () => {
    const activeStage2 = makeGameCard(stage2.cardData, 0);
    const G1 = plainBoard(activeStage2, makeGameCard(BASIC_MON, 1), { theirBench: [makeGameCard(holder.cardData, 1)] });
    expect(areAbilitiesNegated(G1, activeStage2)).toBe(false);
    const benched = makeGameCard(stage2.cardData, 0);
    const G2 = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(holder.cardData, 1), { myBench: [benched] });
    expect(areAbilitiesNegated(G2, benched)).toBe(false);
  });
});

describe('初始化 (鐵荊棘ex): Active holder negates rule-box abilities except 未來', () => {
  const holder = makeGameCard(withAbility('初始化', { subtypes: ['Basic', 'ex', 'Future'] as Subtype[] }), 1);
  const exMon = makeGameCard(makeCard({
    name: 'ex受害者', hp: '200', subtypes: ['Basic', 'ex'] as Subtype[],
    abilities: [{ name: '某特性', type: 'Ability', text: 'x' }],
  }), 0);

  it('negates an opposing ex while the holder is Active', () => {
    const G = plainBoard(exMon, holder);
    expect(areAbilitiesNegated(G, exMon)).toBe(true);
  });

  it('spares 未來 rule-box Pokémon — including the holder itself', () => {
    const futureEx = makeGameCard(makeCard({
      name: '未來ex', hp: '200', subtypes: ['Basic', 'ex', 'Future'] as Subtype[],
      abilities: [{ name: '某特性', type: 'Ability', text: 'x' }],
    }), 0);
    const G = plainBoard(futureEx, holder);
    expect(areAbilitiesNegated(G, futureEx)).toBe(false);
    expect(areAbilitiesNegated(G, holder)).toBe(false);
  });

  it('does nothing from the Bench', () => {
    const G = plainBoard(exMon, makeGameCard(BASIC_MON, 1), { theirBench: [makeGameCard(holder.cardData, 1)] });
    expect(areAbilitiesNegated(G, exMon)).toBe(false);
  });
});

describe('暴龍根性 (怪顎龍): +150 max HP while holding a Special Energy', () => {
  it('applies with a Special Energy attached, not with a basic one', () => {
    const mon = makeGameCard(withAbility('暴龍根性', { hp: '160' }), 0);
    const G = plainBoard(mon, makeGameCard(BASIC_MON, 1));
    expect(effectiveMaxHp(G, mon)).toBe(160);
    mon.attachedEnergy = [SPECIAL_ENERGY_ATTACHMENT];
    expect(effectiveMaxHp(G, mon)).toBe(310);
    mon.attachedEnergy = [{ id: 'b1', type: 'Fire', cardData: makeCard({ name: '基本火能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }];
    expect(effectiveMaxHp(G, mon)).toBe(160);
  });
});

describe('全能硬殼 (肋骨海龜): immune to damage AND effects from Special-Energy-carrying attackers', () => {
  const shell = makeGameCard(withAbility('全能硬殼'), 1);
  const attacker = makeGameCard(BASIC_MON, 0);

  it('blocks damage only when the attacker holds a Special Energy', () => {
    const G = plainBoard(attacker, shell);
    expect(isDamageBlocked(G, attacker, shell)).toBe(false);
    attacker.attachedEnergy = [SPECIAL_ENERGY_ATTACHMENT];
    expect(isDamageBlocked(G, attacker, shell)).toBe(true);
    expect(isImmuneToOpponentAttackEffects(G, shell, attacker)).toBe(true);
  });
});

describe('isImmuneToOpponentAttackEffects sources', () => {
  it('純樸: unconditional self immunity', () => {
    const mon = makeGameCard(withAbility('純樸'), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), mon);
    expect(isImmuneToOpponentAttackEffects(G, mon, G.players[0].active!)).toBe(true);
  });

  it('抵抗之幕: covers own Basic 火箭隊的 Pokémon while the holder is in play', () => {
    const rocketBasic = makeGameCard(makeCard({ name: '<火箭隊的>喵喵', hp: '70', subtypes: ['Basic'] as Subtype[] }), 1);
    const holder = makeGameCard(withAbility('抵抗之幕'), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), rocketBasic, { theirBench: [holder] });
    expect(isImmuneToOpponentAttackEffects(G, rocketBasic, G.players[0].active!)).toBe(true);
    // A non-火箭隊的 teammate gets nothing.
    expect(isImmuneToOpponentAttackEffects(G, holder, G.players[0].active!)).toBe(false);
  });

  it('the attack pipeline actually consults it: a status-inflicting attack fails against 純樸', () => {
    const statusAttack = mkAttack('毒針', ['Colorless'], '10', '將對手的戰鬥寶可夢【中毒】。');
    const attacker = makeGameCard(makeCard({ name: '攻擊者', hp: '60', subtypes: ['Basic'] as Subtype[], attacks: [statusAttack] }), 0);
    attacker.attachedEnergy = [{ id: 'e1', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }];
    const naive = makeGameCard(withAbility('純樸', { hp: '200' }), 1);
    const G = plainBoard(attacker, naive);
    moves.attack({ G, ctx: { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } } as any, 0);
    expect(naive.damage).toBe(10);            // damage still lands — 效果 ≠ 傷害
    expect(naive.statusConditions).toEqual([]); // the Poison does not
  });
});

describe('爆大身軀 (大王銅象): Stadium plays blocked while it is the opponent Active', () => {
  const elephant = makeGameCard(withAbility('爆大身軀'), 1);
  const stadiumCard = makeGameCard(makeCard({ name: '測試競技場', supertype: 'Trainer', subtypes: ['Stadium'] as Subtype[] }), 0);

  it('gates both the legal-move list and the playTrainer move itself', () => {
    const me = makeGameCard(BASIC_MON, 0);
    const G = plainBoard(me, elephant);
    G.players[0].hand = [stadiumCard];
    expect(isStadiumPlayBlocked(G, 0)).toBe(true);
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === stadiumCard.id)).toBe(false);
    moves.playTrainer({ G, ctx: { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } } as any, stadiumCard.id);
    expect(G.activeStadium).toBeNull();
    expect(G.players[0].hand.map(c => c.id)).toContain(stadiumCard.id); // refunded, not consumed
  });

  it('does not gate from the Bench', () => {
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [makeGameCard(elephant.cardData, 1)] });
    expect(isStadiumPlayBlocked(G, 0)).toBe(false);
  });
});
