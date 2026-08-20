import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { resolveGenericAttackEffect, NEUTRAL_BOARD, AttackBoardContext } from '../src/game/effects/genericAttacks';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { processBetweenTurns } from '../src/game/statusConditions';
import { BASIC_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The Standard-wide attack-coverage push: new clause matchers plus the clause-composition
 * fallback (bracket-aware 。-split; every clause must resolve or the text stays uncovered).
 * Parser-level assertions use resolveGenericAttackEffect directly; the mechanisms that
 * introduced new state (poison severity override, timed retaliation/threshold immunity) get
 * end-to-end games.
 */

afterEach(() => vi.restoreAllMocks());

const board = (over: Partial<AttackBoardContext> = {}): AttackBoardContext => ({ ...NEUTRAL_BOARD, ...over });

const ctx0 = { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } };
const battle = (attacker: any, defender: any, extra: { myBench?: any[]; theirBench?: any[] } = {}) => makeState({
  turn: 3, currentPlayer: 0, phase: 'main',
  players: [
    makePlayer({ active: attacker, bench: [...(extra.myBench ?? []), null, null, null, null, null].slice(0, 5) }),
    makePlayer({ active: defender, bench: [...(extra.theirBench ?? []), null, null, null, null, null].slice(0, 5) }),
  ],
});
const colorless = (id: string) => ({ id, type: 'Colorless', cardData: makeCard({ name: '基本無能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[] }) });

describe('clause composition', () => {
  it('composes independent clauses and adds the printed base exactly once', () => {
    const out = resolveGenericAttackEffect('將對手的戰鬥寶可夢【中毒】。這隻寶可夢也受到20點傷害。', '90', board());
    expect(out).toBeDefined();
    expect(out!.baseDamage).toBe(90);
    expect(out!.statusToInflict).toEqual(['Poisoned']);
    expect(out!.selfDamage).toBe(20);
  });

  it('a 。 inside brackets does not split, and the annotation stays welded', () => {
    const out = resolveGenericAttackEffect('將對手的戰鬥寶可夢【灼傷】。對手的2隻備戰寶可夢也各受到30點傷害。[在備戰區不計算弱點・抵抗力。]', '60', board());
    expect(out).toBeDefined();
    expect(out!.multiTargetOpponentBenchFlatDamage).toEqual({ count: 2, amount: 30 });
  });

  it('bails out when any clause is unknown, and on cross-clause references', () => {
    expect(resolveGenericAttackEffect('將對手的戰鬥寶可夢【中毒】。發動一個誰也看不懂的效果。', '10', board())).toBeUndefined();
    expect(resolveGenericAttackEffect('選擇1張自己的手牌，將其丟棄。這個情況下，這隻寶可夢也受到90點傷害。', '10', board())).toBeUndefined();
  });

  it('the poison-severity override composes with the plain Poison clause', () => {
    const out = resolveGenericAttackEffect('將對手的戰鬥寶可夢【中毒】。因這個【中毒】而放置的傷害指示物的數量改為8個。', '', board());
    expect(out).toBeDefined();
    expect(out!.statusToInflict).toEqual(['Poisoned']);
    expect(out!.poisonCounterOverride).toBe(8);
  });
});

describe('new clause matchers (parser level)', () => {
  it('conditional bonuses read the board', () => {
    expect(resolveGenericAttackEffect('在上個對手的回合，若自己的寶可夢因招式的傷害而【昏厥】了，則增加90點傷害。', '30',
      board({ ownPokemonFaintedLastTurn: true }))!.baseDamage).toBe(120);
    expect(resolveGenericAttackEffect('若對手的戰鬥寶可夢【中毒】，則增加60點傷害。', '30',
      board({ defenderStatusConditions: ['Poisoned'] }))!.baseDamage).toBe(90);
    expect(resolveGenericAttackEffect('若自己的備戰區有「甜甜螢」，則增加60點傷害。', '20',
      board({ ownBenchNames: ['甜甜螢'] }))!.baseDamage).toBe(80);
    expect(resolveGenericAttackEffect('增加對手已經獲得的獎賞卡的張數×30點傷害。', '10',
      board({ opponentRemainingPrizes: 4 }))!.baseDamage).toBe(10 + 2 * 30);
  });

  it('the hand-cost-or-fail pair resolves both ways', () => {
    const text = '從自己的手牌將1張「基本【草】能量」卡丟棄。若無法丟棄，則這個招式失敗。';
    expect(resolveGenericAttackEffect(text, '50', board({ ownHandNames: [] }))!.baseDamage).toBe(0);
    const paid = resolveGenericAttackEffect(text, '50', board({ ownHandNames: ['基本【草】能量'] }))!;
    expect(paid.baseDamage).toBe(50);
    expect(paid.discardNamedFromHandCount).toEqual({ name: '基本【草】能量', count: 1 });
  });

  it('the Tera marker resolves as covered without inventing damage', () => {
    expect(resolveGenericAttackEffect('只要這隻寶可夢在備戰區，不會受到招式的傷害。', '', board())!.baseDamage).toBe(0);
  });
});

describe('new mechanisms (end to end)', () => {
  it('poison severity override: the between-turns tick places 8 counters', () => {
    // 10 printed damage: the statusToInflict apply site keeps its established damage>0 gate.
    const atk = mkAttack('劇毒', ['Colorless'], '10', '將對手的戰鬥寶可夢【中毒】。因這個【中毒】而放置的傷害指示物的數量改為8個。');
    const attacker = makeGameCard(makeCard({ name: '毒手', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [colorless('p-1')] });
    const victim = makeGameCard(makeCard({ name: '受害者', hp: '300', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim);
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(victim.statusConditions).toContain('Poisoned');
    expect(victim.poisonCounterOverride).toBe(8);
    processBetweenTurns(G);
    expect(victim.damage).toBe(10 + 80); // the hit itself plus 8 counters of poison
  });

  it('timed threshold immunity: ≤60 attacks bounce off, bigger ones land', () => {
    const guard = makeGameCard(makeCard({
      name: '防禦者', hp: '200', subtypes: ['Basic'] as Subtype[],
      attacks: [mkAttack('鐵壁', ['Colorless'], '', '在下個對手的回合，這隻寶可夢不會受到「60」以下的招式的傷害。')],
    }), 0, { attachedEnergy: [colorless('g-1')] });
    const small = mkAttack('小拍', ['Colorless'], '50');
    const big = mkAttack('大砸', ['Colorless'], '70');
    const foe = makeGameCard(makeCard({ name: '對手', hp: '200', subtypes: ['Basic'] as Subtype[], attacks: [small, big] }), 1, { attachedEnergy: [colorless('g-2')] });
    const G = battle(guard, foe, { myBench: [makeGameCard(BASIC_MON, 0)] });
    moves.attack({ G, ctx: ctx0 } as any, 0); // sets the shield for opponent turn (turn+1)
    G.currentPlayer = 1;
    G.turn = 4;
    G.phase = 'main' as any;
    moves.attack({ G, ctx: { ...ctx0, currentPlayer: '1', turn: 4 } } as any, 0); // 50 → blocked
    expect(guard.damage).toBe(0);
    G.phase = 'main' as any; // each attack ends the turn phase — reset for the second swing
    moves.attack({ G, ctx: { ...ctx0, currentPlayer: '1', turn: 4 } } as any, 1); // 70 → lands
    expect(guard.damage).toBe(70);
  });

  it('timed retaliation counters land on the next-turn attacker', () => {
    const spiky = makeGameCard(makeCard({
      name: '刺網', hp: '200', subtypes: ['Basic'] as Subtype[],
      attacks: [mkAttack('布網', ['Colorless'], '', '在下個對手的回合，這隻寶可夢受到招式的傷害時，在使用招式的寶可夢身上放置6個傷害指示物。')],
    }), 0, { attachedEnergy: [colorless('r-1')] });
    const foe = makeGameCard(makeCard({ name: '對手', hp: '200', subtypes: ['Basic'] as Subtype[], attacks: [mkAttack('撞', ['Colorless'], '30')] }), 1, { attachedEnergy: [colorless('r-2')] });
    const G = battle(spiky, foe);
    moves.attack({ G, ctx: ctx0 } as any, 0);
    G.currentPlayer = 1;
    G.turn = 4;
    G.phase = 'main' as any;
    moves.attack({ G, ctx: { ...ctx0, currentPlayer: '1', turn: 4 } } as any, 0);
    expect(spiky.damage).toBe(30);
    expect(foe.damage).toBe(60);
  });

  it('mass bench evolution carries every attachment and blocks same-turn re-evolve', () => {
    const basic = makeGameCard(makeCard({ name: '小火龍', hp: '70', subtypes: ['Basic'] as Subtype[] }), 0, {
      damage: 10, attachedEnergy: [colorless('m-1')],
    });
    const evoCard = makeGameCard(makeCard({ name: '火恐龍', hp: '100', subtypes: ['Stage 1'] as Subtype[], evolvesFrom: '小火龍' }), 0);
    const attacker = makeGameCard(makeCard({
      name: '進化號手', hp: '120', subtypes: ['Basic'] as Subtype[],
      attacks: [mkAttack('進化號令', ['Colorless'], '', '從自己的牌庫，選擇自己的所有備戰寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。')],
    }), 0, { attachedEnergy: [colorless('m-2')] });
    const G = battle(attacker, makeGameCard(BASIC_MON, 1), { myBench: [basic] });
    G.players[0].deck = [evoCard, makeGameCard(BASIC_MON, 0)];
    moves.attack({ G, ctx: ctx0 } as any, 0);
    const evolved = G.players[0].bench.find(c => c?.id === evoCard.id);
    expect(evolved).toBeDefined();
    expect(evolved!.damage).toBe(10);
    expect(evolved!.attachedEnergy.map(e => e.id)).toEqual(['m-1']);
    expect(evolved!.preEvolutions?.map(p => p.id)).toEqual([basic.id]);
    expect(G.players[0].pokemonPlayedThisTurn).toContain(evoCard.id);
  });

  it('setDefenderRemainingHp places counters down to exactly N', () => {
    const atk = mkAttack('削磨', ['Colorless'], '', '在對手的戰鬥寶可夢身上放置傷害指示物直到剩餘HP變為「10」為止。');
    const attacker = makeGameCard(makeCard({ name: '削磨者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [colorless('s-1')] });
    const victim = makeGameCard(makeCard({ name: '硬漢', hp: '140', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim);
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(victim.damage).toBe(130);
    expect(G.players[1].active?.id).toBe(victim.id); // exactly 10 HP left — no KO
  });

  it('the Tera marker is never offered as a usable attack', () => {
    const tera = makeGameCard(makeCard({
      name: '太晶者', hp: '220', subtypes: ['Basic'] as Subtype[],
      attacks: [
        { name: '太晶', cost: [] as any, damage: '', text: '只要這隻寶可夢在備戰區，不會受到招式的傷害。' } as any,
        mkAttack('真招式', ['Colorless'], '50'),
      ],
    }), 0, { attachedEnergy: [colorless('t-1')] });
    const G = battle(tera, makeGameCard(BASIC_MON, 1));
    const offered = getLegalMoves(G, 0).filter(m => m.type === 'attack').map(m => m.description);
    expect(offered).toEqual(['真招式']);
  });
});
