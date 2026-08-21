import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { moves } from '../src/game/moves';
import { canAttack, effectiveRetreatCost } from '../src/game/validation';
import { processBetweenTurns } from '../src/game/statusConditions';
import { healDamage } from '../src/game/effects/primitives';
import { resolveGenericAttackEffect, NEUTRAL_BOARD } from '../src/game/effects/genericAttacks';
import { BASIC_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The last eleven Standard-legal attack texts, which had been parked as "needs infra that doesn't
 * exist". Most of that infra arrived with the cross-player choice work and the ThisTurn/LastTurn
 * rotation pattern; what genuinely was missing (healed-this-turn, damage-taken-last-turn, a timed
 * cost surcharge, attach-ends-turn, running a Supporter's effect from an attack) is here.
 */

const ctx = (seat: 0 | 1 = 0, turn = 3) =>
  ({ currentPlayer: String(seat), playerID: String(seat), turn, events: { endTurn: () => {} } }) as any;

const energy = (id: string, type = 'Colorless') => ({ id, type } as any);
const mon = (name: string, hp: string, attacks: any[] = [], seat: 0 | 1 = 0, subtypes: Subtype[] = ['Basic']) =>
  makeGameCard(makeCard({ name, hp, subtypes, attacks }), seat);

const battle = (attacker: any, defender: any, over: { myDeck?: any[]; myHand?: any[]; theirHand?: any[]; theirBench?: any[] } = {}) => makeState({
  turn: 3, currentPlayer: 0, phase: 'main',
  players: [
    makePlayer({ active: attacker, deck: over.myDeck ?? [], hand: over.myHand ?? [] }),
    makePlayer({ active: defender, hand: over.theirHand ?? [], bench: [...(over.theirBench ?? []), null, null, null, null, null].slice(0, 5) }),
  ],
});

const nariCard = (seat: 0 | 1) => makeGameCard(makeCard({ name: '納莉', supertype: 'Trainer', subtypes: ['Supporter'] as Subtype[] }), seat);
const filler = (seat: 0 | 1, n: number) => Array.from({ length: n }, (_, i) => makeGameCard(BASIC_MON, seat, `f${seat}-${i}`));

describe('healed-this-turn (蘭螳花ex 活潑刀 / 沙鈴仙人掌 活潑針)', () => {
  it('only counts real healing, not damage counters being moved off', () => {
    const c = mon('蘭螳花ex', '260');
    c.damage = 100;
    expect(c.healedThisTurn).toBeFalsy();
    // A counter MOVE (蠱惑挪移 and friends) writes card.damage directly on purpose: relocating
    // counters is not healing under the rules, and healDamage is the only thing that sets the flag.
    c.damage -= 30;
    expect(c.healedThisTurn).toBeFalsy();
    healDamage(c, 30);
    expect(c.healedThisTurn).toBe(true);
  });

  it('adds the printed bonus only when the attacker healed this turn', () => {
    const text = '在這個回合，若這隻寶可夢恢復了HP，則增加200點傷害。';
    expect(resolveGenericAttackEffect(text, '60+', { ...NEUTRAL_BOARD, attackerHealedThisTurn: true })!.baseDamage).toBe(260);
    expect(resolveGenericAttackEffect(text, '60+', { ...NEUTRAL_BOARD })!.baseDamage).toBe(60);
  });

  it('reads through to a real attack', () => {
    const atk = mon('蘭螳花ex', '260', [mkAttack('活潑刀', ['Colorless'], '60+', '在這個回合，若這隻寶可夢恢復了HP，則增加200點傷害。')]);
    atk.attachedEnergy = [energy('e1')];
    atk.damage = 50;
    healDamage(atk, 50);
    const G = battle(atk, mon('沙包鼠', '330', [], 1));
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(G.players[1].active!.damage).toBe(260);
  });
});

describe('damage taken last turn (超級赫拉克羅斯ex 重裝角擊)', () => {
  it('rotates what was taken this turn into last turn at the transition', () => {
    const victim = mon('超級赫拉克羅斯ex', '340', [mkAttack('重裝角擊', ['Colorless'], '100+', '增加與在上個對手的回合這隻寶可夢受到的招式的傷害相同數值的傷害。')], 1);
    const hitter = mon('打手', '330', [mkAttack('揍', ['Colorless'], '130', '')]);
    hitter.attachedEnergy = [energy('e1')];
    const G = battle(hitter, victim);
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(victim.damageTakenThisTurn).toBe(130);

    G.currentPlayer = 1;
    processBetweenTurns(G);
    expect(victim.damageTakenLastTurn).toBe(130);
    expect(victim.damageTakenThisTurn).toBe(0);

    // Now the victim swings back: 100 printed + the 130 it took.
    G.phase = 'main';
    victim.attachedEnergy = [energy('e2')];
    moves.attack({ G, ctx: ctx(1, G.turn) } as any, 0);
    expect(G.players[0].active!.damage).toBe(230);
  });
});

describe('timed cost surcharge (轟擂金剛猩 鼓擊)', () => {
  it('adds a Colorless to both the attack cost and the retreat cost for one turn', () => {
    const target = mon('受害者', '150', [mkAttack('揍', ['Colorless', 'Colorless'], '30', '')], 1);
    target.cardData.retreatCost = ['Colorless'] as any;
    target.attachedEnergy = [energy('e1'), energy('e2')];
    const G = makeState({
      turn: 4, currentPlayer: 1, phase: 'main',
      players: [makePlayer({ active: mon('攻擊方', '150') }), makePlayer({ active: target })],
    });
    expect(canAttack(G, 1, 0)).toBe(true);
    expect(effectiveRetreatCost(G, target)).toBe(1);

    target.timedEffects = [{ kind: 'costIncrease', amount: 1, appliesOnTurn: 4 }];
    expect(canAttack(G, 1, 0)).toBe(false);   // 2 energy no longer covers a 3-symbol cost
    expect(effectiveRetreatCost(G, target)).toBe(2);

    // It is one turn only.
    G.turn = 5;
    expect(canAttack(G, 1, 0)).toBe(true);
    expect(effectiveRetreatCost(G, target)).toBe(1);
  });
});

describe('attach ends the turn (引夢貘人 白日夢)', () => {
  it('ends the opponent’s turn when they attach to the marked Pokémon, after the attach resolves', () => {
    const marked = mon('受害者', '150', [], 1);
    marked.timedEffects = [{ kind: 'attachEndsTurn', appliesOnTurn: 4 }];
    const energyCard = makeGameCard(makeCard({ name: '基本火能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Fire'] }), 1);
    const G = makeState({
      turn: 4, currentPlayer: 1, phase: 'main',
      players: [makePlayer({ active: mon('攻擊方', '150') }), makePlayer({ active: marked, hand: [energyCard] })],
    });
    moves.attachEnergy({ G, ctx: ctx(1, 4) } as any, energyCard.id, marked.id);
    expect(marked.attachedEnergy).toHaveLength(1); // the attach itself still happened
    expect(G.phase).toBe('end');
  });
});

describe('using a Supporter’s effect as an attack effect', () => {
  it('相仿秀 runs the chosen card from the opponent’s hand, for the attacker', () => {
    const atk = mon('魔牆人偶', '110', [mkAttack('相仿秀', ['Psychic'], '', '查看對手的手牌。若希望，選擇1張其中的支援者卡，將那個效果作為這個招式的效果使用。')]);
    atk.attachedEnergy = [energy('e1', 'Psychic')];
    const nari = nariCard(1);
    const G = battle(atk, mon('沙包鼠', '150', [], 1), { myDeck: filler(0, 10), theirHand: [nari] });

    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(G.pendingChoice!.revealsOpponentHand).toBe(true);
    expect(G.pendingChoice!.options!.map(o => o.id)).toEqual([nari.id]);

    moves.resolveChoice({ G, ctx: ctx(0) } as any, [nari.id]);
    expect(G.players[0].hand).toHaveLength(4);        // the attacker drew, not the owner
    expect(G.players[1].hand.map(c => c.id)).toEqual([nari.id]); // and the card was never played
  });

  it('靈怪變化 discards the top card and uses it when it is a Supporter', () => {
    const atk = mon('九尾', '140', [mkAttack('靈怪變化', ['Fire'], '60', '將自己的牌庫上方1張卡丟棄，若那張卡為支援者卡，則將那個效果作為這個招式的效果使用。')]);
    atk.attachedEnergy = [energy('e1', 'Fire')];
    const nari = nariCard(0);
    const G = battle(atk, mon('沙包鼠', '330', [], 1), { myDeck: [...filler(0, 10), nari] });

    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(G.players[1].active!.damage).toBe(60);
    expect(G.players[0].discardPile.map(c => c.id)).toEqual([nari.id]);
    expect(G.players[0].hand).toHaveLength(4);
  });

  it('靈怪變化 just discards when the top card is not a Supporter', () => {
    const atk = mon('九尾', '140', [mkAttack('靈怪變化', ['Fire'], '60', '將自己的牌庫上方1張卡丟棄，若那張卡為支援者卡，則將那個效果作為這個招式的效果使用。')]);
    atk.attachedEnergy = [energy('e1', 'Fire')];
    const G = battle(atk, mon('沙包鼠', '330', [], 1), { myDeck: filler(0, 3) });
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(G.players[0].discardPile).toHaveLength(1);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.pendingChoice).toBeNull();
  });
});

describe('技能大盜 (狐大盜)', () => {
  const thief = () => {
    const c = mon('狐大盜', '110', [mkAttack('技能大盜', ['Darkness'], '80', '若自己1張手牌都沒有，則選擇1個對手的場上寶可夢持有的招式，作為這個招式使用。')]);
    c.attachedEnergy = [energy('e1', 'Darkness')];
    return c;
  };

  it('deals its printed damage while the hand still holds cards', () => {
    const G = battle(thief(), mon('沙包鼠', '330', [mkAttack('大招', ['Colorless'], '200', '')], 1), { myHand: filler(0, 1) });
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(G.players[1].active!.damage).toBe(80);
  });

  it('uses one of the opponent’s own attacks instead once the hand is empty', () => {
    const G = battle(thief(), mon('沙包鼠', '330', [mkAttack('大招', ['Colorless'], '200', '')], 1));
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    // A single donor with a single attack resolves straight away — 200, not the printed 80.
    expect(G.players[1].active!.damage).toBe(200);
  });
});

describe('the two remaining template-only texts', () => {
  it('謝米 精刺奇襲 hits one benched ex/V for 60, ignoring weakness', () => {
    const atk = mon('謝米', '70', [mkAttack('精刺奇襲', ['Grass'], '', '對手的備戰區的1隻「寶可夢【ex】・【V】」受到60點傷害。[在備戰區不計算弱點・抵抗力。]')]);
    atk.attachedEnergy = [energy('e1', 'Grass')];
    const benchedEx = mon('大王ex', '250', [], 1, ['Basic', 'ex'] as Subtype[]);
    const plainBench = mon('雜魚', '60', [], 1);
    const G = battle(atk, mon('沙包鼠', '150', [], 1), { theirBench: [plainBench, benchedEx] });
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(benchedEx.damage).toBe(60);
    expect(plainBench.damage).toBe(0);
    expect(G.players[1].active!.damage).toBe(0);
  });

  it('葉伊布 嫩葉之恩 finds the bracket-less print of the energy it names', () => {
    const atk = mon('葉伊布', '110', [mkAttack('嫩葉之恩', ['Grass'], '', '從自己的手牌選擇1張「基本【草】能量」卡，附於備戰寶可夢身上。然後，將附上這些卡的寶可夢的HP全部恢復。')]);
    atk.attachedEnergy = [energy('e1', 'Grass')];
    const grass = makeGameCard(makeCard({ name: '基本草能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Grass'] }), 0);
    const hurt = mon('傷兵', '120');
    hurt.damage = 90;
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: atk, bench: [hurt, null, null, null, null], hand: [grass] }),
        makePlayer({ active: mon('沙包鼠', '150', [], 1) }),
      ],
    });
    moves.attack({ G, ctx: ctx(0) } as any, 0);
    expect(hurt.attachedEnergy).toHaveLength(1);
    expect(hurt.damage).toBe(0);
    expect(G.players[0].hand).toHaveLength(0);
  });
});
