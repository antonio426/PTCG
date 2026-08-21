import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { moves } from '../src/game/moves';
import { getLegalMoves, canEvolve, canAttack } from '../src/game/validation';
import { effectiveMaxHp } from '../src/game/damage';
import { millDeck } from '../src/game/effects/primitives';
import {
  areAbilitiesNegated, isDamageBlocked, isImmuneToOpponentAttackEffects, isStadiumPlayBlocked,
  isProtectedFromOpponentTrainer, isProtectedFromOpponentAbility, isReturnToHandBlocked,
  effectiveTypes,
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

/* ---------- Batch B: trainer-effect immunity family + 光之翼 + 平穩境地 ---------- */

const mkTrainer = (name: string, kind: 'Item' | 'Supporter') =>
  makeGameCard(makeCard({ name, supertype: 'Trainer', subtypes: [kind] as Subtype[] }), 0);

const battleCtx = { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } };

describe('融合為雪/緊張感/廣域堡壘: unaffected by opponent Item/Supporter effects', () => {
  it('query: self-protection covers both kinds; 廣域堡壘 is Supporter-only, team-wide, Active-only', () => {
    const tense = makeGameCard(withAbility('緊張感'), 1);
    const teammate = makeGameCard(BASIC_MON, 1);
    const fortress = makeGameCard(withAbility('廣域堡壘'), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), fortress, { theirBench: [tense, teammate] });
    expect(isProtectedFromOpponentTrainer(G, tense, 'Item')).toBe(true);
    expect(isProtectedFromOpponentTrainer(G, tense, 'Supporter')).toBe(true);
    // 廣域堡壘 Active covers the whole team — but only against Supporters.
    expect(isProtectedFromOpponentTrainer(G, teammate, 'Supporter')).toBe(true);
    expect(isProtectedFromOpponentTrainer(G, teammate, 'Item')).toBe(false);
    // From the Bench it covers nothing.
    const G2 = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [makeGameCard(fortress.cardData, 1), teammate] });
    expect(isProtectedFromOpponentTrainer(G2, teammate, 'Supporter')).toBe(false);
  });

  it('老大的指令 is not offered (and refunds) when every benched target is protected', () => {
    const tense = makeGameCard(withAbility('緊張感'), 1);
    const boss = mkTrainer('老大的指令', 'Supporter');
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [tense] });
    G.players[0].hand = [boss];
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === boss.id)).toBe(false);
    moves.playTrainer({ G, ctx: battleCtx } as any, boss.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(boss.id);
    expect(G.pendingChoice).toBeNull();
  });

  it('老大的指令 offers only unprotected benched Pokémon on a mixed bench', () => {
    const tense = makeGameCard(withAbility('緊張感'), 1);
    const plain = makeGameCard(BASIC_MON, 1);
    const boss = mkTrainer('老大的指令', 'Supporter');
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [tense, plain] });
    G.players[0].hand = [boss];
    moves.playTrainer({ G, ctx: battleCtx } as any, boss.id);
    expect(G.pendingChoice).not.toBeNull();
    expect(G.pendingChoice!.options!.map(o => o.id)).toEqual([plain.id]);
  });

  it('危險光線 (Item) fizzles against a protected Active — no Burn, no Confusion', () => {
    const whale = makeGameCard(withAbility('融合為雪'), 1);
    const ray = mkTrainer('危險光線', 'Item');
    const G = plainBoard(makeGameCard(BASIC_MON, 0), whale);
    G.players[0].hand = [ray];
    moves.playTrainer({ G, ctx: battleCtx } as any, ray.id);
    expect(whale.statusConditions).toEqual([]);
  });

  it('改造之錘 (Item) is blocked by 緊張感 but sails past 廣域堡壘', () => {
    const hammer = mkTrainer('改造之錘', 'Item');
    // Only Special-Energy holder is the 緊張感 Pokémon → no legal target, gated.
    const tense = makeGameCard(withAbility('緊張感'), 1, { attachedEnergy: [SPECIAL_ENERGY_ATTACHMENT] });
    const G1 = plainBoard(makeGameCard(BASIC_MON, 0), tense);
    G1.players[0].hand = [hammer];
    expect(getLegalMoves(G1, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === hammer.id)).toBe(false);
    // 廣域堡壘 Active only stops Supporters — the Item still gets a target.
    const fortress = makeGameCard(withAbility('廣域堡壘'), 1);
    const holder = makeGameCard(BASIC_MON, 1, { attachedEnergy: [{ ...SPECIAL_ENERGY_ATTACHMENT, id: 'se-2' }] });
    const hammer2 = mkTrainer('改造之錘', 'Item');
    const G2 = plainBoard(makeGameCard(BASIC_MON, 0), fortress, { theirBench: [holder] });
    G2.players[0].hand = [hammer2];
    expect(getLegalMoves(G2, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === hammer2.id)).toBe(true);
  });

  it('鏽蝕組手下 (Supporter) finds no target through 廣域堡壘 and discards nothing', () => {
    const fortress = makeGameCard(withAbility('廣域堡壘'), 1);
    const holder = makeGameCard(BASIC_MON, 1, { attachedEnergy: [{ ...SPECIAL_ENERGY_ATTACHMENT, id: 'se-3' }] });
    const goon = mkTrainer('鏽蝕組手下', 'Supporter');
    const G = plainBoard(makeGameCard(BASIC_MON, 0), fortress, { theirBench: [holder] });
    G.players[0].hand = [goon];
    moves.playTrainer({ G, ctx: battleCtx } as any, goon.id);
    expect(G.pendingChoice).toBeNull();
    expect(holder.attachedEnergy).toHaveLength(1);
  });

  it('霍米加的演奏 retreat lock: a Supporter-protected Poisoned Active retreats through it', () => {
    const tense = makeGameCard(withAbility('緊張感'), 0, { statusConditions: ['Poisoned'] });
    const plainMon = makeGameCard(BASIC_MON, 0, { statusConditions: ['Poisoned'] });
    const G = plainBoard(tense, makeGameCard(BASIC_MON, 1), { myBench: [makeGameCard(BASIC_MON, 0)] });
    G.players[0].poisonedCantRetreatUntilTurn = G.turn;
    expect(getLegalMoves(G, 0).some(m => m.type === 'retreat')).toBe(true);
    const G2 = plainBoard(plainMon, makeGameCard(BASIC_MON, 1), { myBench: [makeGameCard(BASIC_MON, 0)] });
    G2.players[0].poisonedCantRetreatUntilTurn = G2.turn;
    expect(getLegalMoves(G2, 0).some(m => m.type === 'retreat')).toBe(false);
  });
});

describe('光之翼: unaffected by opponent Pokémon ability effects', () => {
  it('query: only the holder is covered', () => {
    const wings = makeGameCard(withAbility('光之翼'), 0);
    const G = plainBoard(wings, makeGameCard(BASIC_MON, 1));
    expect(isProtectedFromOpponentAbility(G, wings)).toBe(true);
    expect(isProtectedFromOpponentAbility(G, G.players[1].active!)).toBe(false);
  });

  it('attacking into 甲殼刺/毒刺: a protected attacker keeps its Energy and stays clean', () => {
    const hit = mkAttack('撞擊', ['Colorless'], '10');
    const energy = { id: 'e-w1', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) };
    const protectedAttacker = makeGameCard(withAbility('光之翼', { attacks: [hit] }), 0, { attachedEnergy: [energy] });
    const spiky = makeGameCard(makeCard({
      name: '刺刺防守者', hp: '200', subtypes: ['Basic'] as Subtype[],
      abilities: [{ name: '甲殼刺', type: 'Ability', text: 'x' }, { name: '毒刺', type: 'Ability', text: 'x' }],
    }), 1);
    const G = plainBoard(protectedAttacker, spiky);
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(spiky.damage).toBe(10);
    expect(protectedAttacker.attachedEnergy).toHaveLength(1); // 甲殼刺 blocked
    expect(protectedAttacker.statusConditions).toEqual([]);   // 毒刺 blocked
    // Control: an unprotected attacker into the same defender loses the Energy and is Poisoned.
    const plainAttacker = makeGameCard(makeCard({ name: '普通攻擊者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [hit] }), 0, { attachedEnergy: [{ ...energy, id: 'e-w2' }] });
    const G2 = plainBoard(plainAttacker, makeGameCard(spiky.cardData, 1));
    moves.attack({ G: G2, ctx: battleCtx } as any, 0);
    expect(plainAttacker.attachedEnergy).toHaveLength(0);
    expect(plainAttacker.statusConditions).toContain('Poisoned');
  });
});

describe('平穩境地: the opponent side cannot return in-play Pokémon/attachments to hand', () => {
  it('query: blocks the holder side’s opponent, not the holder side itself', () => {
    const milotic = makeGameCard(withAbility('平穩境地'), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [milotic] });
    expect(isReturnToHandBlocked(G, 0)).toBe(true);  // player 0 faces the holder
    expect(isReturnToHandBlocked(G, 1)).toBe(false); // the holder's own side is free
  });

  it('寶可夢旋風回收機 is gated off and refunds while the opponent has 平穩境地', () => {
    const milotic = makeGameCard(withAbility('平穩境地'), 1);
    const cyclone = mkTrainer('寶可夢旋風回收機', 'Item');
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1), { theirBench: [milotic] });
    G.players[0].hand = [cyclone];
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === cyclone.id)).toBe(false);
    moves.playTrainer({ G, ctx: battleCtx } as any, cyclone.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(cyclone.id);
  });

  it('an attack self-bounce clause is pinned: damage lands, the attacker stays in play', () => {
    const bounce = mkAttack('夾尾巴逃跑', ['Colorless'], '30', '將這隻寶可夢與附加的卡，全部放回手牌。');
    const energy = { id: 'e-b1', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) };
    const attacker = makeGameCard(makeCard({ name: '彈跳者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [bounce] }), 0, { attachedEnergy: [energy] });
    const milotic = makeGameCard(withAbility('平穩境地', { hp: '150' }), 1);
    const G = plainBoard(attacker, milotic);
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(milotic.damage).toBe(30);
    expect(G.players[0].active?.id).toBe(attacker.id);
    expect(attacker.attachedEnergy).toHaveLength(1);
    // Control: with no 平穩境地 across the table, the same attack bounces to hand.
    const attacker2 = makeGameCard(attacker.cardData, 0, { attachedEnergy: [{ ...energy, id: 'e-b2' }] });
    const G2 = plainBoard(attacker2, makeGameCard(BASIC_MON, 1, {}));
    moves.attack({ G: G2, ctx: battleCtx } as any, 0);
    expect(G2.players[0].active).toBeNull();
    expect(G2.players[0].hand.map(c => c.id)).toContain(attacker2.id);
  });
});

/* ---------- Batch C: KO/damage-triggered defender-side abilities (auto-resolved) ---------- */

const basicEnergyOf = (id: string, type: string) => ({
  id, type,
  cardData: makeCard({ name: `基本${type}能量`, supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: [type] as any }),
});

/** Board where player 0 one-shots player 1's Active. Attacker deals `dmg`. */
const koAttackBoard = (theirActive: any, extra: { theirBench?: any[] } = {}, dmg = '200') => {
  const hit = mkAttack('重擊', ['Colorless'], dmg);
  const attacker = makeGameCard(makeCard({ name: '重擊手', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [hit] }), 0, {
    attachedEnergy: [basicEnergyOf('atk-e1', 'Colorless')],
  });
  return plainBoard(attacker, theirActive, extra);
};

describe('潛者捕捉: KO\'d own Water Pokémon returns Basic Water Energy to hand', () => {
  it('Water Energy goes to hand, the off-type Energy rides to discard as usual', () => {
    const holder = makeGameCard(withAbility('潛者捕捉'), 1);
    const victim = makeGameCard(makeCard({ name: '水受害者', hp: '60', subtypes: ['Basic'] as Subtype[], types: ['Water'] as any }), 1, {
      attachedEnergy: [basicEnergyOf('w-1', 'Water'), basicEnergyOf('w-2', 'Water'), basicEnergyOf('f-1', 'Fire')],
    });
    const G = koAttackBoard(victim, { theirBench: [holder] });
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(G.players[1].hand.map(c => c.id).sort()).toEqual(['w-1', 'w-2']);
    // The KO'd card itself still reaches the discard pile, carrying only the Fire Energy.
    const discarded = G.players[1].discardPile.find(c => c.id === victim.id);
    expect(discarded).toBeDefined();
    expect(discarded!.attachedEnergy.map(e => e.id)).toEqual(['f-1']);
  });

  it('does nothing for a non-Water victim or an ability-KO', () => {
    const holder = makeGameCard(withAbility('潛者捕捉'), 1);
    const victim = makeGameCard(makeCard({ name: '火受害者', hp: '60', subtypes: ['Basic'] as Subtype[], types: ['Fire'] as any }), 1, {
      attachedEnergy: [basicEnergyOf('w-3', 'Water')],
    });
    const G = koAttackBoard(victim, { theirBench: [holder] });
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(G.players[1].hand).toHaveLength(0);
  });
});

describe('光子纜線: Active holder KO\'d by attack moves up to 2 Basic Lightning to the Bench', () => {
  it('moves 2 of 3 Lightning to the Lightning-type benched Pokémon', () => {
    const holder = makeGameCard(withAbility('光子纜線', { hp: '120' }), 1, {
      attachedEnergy: [basicEnergyOf('l-1', 'Lightning'), basicEnergyOf('l-2', 'Lightning'), basicEnergyOf('l-3', 'Lightning')],
    });
    const zappy = makeGameCard(makeCard({ name: '雷隊友', hp: '90', subtypes: ['Basic'] as Subtype[], types: ['Lightning'] as any }), 1);
    const plain = makeGameCard(BASIC_MON, 1);
    const G = koAttackBoard(holder, { theirBench: [plain, zappy] });
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(zappy.attachedEnergy).toHaveLength(2);
    expect(plain.attachedEnergy).toHaveLength(0);
    const discarded = G.players[1].discardPile.find(c => c.id === holder.id);
    expect(discarded!.attachedEnergy).toHaveLength(1); // the third Lightning rode to discard
  });
});

describe('最後鎖鏈: holder KO\'d by attack searches 1 deck card to hand', () => {
  it('grabs the Supporter first and shuffles; hand grows by exactly 1', () => {
    const holder = makeGameCard(withAbility('最後鎖鏈', { hp: '80' }), 1);
    const supporter = makeGameCard(makeCard({ name: '某支援者', supertype: 'Trainer', subtypes: ['Supporter'] as Subtype[] }), 1);
    const G = koAttackBoard(holder, { theirBench: [makeGameCard(BASIC_MON, 1)] });
    G.players[1].deck = [makeGameCard(BASIC_MON, 1), supporter, makeGameCard(BASIC_MON, 1)];
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(G.players[1].hand.map(c => c.id)).toEqual([supporter.id]);
    expect(G.players[1].deck).toHaveLength(2);
  });
});

describe('警備濁霧: taking attack damage while Active benches up to 2 瓦斯彈 from deck', () => {
  it('benches 2 on a non-lethal hit and shuffles the deck', () => {
    const holder = makeGameCard(withAbility('警備濁霧', { hp: '200' }), 1);
    const gas1 = makeGameCard(makeCard({ name: '<火箭隊的>瓦斯彈', hp: '70', subtypes: ['Basic'] as Subtype[] }), 1);
    const gas2 = makeGameCard(makeCard({ name: '<火箭隊的>瓦斯彈', hp: '70', subtypes: ['Basic'] as Subtype[] }), 1);
    const gas3 = makeGameCard(makeCard({ name: '<火箭隊的>瓦斯彈', hp: '70', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = koAttackBoard(holder, {}, '30');
    G.players[1].deck = [gas1, gas2, gas3, makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(holder.damage).toBe(30);
    expect(G.players[1].bench.filter(c => c !== null)).toHaveLength(2);
    expect(G.players[1].bench.filter(c => c?.cardData.name.includes('瓦斯彈'))).toHaveLength(2);
    expect(G.players[1].deck).toHaveLength(2);
  });

  it('a BENCHED holder taking splash damage does not trigger', () => {
    const holder = makeGameCard(withAbility('警備濁霧', { hp: '200' }), 1);
    const gas = makeGameCard(makeCard({ name: '<火箭隊的>瓦斯彈', hp: '70', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = koAttackBoard(makeGameCard(BASIC_MON, 1, {}), { theirBench: [holder] }, '10');
    G.players[1].deck = [gas];
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: battleCtx } as any, 0);
    // Only the pre-existing holder sits on the bench — no 瓦斯彈 arrived.
    expect(G.players[1].bench.filter(c => c !== null)).toHaveLength(1);
    expect(G.players[1].deck).toHaveLength(1);
  });
});

/* ---------- Batch D: from-hand and setup-placement abilities ---------- */

describe('緊急迴轉/激動俯衝: Stage 2s dropped onto the Bench straight from hand', () => {
  it('緊急迴轉 is offered from hand only while the opponent has a Stage 2 in play', () => {
    const gear = makeGameCard(makeCard({
      name: '齒輪怪', hp: '140', subtypes: ['Stage 2'] as Subtype[],
      abilities: [{ name: '緊急迴轉', type: 'Ability', text: 'x' }],
    }), 0);
    const stage2Opp = makeGameCard(makeCard({ name: '對面二階', hp: '150', subtypes: ['Stage 2'] as Subtype[] }), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), stage2Opp);
    G.players[0].hand = [gear];
    expect(getLegalMoves(G, 0).some(m => m.type === 'use_ability' && (m.payload as any)?.cardId === gear.id)).toBe(true);
    moves.useAbility({ G, ctx: battleCtx } as any, gear.id);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].bench[0]?.id).toBe(gear.id);
    // Entered play this turn — it may not evolve this turn.
    expect(G.players[0].pokemonPlayedThisTurn).toContain(gear.id);
    // Without an opposing Stage 2 it is neither offered nor usable.
    const gear2 = makeGameCard(gear.cardData, 0);
    const G2 = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1));
    G2.players[0].hand = [gear2];
    expect(getLegalMoves(G2, 0).some(m => m.type === 'use_ability' && (m.payload as any)?.cardId === gear2.id)).toBe(false);
    moves.useAbility({ G: G2, ctx: battleCtx } as any, gear2.id);
    expect(G2.players[0].hand).toHaveLength(1);
  });

  it('激動俯衝 needs an OWN Colorless Mega ex in play', () => {
    const bird = makeGameCard(makeCard({
      name: '烈箭鷹ex', hp: '280', subtypes: ['Stage 2', 'ex'] as Subtype[],
      abilities: [{ name: '激動俯衝', type: 'Ability', text: 'x' }],
    }), 0);
    const mega = makeGameCard(makeCard({ name: '超級某某ex', hp: '300', subtypes: ['Stage 1', 'ex'] as Subtype[], types: ['Colorless'] as any }), 0);
    const G = plainBoard(mega, makeGameCard(BASIC_MON, 1));
    G.players[0].hand = [bird];
    moves.useAbility({ G, ctx: battleCtx } as any, bird.id);
    expect(G.players[0].bench[0]?.id).toBe(bird.id);
    // A Fire Mega ex does not satisfy the 【無】屬性 gate.
    const bird2 = makeGameCard(bird.cardData, 0);
    const fireMega = makeGameCard(makeCard({ name: '超級火某ex', hp: '300', subtypes: ['Stage 1', 'ex'] as Subtype[], types: ['Fire'] as any }), 0);
    const G2 = plainBoard(fireMega, makeGameCard(BASIC_MON, 1));
    G2.players[0].hand = [bird2];
    expect(getLegalMoves(G2, 0).some(m => m.type === 'use_ability' && (m.payload as any)?.cardId === bird2.id)).toBe(false);
  });
});

describe('瞬間爆發力: an evolved card may open as the setup Active', () => {
  const luxray = makeCard({
    name: '倫琴貓', hp: '160', subtypes: ['Stage 2'] as Subtype[],
    abilities: [{ name: '瞬間爆發力', type: 'Ability', text: 'x' }],
  });

  it('choose_active offers it and chooseActive accepts it; a plain Stage 2 stays rejected', () => {
    const burst = makeGameCard(luxray, 0);
    const plainStage2 = makeGameCard(makeCard({ name: '普通二階', hp: '150', subtypes: ['Stage 2'] as Subtype[] }), 0);
    const G = makeState({ phase: 'choose_active' as any, currentPlayer: 0, players: [makePlayer(), makePlayer()] });
    G.players[0].hand = [burst, plainStage2, makeGameCard(BASIC_MON, 0)];
    const offered = getLegalMoves(G, 0).filter(m => m.type === 'choose_active').map(m => (m.payload as any).cardId);
    expect(offered).toContain(burst.id);
    expect(offered).not.toContain(plainStage2.id);
    moves.chooseActive({ G, ctx: { currentPlayer: '0' } } as any, plainStage2.id);
    expect(G.players[0].active).toBeNull();
    moves.chooseActive({ G, ctx: { currentPlayer: '0' } } as any, burst.id);
    expect(G.players[0].active?.id).toBe(burst.id);
  });
});

/* ---------- Batch E: type-changing abilities ---------- */

describe('雙重屬性/二重核心: printed type replaced by the two types in the ability text', () => {
  const dualStone = makeCard({
    name: '小碎鑽', hp: '70', subtypes: ['Basic'] as Subtype[], types: ['Fighting'] as any,
    abilities: [{ name: '雙重屬性', type: 'Ability', text: '只要這隻寶可夢在場上，改為【鬥】與【超】2種屬性。' }],
  });

  it('雙重屬性 yields both parsed types; a plain card keeps its printed one', () => {
    const stone = makeGameCard(dualStone, 0);
    const G = plainBoard(stone, makeGameCard(BASIC_MON, 1));
    expect(effectiveTypes(G, stone)).toEqual(['Fighting', 'Psychic']);
    expect(effectiveTypes(G, G.players[1].active!)).toEqual(G.players[1].active!.cardData.types);
  });

  it('二重核心 only switches on while 驅勁能量 未來 is attached', () => {
    const treads = makeGameCard(makeCard({
      name: '鐵轍跡', hp: '130', subtypes: ['Basic', 'Future'] as Subtype[], types: ['Metal'] as any,
      abilities: [{ name: '二重核心', type: 'Ability', text: '只要這隻寶可夢身上附有「驅勁能量 未來」，這隻寶可夢改為【鬥】與【鋼】2種屬性。' }],
    }), 0);
    const G = plainBoard(treads, makeGameCard(BASIC_MON, 1));
    expect(effectiveTypes(G, treads)).toEqual(['Metal']);
    treads.attachedEnergy = [{
      id: 'boost-1', type: 'Colorless',
      cardData: makeCard({ name: '驅勁能量 未來', supertype: 'Energy', subtypes: ['Special Energy'] as Subtype[] }),
    }];
    expect(effectiveTypes(G, treads)).toEqual(['Fighting', 'Metal']);
  });

  it('the damage pipeline doubles into a weakness only the second type hits', () => {
    const hit = mkAttack('撞擊', ['Colorless'], '30');
    const attacker = makeGameCard(makeCard({ ...dualStone, attacks: [hit] }), 0, {
      attachedEnergy: [{ id: 'e-d1', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }],
    });
    const psychicWeak = makeGameCard(makeCard({
      name: '弱超者', hp: '120', subtypes: ['Basic'] as Subtype[],
      weaknesses: [{ type: 'Psychic', value: '×2' }] as any,
    }), 1);
    const G = plainBoard(attacker, psychicWeak);
    moves.attack({ G, ctx: battleCtx } as any, 0);
    expect(psychicWeak.damage).toBe(60);
    // Control: same board, ability stripped from the attacker — printed Fighting misses the weakness.
    const plainAttacker = makeGameCard(makeCard({ name: '純鬥者', hp: '70', subtypes: ['Basic'] as Subtype[], types: ['Fighting'] as any, attacks: [hit] }), 0, {
      attachedEnergy: [{ id: 'e-d2', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }],
    });
    const psychicWeak2 = makeGameCard(psychicWeak.cardData, 1);
    const G2 = plainBoard(plainAttacker, psychicWeak2);
    moves.attack({ G: G2, ctx: battleCtx } as any, 0);
    expect(psychicWeak2.damage).toBe(30);
  });
});

/* ---------- Batch F: structural abilities ---------- */

describe('潛入記憶: evolved Pokémon can use their pre-evolutions\' attacks', () => {
  it('the stacked Basic\'s attack is offered, resolvable, and gone without the holder', () => {
    const preAttack = mkAttack('底層猛擊', ['Colorless'], '40');
    const topAttack = mkAttack('表層輕拍', ['Colorless'], '10');
    const stage1 = makeGameCard(makeCard({ name: '上層者', hp: '120', subtypes: ['Stage 1'] as Subtype[], attacks: [topAttack] }), 0, {
      attachedEnergy: [{ id: 'm-e1', type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }],
    });
    stage1.preEvolutions = [makeGameCard(makeCard({ name: '底層者', hp: '60', subtypes: ['Basic'] as Subtype[], attacks: [preAttack] }), 0)];
    const holder = makeGameCard(withAbility('潛入記憶'), 0);
    const G = plainBoard(stage1, makeGameCard(BASIC_MON, 1, { cardData: undefined as any } as any), { myBench: [holder] });
    G.players[1].active = makeGameCard(makeCard({ name: '標靶', hp: '200', subtypes: ['Basic'] as Subtype[] }), 1);
    const offered = getLegalMoves(G, 0).filter(m => m.type === 'attack').map(m => m.description);
    expect(offered).toContain('表層輕拍');
    expect(offered).toContain('底層猛擊');
    moves.attack({ G, ctx: battleCtx } as any, 1); // index 1 = the appended pre-evo attack
    expect(G.players[1].active!.damage).toBe(40);
    // Without the holder, only the printed attack is offered.
    const stage1b = makeGameCard(stage1.cardData, 0, { attachedEnergy: stage1.attachedEnergy });
    stage1b.preEvolutions = stage1.preEvolutions;
    const G2 = plainBoard(stage1b, makeGameCard(BASIC_MON, 1));
    expect(getLegalMoves(G2, 0).filter(m => m.type === 'attack').map(m => m.description)).toEqual(['表層輕拍']);
  });
});

describe('全能變身/全能靈魂: the 海豚俠 deck swap', () => {
  const dolphin = makeCard({
    name: '海豚俠', hp: '100', subtypes: ['Stage 1'] as Subtype[], types: ['Water'] as any,
    abilities: [{ name: '全能變身', type: 'Ability', text: 'x' }],
  });
  const dolphinEx = makeCard({
    name: '海豚俠ex', hp: '340', subtypes: ['Stage 1', 'ex'] as Subtype[], types: ['Water'] as any,
    abilities: [{ name: '全能靈魂', type: 'Ability', text: 'x' }],
  });

  it('benching it from the Active offers the swap; everything carries over', () => {
    const hero = makeGameCard(dolphin, 0, {
      damage: 30,
      attachedEnergy: [{ id: 'd-e1', type: 'Water', cardData: makeCard({ name: '基本水能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) }],
    });
    const exCard = makeGameCard(dolphinEx, 0);
    const G = plainBoard(hero, makeGameCard(BASIC_MON, 1), { myBench: [makeGameCard(BASIC_MON, 0)] });
    G.players[0].deck = [exCard, makeGameCard(BASIC_MON, 0)];
    moves.retreat({ G, ctx: battleCtx } as any, 0);
    expect(G.pendingChoice?.effectKey).toBe('mighty_transform');
    moves.resolveChoice({ G, ctx: battleCtx } as any, [exCard.id]);
    const swapped = G.players[0].bench.find(c => c?.id === exCard.id);
    expect(swapped).toBeDefined();
    expect(swapped!.damage).toBe(30);
    expect(swapped!.attachedEnergy).toHaveLength(1);
    expect(G.players[0].deck.some(c => c.id === hero.id)).toBe(true);
    expect(G.players[0].deck.some(c => c.id === exCard.id)).toBe(false);
  });

  it('declining leaves the board alone, and 全能靈魂 blocks a normal evolution', () => {
    const hero = makeGameCard(dolphin, 0);
    const exCard = makeGameCard(dolphinEx, 0);
    const G = plainBoard(hero, makeGameCard(BASIC_MON, 1), { myBench: [makeGameCard(BASIC_MON, 0)] });
    G.players[0].deck = [exCard];
    moves.retreat({ G, ctx: battleCtx } as any, 0);
    expect(G.pendingChoice?.effectKey).toBe('mighty_transform');
    moves.resolveChoice({ G, ctx: battleCtx } as any, []);
    expect(G.players[0].bench.some(c => c?.id === hero.id)).toBe(true);
    // 全能靈魂: even with the ex in hand and 海豚俠 in play, evolving into it is never legal.
    const G2 = plainBoard(makeGameCard(dolphin, 0), makeGameCard(BASIC_MON, 1));
    const exInHand = makeGameCard(dolphinEx, 0);
    G2.players[0].hand = [exInHand];
    expect(canEvolve(G2, 0, exInHand.id, G2.players[0].active!.id)).toBe(false);
  });
});

describe('多重轉接: a second Tool slot for 洛托姆-named Pokémon', () => {
  const cape = () => makeGameCard(makeCard({ name: '英雄斗篷', supertype: 'Trainer', subtypes: ['Pokémon Tool'] as Subtype[] }), 0);

  it('attaches a second Tool, sums its effect, and discards it when the permission lapses', () => {
    const rotom = makeGameCard(makeCard({
      name: '洛托姆ex', hp: '190', subtypes: ['Basic', 'ex'] as Subtype[],
      abilities: [{ name: '多重轉接', type: 'Ability', text: 'x' }],
    }), 0);
    const G = plainBoard(rotom, makeGameCard(BASIC_MON, 1));
    const tool1 = cape();
    const tool2 = cape();
    G.players[0].hand = [tool1, tool2];
    moves.playTrainer({ G, ctx: battleCtx } as any, tool1.id);
    moves.resolveChoice({ G, ctx: battleCtx } as any, [rotom.id]);
    moves.playTrainer({ G, ctx: battleCtx } as any, tool2.id);
    moves.resolveChoice({ G, ctx: battleCtx } as any, [rotom.id]);
    expect(rotom.attachedTool?.id).toBe(tool1.id);
    expect(rotom.attachedTool2?.id).toBe(tool2.id);
    expect(effectiveMaxHp(G, rotom)).toBe(190 + 200); // two 英雄斗篷 stack
    // Permission lapses (the only holder is this very Rotom — knock it out of play by hand):
    // simulate the holder losing the ability via 初始化 on the opponent's Active.
    G.players[1].active = makeGameCard(withAbility('初始化', { subtypes: ['Basic', 'ex', 'Future'] as Subtype[] }), 1);
    moves.endTurn({ G, ctx: battleCtx } as any);
    expect(rotom.attachedTool2).toBeNull();
    expect(G.players[0].discardPile.some(c => c.id === tool2.id)).toBe(true);
    expect(rotom.attachedTool?.id).toBe(tool1.id); // the first Tool is legal and stays
  });

  it('a non-洛托姆 Pokémon never gets the second slot', () => {
    const rotomHolder = makeGameCard(makeCard({
      name: '洛托姆ex', hp: '190', subtypes: ['Basic', 'ex'] as Subtype[],
      abilities: [{ name: '多重轉接', type: 'Ability', text: 'x' }],
    }), 0);
    const plain = makeGameCard(BASIC_MON, 0, { attachedTool: makeGameCard(makeCard({ name: '某道具', supertype: 'Trainer', subtypes: ['Pokémon Tool'] as Subtype[] }), 0) });
    const G = plainBoard(plain, makeGameCard(BASIC_MON, 1), { myBench: [rotomHolder] });
    const tool = cape();
    G.players[0].hand = [tool];
    moves.playTrainer({ G, ctx: battleCtx } as any, tool.id);
    // Options exclude the occupied non-洛托姆 Active; only the Rotom (slot 1 free) is offered.
    expect(G.pendingChoice?.options!.map(o => o.id)).toEqual([rotomHolder.id]);
  });
});

describe('整人擊落: milled by the opponent, punishes their deck for 8', () => {
  it('fires on opponent-caused mills only, and chains through the punishment', () => {
    const nut = makeGameCard(makeCard({
      name: '堅果啞鈴', hp: '130', subtypes: ['Stage 1'] as Subtype[],
      abilities: [{ name: '整人擊落', type: 'Ability', text: 'x' }],
    }), 1);
    const G = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1));
    G.players[1].deck = [makeGameCard(BASIC_MON, 1), nut]; // nut on top
    G.players[0].deck = Array.from({ length: 10 }, () => makeGameCard(BASIC_MON, 0));
    millDeck(G, 1, 1, true);
    expect(G.players[1].discardPile.map(c => c.id)).toContain(nut.id);
    expect(G.players[0].deck).toHaveLength(2); // 10 - 8
    expect(G.players[0].discardPile).toHaveLength(8);
    // Self-caused mills don't trigger.
    const nut2 = makeGameCard(nut.cardData, 1);
    const G2 = plainBoard(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 1));
    G2.players[1].deck = [nut2];
    G2.players[0].deck = Array.from({ length: 10 }, () => makeGameCard(BASIC_MON, 0));
    millDeck(G2, 1, 1, false);
    expect(G2.players[0].deck).toHaveLength(10);
  });
});

describe('璀璨鱗片 (美納斯ex): untouchable by 太晶 attackers', () => {
  it('blocks damage and effects from a Tera attacker only', () => {
    const scale = makeGameCard(withAbility('璀璨鱗片', { hp: '270' }), 1);
    // isTeraPokemon keys on the bench-immunity pseudo-attack every Tera print carries.
    const tera = makeGameCard(makeCard({
      name: '太晶攻擊者', hp: '220', subtypes: ['Basic', 'ex'] as Subtype[],
      attacks: [{ name: '太晶標記', cost: [], damage: '', text: '只要這隻寶可夢在備戰區，不會受到招式的傷害。' } as any],
    }), 0);
    const G = plainBoard(tera, scale);
    expect(isDamageBlocked(G, tera, scale)).toBe(true);
    expect(isImmuneToOpponentAttackEffects(G, scale, tera)).toBe(true);
    const plain = makeGameCard(BASIC_MON, 0);
    const G2 = plainBoard(plain, makeGameCard(scale.cardData, 1));
    expect(isDamageBlocked(G2, plain, G2.players[1].active!)).toBe(false);
    expect(isImmuneToOpponentAttackEffects(G2, G2.players[1].active!, plain)).toBe(false);
  });
});

/**
 * Abilities that only existed once the official re-scrape restored them: the stored scrape had been
 * produced by a parser that dropped every 「[特性]」 block, so for cards TCGdex does not carry (the
 * MC-* compilation set above all) we simply had no ability data.
 */
describe('繁茂 / 監視之眼 (recovered by the ability re-scrape)', () => {
  it('繁茂 makes a friendly basic Grass Energy pay for two', () => {
    const grass = (id: string) => ({
      id, type: 'Grass',
      cardData: makeCard({ name: '基本草能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Grass'] }),
    } as any);
    const attacker = makeGameCard(makeCard({
      name: '大針蜂', hp: '120',
      attacks: [mkAttack('雙針', ['Grass', 'Grass'], '60', '')],
    }), 0);
    attacker.attachedEnergy = [grass('g1')];
    const helper = makeGameCard(makeCard({
      name: '大竺葵', hp: '110',
      abilities: [{ name: '繁茂', text: '只要這隻寶可夢在場上，自己的所有寶可夢身上附加的「基本【草】能量」卡，視為各提供2個【草】能量。這個特性的效果不會重複。', type: 'Ability' }],
    }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: attacker, bench: [helper, null, null, null, null] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    expect(canAttack(G, 0, 0)).toBe(true);

    // Without 大竺葵 in play, one Grass cannot pay a two-Grass cost.
    G.players[0].bench = [null, null, null, null, null];
    expect(canAttack(G, 0, 0)).toBe(false);
  });

  it('監視之眼 stops damage counters being relocated, on either side', () => {
    const watcher = makeGameCard(makeCard({
      name: '探探鼠', hp: '70',
      abilities: [{ name: '監視之眼', text: '只要這隻寶可夢在場上，雙方的所有寶可夢身上放置的傷害指示物，無法改放於其他寶可夢身上。', type: 'Ability' }],
    }), 1);
    const donor = makeGameCard(makeCard({ name: '古代夥伴', hp: '90', subtypes: ['Basic', 'Ancient'] as Subtype[] }), 0);
    donor.damage = 50;
    const mover = makeGameCard(makeCard({
      name: '振翼髮', hp: '110',
      attacks: [mkAttack('蠱惑挪移', ['Psychic'], '', '選擇1隻自己的備戰區的「古代」寶可夢，將所選的寶可夢身上放置的傷害指示物，全部改放於對手的戰鬥寶可夢身上。')],
    }), 0);
    mover.attachedEnergy = [{ id: 'p1', type: 'Psychic' } as any];
    const defender = makeGameCard(makeCard({ name: '沙包鼠', hp: '150' }), 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: mover, bench: [donor, null, null, null, null] }),
        makePlayer({ active: defender, bench: [watcher, null, null, null, null] }),
      ],
    });
    moves.attack({ G, ctx: { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } as any }, 0);
    expect(donor.damage).toBe(50);      // nothing moved
    expect(defender.damage).toBe(0);
  });
});
