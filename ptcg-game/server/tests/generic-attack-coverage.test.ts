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

describe('recursive combinators', () => {
  it('coin-heads wrapper resolves the wrapped clause on heads, base only on tails', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // heads
    const heads = resolveGenericAttackEffect('擲1次硬幣若為正面，則將對手的牌庫上方3張卡丟棄。', '40', board())!;
    expect(heads.baseDamage).toBe(40);
    expect(heads.millOpponentDeckCount).toBe(3);
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // tails
    const tails = resolveGenericAttackEffect('擲1次硬幣若為正面，則將對手的牌庫上方3張卡丟棄。', '40', board())!;
    expect(tails.baseDamage).toBe(40);
    expect(tails.millOpponentDeckCount).toBeUndefined();
  });

  it('tails-fail wrapper zeroes everything on tails', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9); // tails
    const out = resolveGenericAttackEffect(
      '擲1次硬幣若為反面，則這個招式失敗。若為正面，則在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。', '100', board())!;
    expect(out.baseDamage).toBe(0);
    expect(out.selfTimedEffect).toBeUndefined();
  });

  it('若希望 passthrough and the boost-with-rider pair auto-resolve', () => {
    const out = resolveGenericAttackEffect('若希望，增加120點傷害。這個情況下，這隻寶可夢也受到90點傷害。', '30', board())!;
    expect(out.baseDamage).toBe(150);
    expect(out.selfDamage).toBe(90);
  });

  it('the heal + retreat-lock pair composes', () => {
    const out = resolveGenericAttackEffect('將這隻寶可夢恢復「30」HP。在下個自己的回合，這隻寶可夢無法撤退。', '80', board())!;
    expect(out.baseDamage).toBe(80);
    expect(out.healSelfAmount).toBe(30);
    expect(out.selfTimedEffect).toEqual({ kind: 'cantRetreat', turnOffset: 2 });
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

describe('round-4 mechanisms', () => {
  it('delayedKo fires at the end of the next opponent turn, with prizes', () => {
    const atk = mkAttack('詛咒之種', ['Colorless'], '', '將這隻寶可夢身上附加的能量卡全部丟棄。在下個對手的回合結束時，受到這個招式的寶可夢會【昏厥】。');
    const attacker = makeGameCard(makeCard({ name: '詛咒者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [colorless('d4-1')] });
    const victim = makeGameCard(makeCard({ name: '受害者', hp: '300', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim, { theirBench: [makeGameCard(BASIC_MON, 1)] });
    G.players[0].prizes = [makeGameCard(BASIC_MON, 0)];
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(attacker.attachedEnergy).toHaveLength(0);
    expect(victim.timedEffects?.some(e => e.kind === 'delayedKo')).toBe(true);
    // End of the opponent's turn (turn 4) = the sweep that runs once G.turn has passed it.
    G.turn = 5;
    processBetweenTurns(G);
    expect(G.players[1].discardPile.some(c => c.id === victim.id)).toBe(true);
    expect(G.players[0].takenPrizes).toBe(1);
  });

  it('discardDefenderEntirely removes the stack with NO prizes', () => {
    const atk = mkAttack('捲入毀滅', ['Colorless'], '', '選擇1張這隻寶可夢身上附加的「火箭隊能量」，將其丟棄。這個情況下，將對手的戰鬥寶可夢與附加的卡全部丟棄。');
    const rocketEnergy = { id: 'rk-1', type: 'Colorless', cardData: makeCard({ name: '火箭隊能量', supertype: 'Energy', subtypes: ['Special Energy'] as Subtype[] }) };
    const attacker = makeGameCard(makeCard({ name: '毀滅者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [rocketEnergy, colorless('d4-2')] });
    const victim = makeGameCard(makeCard({ name: '被捲入者', hp: '300', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim, { theirBench: [makeGameCard(BASIC_MON, 1)] });
    G.players[0].prizes = [makeGameCard(BASIC_MON, 0)];
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.players[1].discardPile.some(c => c.id === victim.id)).toBe(true);
    expect(G.players[1].active).toBeNull();
    expect(G.players[0].takenPrizes).toBe(0); // 丟棄 ≠ 昏厥
    expect(attacker.attachedEnergy.map(e => e.id)).toEqual(['d4-2']); // the cost was paid
  });

  it('winGameIfOnePrizeLeft ends the game only at exactly 1 prize', () => {
    const atk = mkAttack('終局宣言', ['Colorless'], '', '使用這個招式時，若自己剩餘獎賞卡的張數為1張，則這場對戰己方獲勝。');
    const attacker = makeGameCard(makeCard({ name: '宣言者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [colorless('d4-3')] });
    const G = battle(attacker, makeGameCard(BASIC_MON, 1, { cardData: undefined as any } as any));
    G.players[1].active = makeGameCard(makeCard({ name: '對手', hp: '300', subtypes: ['Basic'] as Subtype[] }), 1);
    G.players[0].prizes = [makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0)];
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.winner).toBeNull();
    G.players[0].prizes = [makeGameCard(BASIC_MON, 0)];
    G.phase = 'main' as any;
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.winner).toBe(0);
  });

  it('copyDefenderRandomAttack resolves a printed defender attack against the current board', () => {
    const copyAtk = mkAttack('鏡像', ['Colorless'], '', '選擇1個對手的戰鬥寶可夢持有的招式，作為這個招式使用。');
    const attacker = makeGameCard(makeCard({ name: '鏡像者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [copyAtk] }), 0, { attachedEnergy: [colorless('d4-4')] });
    const victim = makeGameCard(makeCard({
      name: '模板', hp: '300', subtypes: ['Basic'] as Subtype[],
      attacks: [mkAttack('大力錘', ['Colorless'], '70')],
    }), 1);
    const G = battle(attacker, victim);
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(victim.damage).toBe(70);
  });
});

describe('round-4 late mechanisms', () => {
  it('supporter/evolution locks gate the opponent for exactly their next turn', () => {
    const atk = mkAttack('封鎖', ['Colorless'], '', '這個招式只可在後攻玩家的最初回合使用。在下個對手的回合，對手無法從手牌使出支援者卡。');
    const attacker = makeGameCard(makeCard({ name: '封鎖者', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [atk] }), 0, { attachedEnergy: [colorless('l4-1')] });
    const G = battle(attacker, makeGameCard(BASIC_MON, 1));
    G.turn = 2; // the printed only-on-turn-2 window
    moves.attack({ G, ctx: { ...ctx0, turn: 2 } } as any, 0);
    expect(G.players[1].supporterLockedUntilTurn).toBe(3);
    // On their locked turn the Supporter is not offered…
    const supporter = makeGameCard(makeCard({ name: '某支援者', supertype: 'Trainer', subtypes: ['Supporter'] as Subtype[] }), 1);
    G.players[1].hand = [supporter];
    G.currentPlayer = 1;
    G.turn = 3;
    G.phase = 'main' as any;
    expect(getLegalMoves(G, 1).some(mv => mv.type === 'play_trainer' && (mv.payload as any)?.cardId === supporter.id)).toBe(false);
    // …and offered again the turn after.
    G.turn = 5;
    expect(getLegalMoves(G, 1).some(mv => mv.type === 'play_trainer' && (mv.payload as any)?.cardId === supporter.id)).toBe(true);
  });

  it('timed weakness override doubles the hit while active', () => {
    const mark = mkAttack('標記', ['Colorless'], '', '在下個自己的回合結束前，受到這個招式的寶可夢弱點改爲【無】屬性。[弱點以「×2」計算傷害。]');
    const hit = mkAttack('撞', ['Colorless'], '50');
    const attacker = makeGameCard(makeCard({ name: '標記者', hp: '200', subtypes: ['Basic'] as Subtype[], types: ['Colorless'] as any, attacks: [mark, hit] }), 0, { attachedEnergy: [colorless('l4-2')] });
    const victim = makeGameCard(makeCard({ name: '被標記者', hp: '300', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim);
    moves.attack({ G, ctx: ctx0 } as any, 0); // marks: weakness becomes Colorless on turns 4 and 5
    G.turn = 5;
    G.phase = 'main' as any;
    moves.attack({ G, ctx: { ...ctx0, turn: 5 } } as any, 1);
    expect(victim.damage).toBe(100); // 50 doubled into the overridden weakness
  });

  it('attack-name memory: the last-own-turn bonus reads the rotated record', () => {
    const gas = mkAttack('充滿瓦斯', ['Colorless'], '10');
    const boom = mkAttack('爆炸', ['Colorless'], '50', '在上個自己的回合，若這隻寶可夢使出了「充滿瓦斯」，則增加120點傷害。');
    const attacker = makeGameCard(makeCard({ name: '瓦斯彈手', hp: '120', subtypes: ['Basic'] as Subtype[], attacks: [gas, boom] }), 0, { attachedEnergy: [colorless('l4-3')] });
    const victim = makeGameCard(makeCard({ name: '標靶', hp: '400', subtypes: ['Basic'] as Subtype[] }), 1);
    const G = battle(attacker, victim);
    moves.attack({ G, ctx: ctx0 } as any, 0); // 充滿瓦斯
    // Simulate the two turn transitions that bring the attacker's own next turn around.
    G.currentPlayer = 1; processBetweenTurns(G);
    G.currentPlayer = 0; processBetweenTurns(G);
    G.turn = 5;
    G.phase = 'main' as any;
    moves.attack({ G, ctx: { ...ctx0, turn: 5 } } as any, 1); // 爆炸
    expect(victim.damage).toBe(10 + 50 + 120);
  });
});

/**
 * Leads the Standard-scope run of attack-clause-audit.ts turned up. The audit had only ever
 * looked at preset-deck-reachable attacks, so none of these texts — all on cards a custom deck
 * can play — had been checked once.
 */
describe('Standard-scope clause audit follow-ups', () => {
  const grassEnergy = (i: number, name: string) => makeGameCard(makeCard({
    id: `GE-${i}`, name, supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Grass'],
  }), 0);

  it('pays a Basic Energy hand cost by energy type, not by printed name', () => {
    // 蜜集大蛇::大蛇吐息. The dataset prints this card as both 「基本【草】能量」 and 「基本草能量」,
    // so the old name-substring count saw none of the second kind and failed the attack.
    const text = '從自己的手牌將6張「基本【草】能量」卡丟棄，將對手的戰鬥寶可夢【昏厥】。若無法丟棄6張，則這個招式失敗。';
    const paid = resolveGenericAttackEffect(text, '0', board({ ownHandBasicEnergyCounts: { Grass: 6 } }));
    expect(paid!.koDefender).toBe(true);
    expect(paid!.discardNamedFromHandCount).toEqual({ name: '基本【草】能量', count: 6, basicEnergyType: 'Grass' });
    const short = resolveGenericAttackEffect(text, '0', board({ ownHandBasicEnergyCounts: { Grass: 5 } }));
    expect(short).toEqual({ baseDamage: 0 });
  });

  it('discards the bracket-less prints of that energy and Knocks Out the defender', () => {
    const atk = makeGameCard(makeCard({
      name: '蜜集大蛇', hp: '150',
      attacks: [mkAttack('大蛇吐息', ['Grass'], '0', '從自己的手牌將6張「基本【草】能量」卡丟棄，將對手的戰鬥寶可夢【昏厥】。若無法丟棄6張，則這個招式失敗。')],
    }), 0);
    atk.attachedEnergy = [{ id: 'e1', type: 'Grass' } as any];
    const def = makeGameCard(makeCard({ name: '沙包鼠', hp: '200' }), 1);
    const G = battle(atk, def);
    G.players[0].hand = [0, 1, 2, 3, 4, 5].map(i => grassEnergy(i, '基本草能量'));
    G.players[1].prizes = [makeGameCard(BASIC_MON, 1)];
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].discardPile).toHaveLength(6);
    expect(G.players[1].active).toBeNull();
  });

  it('replaces one named attack’s damage instead of boosting every attack', () => {
    // 步哨鼠::聚氣 resolved as outgoingDamageBoost +240 before, which applied to whatever attack
    // came next AND stacked on top of its printed damage.
    const out = resolveGenericAttackEffect('在下個自己的回合，這隻寶可夢「必殺門牙」的傷害改為「240」點。', '0', board());
    expect(out!.selfTimedEffect).toEqual({ kind: 'namedAttackDamageSet', attackName: '必殺門牙', amount: 240, turnOffset: 2 });
  });

  it('sets exactly the named attack, and only on the turn it applies to', () => {
    const mon = makeGameCard(makeCard({
      name: '步哨鼠', hp: '90',
      attacks: [mkAttack('必殺門牙', ['Colorless'], '20', ''), mkAttack('撞擊', ['Colorless'], '10', '')],
    }), 0);
    mon.attachedEnergy = [colorless('e1'), colorless('e2')];
    mon.timedEffects = [{ kind: 'namedAttackDamageSet', attackName: '必殺門牙', amount: 240, appliesOnTurn: 3 }];
    const def = makeGameCard(makeCard({ name: '沙包鼠', hp: '330' }), 1);
    const G = battle(mon, def);
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.players[1].active!.damage).toBe(240);

    // The other attack is untouched by the override.
    const G2 = battle(mon, makeGameCard(makeCard({ name: '沙包鼠2', hp: '330' }), 1));
    G2.players[0].active!.timedEffects = [{ kind: 'namedAttackDamageSet', attackName: '必殺門牙', amount: 240, appliesOnTurn: 3 }];
    moves.attack({ G: G2, ctx: ctx0 } as any, 1);
    expect(G2.players[1].active!.damage).toBe(10);
  });

  it('keeps the printed coin count on the "your next attack may fail" debuff', () => {
    // 章魚桶::墨汁噴射 — two coins with "any tails fails it" is a 75% miss, not 50%.
    const out = resolveGenericAttackEffect('在下個對手的回合，受到這個招式的寶可夢使用招式時，對手擲2次硬幣。只要出現1次反面，則那個招式失敗。', '30', board());
    expect(out!.opponentTimedEffect).toEqual({ kind: 'coinFlipAttackMiss', coins: 2, turnOffset: 1 });
  });

  it('honours "up to N" on the mass evolve', () => {
    const out = resolveGenericAttackEffect('選擇最多2隻自己的【惡】寶可夢，從自己的牌庫選擇從那些寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。', '0', board());
    expect(out!.massEvolveBenchFromDeck).toEqual({ type: 'Darkness', max: 2 });
  });

  it('scales damage off the discard pile and then returns that energy to the deck', () => {
    const text = '在給對手看過自己的棄牌區的所有「基本【火】能量」卡後，造成其張數×30點傷害。然後，將給對手看過的能量卡放回牌庫並重洗。';
    const out = resolveGenericAttackEffect(text, '0', board({ ownDiscardEnergyCounts: { Fire: 4 } }));
    expect(out!.baseDamage).toBe(120);
    expect(out!.discardPileBasicEnergyScaledDamageToDeck).toEqual({ type: 'Fire', amount: 30 });

    const atk = makeGameCard(makeCard({ name: '加熱洛托姆ex', hp: '200', attacks: [mkAttack('再次加熱', ['Fire'], '0', text)] }), 0);
    atk.attachedEnergy = [{ id: 'e1', type: 'Fire' } as any];
    const G = battle(atk, makeGameCard(makeCard({ name: '沙包鼠', hp: '330' }), 1));
    G.players[0].discardPile = [0, 1, 2].map(i => makeGameCard(makeCard({
      id: `FE-${i}`, name: '基本火能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Fire'],
    }), 0));
    moves.attack({ G, ctx: ctx0 } as any, 0);
    expect(G.players[1].active!.damage).toBe(90);
    expect(G.players[0].discardPile).toHaveLength(0);
    expect(G.players[0].deck).toHaveLength(3);
  });

  it('acts on the two "look at the top card" texts instead of resolving them to nothing', () => {
    expect(resolveGenericAttackEffect('查看自己的牌庫上方1張卡，回復原樣。若希望，將那張卡丟棄。', '10', board())!.selfDiscardTopCount).toBe(1);
    expect(resolveGenericAttackEffect('查看對手的牌庫上方1張卡，回復原樣。若希望，重洗那個牌庫。', '20', board())!.shuffleOpponentDeck).toBe(true);
  });
});
