import { describe, it, expect } from 'vitest';
import {
  HeuristicAI, evaluateAttack, scaledOutcomeDamage, canPayAsHolder, bestSwitchIn, targetValue, cardValue,
} from '../src/ai/heuristicAI';
import type { GenericAttackOutcome } from '../src/game/effects/genericAttacks';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, attack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Card } from '@ptcg/shared';

/**
 * The normal-difficulty opponent. These specs pin the DECISIONS, not the score numbers: each one
 * is a board where the old scorer verifiably picked the wrong move (the defect list lives in the
 * commit messages), built so the winning margin exceeds the 5-point tie band and decide() is
 * deterministic.
 */

const energy = (id: string, type = 'Grass') => ({ id, type, cardData: BASIC_ENERGY });

const mon = (over: Partial<Card> & { name: string }): Card =>
  makeCard({ hp: '120', types: ['Colorless'], subtypes: ['Basic'], ...over });

function duel(mine: Card, theirs: Card = BASIC_MON): PtcgGameState {
  return makeState({
    turn: 4, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({ active: makeGameCard(mine, 0), prizes: [makeGameCard(BASIC_MON, 0)] }),
      makePlayer({ active: makeGameCard(theirs, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  evaluateAttack — the resolver-backed damage model                  */
/* ------------------------------------------------------------------ */

describe('evaluateAttack', () => {
  it('sees a coin-boosted attack as a spread, not the printed base', () => {
    const striker = mon({
      name: '擲幣手', attacks: [attack('賭一把', ['Colorless'], '30+', '擲1次硬幣若為正面，則增加30點傷害。')],
    });
    const G = duel(striker);
    const ev = evaluateAttack(G, 0, G.players[0].active!, G.players[1].active!, striker.attacks![0]);
    expect(ev.guaranteed).toBe(30);
    expect(ev.expected).toBe(45);
  });

  it('terminates against 「擲硬幣直到出現反面為止」 and restores Math.random', () => {
    const real = Math.random;
    const striker = mon({
      name: '無限擲幣', attacks: [attack('連擲', ['Colorless'], '30×', '擲硬幣直到出現反面，造成正面出現的次數×30點傷害。')],
    });
    const G = duel(striker);
    const ev = evaluateAttack(G, 0, G.players[0].active!, G.players[1].active!, striker.attacks![0]);
    // A stub leak here would silently corrupt every seeded measurement afterwards.
    expect(Math.random).toBe(real);
    expect(ev.guaranteed).toBeGreaterThanOrEqual(0);
    expect(ev.expected).toBeGreaterThan(0); // the heads run saw real damage
  });

  it('falls back to the plain breakdown for a text no template recognizes', () => {
    const striker = mon({
      name: '無字天書', attacks: [attack('神秘', ['Colorless'], '50', '這段文字沒有任何模板認得。')],
    });
    const G = duel(striker);
    const ev = evaluateAttack(G, 0, G.players[0].active!, G.players[1].active!, striker.attacks![0]);
    expect(ev.expected).toBe(50);
    expect(ev.guaranteed).toBe(50);
  });
});

describe('scaledOutcomeDamage — apply-time scaled fields mirrored as pure reads', () => {
  const G = makeState();
  const player = G.players[0];

  it('familyScaledDamage counts the whole field by name', () => {
    player.active = makeGameCard(mon({ name: '皮卡丘' }), 0);
    player.bench = [makeGameCard(mon({ name: '皮卡丘ex' }), 0), makeGameCard(BASIC_MON, 0), null, null, null];
    const o = { baseDamage: 0, familyScaledDamage: { name: '皮卡丘', amount: 40 } } as GenericAttackOutcome;
    expect(scaledOutcomeDamage(o, player, player.active)).toBe(80);
  });

  it('selfEnergyDiscardScaledDamage counts eligible energy without discarding anything', () => {
    const attacker = makeGameCard(BASIC_MON, 0, { attachedEnergy: [energy('e1'), energy('e2'), energy('e3')] });
    const o = { baseDamage: 0, selfEnergyDiscardScaledDamage: { max: 2, amount: 50 } } as GenericAttackOutcome;
    expect(scaledOutcomeDamage(o, player, attacker)).toBe(100);
    expect(attacker.attachedEnergy).toHaveLength(3); // pure read — nothing was discarded
  });

  it('leaves an unscaled outcome at its own baseDamage', () => {
    expect(scaledOutcomeDamage({ baseDamage: 70 } as GenericAttackOutcome, player, player.active!)).toBe(70);
  });
});

describe('canPayAsHolder — the 5-arg payability the engine itself uses', () => {
  it('resolves 火箭隊能量-style printed text into its two units', () => {
    // The real card's wording: provides 2 units, each 超 or 惡 — the flat `type` reads as ONE.
    const rocket = makeCard({
      name: '火箭隊能量', supertype: 'Energy', subtypes: ['Special Energy'], types: ['Darkness'],
      rules: ['這張卡在附於寶可夢身上的期間，視為提供2個【超】【惡】2種屬性的能量。'],
    });
    const holder = makeGameCard(mon({ name: '持有者' }), 0, {
      attachedEnergy: [{ id: 'r1', type: 'Darkness', cardData: rocket }],
    });
    const G = makeState();
    G.players[0].active = holder;
    expect(canPayAsHolder(G, holder, ['Darkness', 'Darkness'])).toBe(true);
    // The 2-arg view the old scorer used sees one Darkness and calls this unpayable.
  });
});

describe('bestSwitchIn / targetValue / cardValue', () => {
  it('prefers the bench Pokémon that can actually hit, not the one with the most HP', () => {
    const hitter = mon({ name: '打手', hp: '80', attacks: [attack('重擊', ['Grass'], '90')] });
    const wall = mon({ name: '肉牆', hp: '200', attacks: [attack('大招', ['Grass', 'Grass', 'Grass'], '150')] });
    const G = makeState();
    G.players[0].bench = [
      makeGameCard(wall, 0), // no energy — its big attack is unpayable
      makeGameCard(hitter, 0, { attachedEnergy: [energy('e1')] }),
      null, null, null,
    ];
    expect(bestSwitchIn(G, 0)?.card.cardData.name).toBe('打手');
  });

  it('targetValue weighs investment, cardValue prefers a playable evolution', () => {
    const G = makeState();
    const invested = makeGameCard(mon({ name: 'A', subtypes: ['Stage 1'] }), 1, { attachedEnergy: [energy('x')] });
    expect(targetValue(G, invested)).toBeGreaterThan(targetValue(G, makeGameCard(mon({ name: 'B' }), 1)));

    G.players[0].active = makeGameCard(mon({ name: '小火龍' }), 0);
    const evo = makeCard({ name: '火恐龍', subtypes: ['Stage 1'], evolvesFrom: '小火龍' });
    expect(cardValue(G, 0, evo)).toBeGreaterThan(cardValue(G, 0, makeCard({ name: '路人', subtypes: ['Basic'] })));
  });
});

/* ------------------------------------------------------------------ */
/*  decide() — the decisions themselves                                */
/* ------------------------------------------------------------------ */

const ai = new HeuristicAI();
const pick = async (G: PtcgGameState, moves: Parameters<HeuristicAI['decide']>[2]) =>
  (await ai.decide(G, 0, moves)).action;

const mv = (type: string, payload: Record<string, unknown> = {}, description = type) =>
  ({ type, description, payload } as Parameters<HeuristicAI['decide']>[2][number]);

describe('decide() — each spec is a board the old scorer got wrong', () => {
  it('scores a 潛入記憶-borrowed attack from the same list the engine executes', async () => {
    // The Active's own printed attack is weak; the borrowed one (index past the printed list)
    // is the real weapon. The old scorer read cardData.attacks[1] → undefined → 0.
    const memory = mon({ name: '記憶持有者', abilities: [{ name: '潛入記憶', type: 'Ability', text: '潛入記憶' }] });
    const prior = mon({ name: '前身', attacks: [attack('大絕', ['Colorless'], '120')] });
    const active = makeGameCard(mon({ name: '進化體', subtypes: ['Stage 1'], attacks: [attack('小招', ['Colorless'], '10')] }), 0, {
      attachedEnergy: [energy('e1')],
      preEvolutions: [makeGameCard(prior, 0)],
    });
    const G = makeState({
      turn: 4, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active, bench: [makeGameCard(memory, 0), null, null, null, null] }),
        makePlayer({ active: makeGameCard(mon({ name: '肥壯敵人', hp: '300' }), 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    const chosen = await pick(G, [
      mv('attack', { attackIndex: 0 }, '小招'),
      mv('attack', { attackIndex: 1 }, '大絕(借用)'),
      mv('end_turn'),
    ]);
    expect(chosen.description).toBe('大絕(借用)');
  });

  it('an effect-only attack beats passing the turn', async () => {
    // '30×' parses to base 0 — the old scorer scored it 0 and end_turn(1) tied or won.
    const striker = mon({
      name: '倍乘手', attacks: [attack('連擊', ['Colorless'], '30×', '擲2次硬幣，造成正面出現的次數×30點傷害。')],
    });
    const G = duel(striker);
    G.players[0].active!.attachedEnergy = [energy('e1')];
    const chosen = await pick(G, [mv('attack', { attackIndex: 0 }, '連擊'), mv('end_turn')]);
    expect(chosen.description).toBe('連擊');
  });

  it('sets up before attacking: energy attach outranks a fat non-KO hit', async () => {
    const striker = mon({ name: '打者', attacks: [attack('猛擊', ['Grass'], '150')] });
    const G = duel(striker, mon({ name: '坦克', hp: '340' }));
    const me = G.players[0];
    me.active!.attachedEnergy = [energy('e1')];
    me.hand = [makeGameCard(BASIC_ENERGY, 0)];
    const chosen = await pick(G, [
      mv('attack', { attackIndex: 0 }, '猛擊'),
      mv('attach_energy', { cardId: me.hand[0].id, targetId: me.active!.id }, '貼能量'),
      mv('end_turn'),
    ]);
    // 150 damage used to beat attach(95); now the attack waits until the setup band is empty.
    expect(chosen.description).toBe('貼能量');
  });

  it('the game-winning KO jumps the whole queue', async () => {
    const striker = mon({ name: '終結者', attacks: [attack('終結', ['Grass'], '100')] });
    const G = duel(striker, mon({ name: '殘血', hp: '60' }));
    const me = G.players[0];
    me.active!.attachedEnergy = [energy('e1')];
    me.takenPrizes = 5;
    me.prizes = [makeGameCard(BASIC_MON, 0)];
    me.hand = [makeGameCard(BASIC_ENERGY, 0)];
    const chosen = await pick(G, [
      mv('attack', { attackIndex: 0 }, '終結'),
      mv('attach_energy', { cardId: me.hand[0].id, targetId: me.active!.id }, '貼能量'),
      mv('end_turn'),
    ]);
    expect(chosen.description).toBe('終結');
  });

  it('sees a Special Energy attach unlocking a two-cost attack', async () => {
    const rocket = makeCard({
      name: '火箭隊能量', supertype: 'Energy', subtypes: ['Special Energy'], types: ['Darkness'],
      rules: ['這張卡在附於寶可夢身上的期間，視為提供2個【超】【惡】2種屬性的能量。'],
    });
    const striker = mon({ name: '惡打者', attacks: [attack('暗擊', ['Darkness', 'Darkness'], '90')] });
    const bystander = mon({ name: '路人', attacks: [attack('看戲', ['Grass', 'Grass', 'Grass', 'Grass'], '10')] });
    const G = duel(striker);
    const me = G.players[0];
    me.bench = [makeGameCard(bystander, 0), null, null, null, null];
    me.hand = [makeGameCard(rocket, 0)];
    const chosen = await pick(G, [
      mv('attach_energy', { cardId: me.hand[0].id, targetId: me.active!.id }, '貼主戰'),
      mv('attach_energy', { cardId: me.hand[0].id, targetId: me.bench[0]!.id }, '貼備戰'),
      mv('end_turn'),
    ]);
    // One 火箭隊能量 = both 【惡】 pips at once: the unlock bonus fires only if the AI sees the
    // printed two units. The 2-arg view saw one Colorless and scored both attaches the same.
    expect(chosen.description).toBe('貼主戰');
  });

  it('keeps its fossils rather than discarding them for nothing', async () => {
    const G = duel(mon({ name: '主戰' }));
    const chosen = await pick(G, [mv('discard_fossil', { cardId: 'fossil-1' }, '棄化石'), mv('end_turn')]);
    expect(chosen.description).toBe('end_turn');
  });

  it('does clear a dead fossil out of the Active spot for a real attacker', async () => {
    const fossil = mon({ name: '陳舊的甲殼化石', hp: '40' });
    const hitter = mon({ name: '打手', attacks: [attack('重擊', ['Grass'], '90')] });
    const G = duel(fossil);
    G.players[0].bench = [makeGameCard(hitter, 0, { attachedEnergy: [energy('e1')] }), null, null, null, null];
    const chosen = await pick(G, [
      mv('discard_fossil', { cardId: G.players[0].active!.id }, '棄主戰化石'),
      mv('end_turn'),
    ]);
    expect(chosen.description).toBe('棄主戰化石');
  });

  it('retreats out of lethal danger only into something better, and pays attention to the cost', async () => {
    const doomed = mon({ name: '危殆者', hp: '100', attacks: [attack('弱打', ['Grass'], '20')], retreatCost: ['Colorless'] });
    const savior = mon({ name: '救星', hp: '120', attacks: [attack('反擊', ['Grass'], '120')] });
    const menace = mon({ name: '威脅', attacks: [attack('重砲', ['Grass'], '120')] });
    const G = duel(doomed, menace);
    G.players[0].active!.damage = 40;               // 60 left, incoming 120 = lethal
    G.players[0].active!.attachedEnergy = [energy('e1')];
    G.players[1].active!.attachedEnergy = [energy('o1')];
    G.players[0].bench = [makeGameCard(savior, 0, { attachedEnergy: [energy('e2')] }), null, null, null, null];
    const chosen = await pick(G, [
      mv('retreat', { targetBenchPosition: 0, discardEnergyIds: ['e1'] }, '撤退'),
      mv('attack', { attackIndex: 0 }, '弱打'),
      mv('end_turn'),
    ]);
    expect(chosen.description).toBe('撤退');
  });

  it('does NOT retreat into a warm body that hits softer than the current Active', async () => {
    const fighter = mon({ name: '戰士', hp: '100', attacks: [attack('強打', ['Grass'], '80')] });
    const blank = mon({ name: '白板', hp: '200' });
    const menace = mon({ name: '威脅', attacks: [attack('重砲', ['Grass'], '120')] });
    const G = duel(fighter, menace);
    G.players[0].active!.damage = 40;
    G.players[0].active!.attachedEnergy = [energy('e1')];
    G.players[1].active!.attachedEnergy = [energy('o1')];
    G.players[0].bench = [makeGameCard(blank, 0), null, null, null, null];
    const chosen = await pick(G, [
      mv('retreat', { targetBenchPosition: 0, discardEnergyIds: ['e1'] }, '撤退'),
      mv('attack', { attackIndex: 0 }, '強打'),
      mv('end_turn'),
    ]);
    // The old scorer swapped for raw HP (200 > 60). The blank hits for 0 — stay and fight.
    expect(chosen.description).toBe('強打');
  });

  it('stops digging its own deck when it is nearly empty — but still mills the opponent', async () => {
    const drawCard = makeCard({ name: '研究員', supertype: 'Trainer', subtypes: ['Supporter'], rules: ['從自己的牌庫抽出3張卡。'] });
    const millCard = makeCard({ name: '磨牌手', supertype: 'Trainer', subtypes: ['Item'], rules: ['將對手的牌庫上方2張卡丟棄。'] });
    const G = duel(mon({ name: '主戰' }));
    const me = G.players[0];
    me.deck = Array.from({ length: 5 }, () => makeGameCard(BASIC_MON, 0));
    me.hand = [makeGameCard(drawCard, 0), makeGameCard(millCard, 0)];
    const chosen = await pick(G, [
      mv('play_trainer', { cardId: me.hand[0].id }, '抽自己的牌'),
      mv('play_trainer', { cardId: me.hand[1].id }, '磨對手的牌'),
      mv('end_turn'),
    ]);
    // 從牌庫 used to match the opponent-mill card too; the scoped keyword only punishes self-draw.
    expect(chosen.description).toBe('磨對手的牌');
  });
});
