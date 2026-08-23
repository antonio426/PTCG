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

/* ------------------------------------------------------------------ */
/*  resolve_choice — answering the question that was actually asked    */
/* ------------------------------------------------------------------ */

describe('resolve_choice answers', () => {
  const withChoice = (G: PtcgGameState, choice: Partial<NonNullable<PtcgGameState['pendingChoice']>>) => {
    G.pendingChoice = {
      player: 0, owner: 0, effectKey: 'attack_pick', prompt: '選擇',
      choiceType: 'select_from_list', options: [], context: {}, ...choice,
    } as PtcgGameState['pendingChoice'];
    return G;
  };

  it('damage_targets: hits the Pokémon it can actually finish, not the healthiest', async () => {
    // 30 damage to distribute; A is one hit from down, B is full — the old scorer picked B.
    const G = duel(mon({ name: '散彈手' }));
    const nearlyDead = makeGameCard(mon({ name: '殘血目標', hp: '60' }), 1, { damage: 30 });
    const full = makeGameCard(mon({ name: '滿血目標', hp: '120' }), 1);
    G.players[1].bench = [nearlyDead, full, null, null, null];
    withChoice(G, {
      prompt: '選擇 1 次對手的寶可夢（每次各 30 點傷害）', count: 1,
      options: [{ id: nearlyDead.id, label: '殘血目標' }, { id: full.id, label: '滿血目標' }],
      context: { kind: 'damage_targets', amount: 30 },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [nearlyDead.id] }, '打殘血'),
      mv('resolve_choice', { selection: [full.id] }, '打滿血'),
    ]);
    expect(chosen.description).toBe('打殘血');
  });

  it('ko_target: takes the multi-prize body over the ordinary one', async () => {
    const G = duel(mon({ name: '殺手' }));
    const big = makeGameCard(mon({ name: '大獎ex', subtypes: ['Basic', 'ex'] }), 1);
    const small = makeGameCard(mon({ name: '小獎' }), 1);
    G.players[1].bench = [small, big, null, null, null];
    withChoice(G, {
      prompt: '選擇1隻使其昏厥', count: 1,
      options: [{ id: small.id, label: '小獎' }, { id: big.id, label: '大獎ex' }],
      context: { kind: 'ko_target' },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [small.id] }, '殺小的'),
      mv('resolve_choice', { selection: [big.id] }, '殺大的'),
    ]);
    expect(chosen.description).toBe('殺大的');
  });

  it('retreat pick_bench promotes the SAME Pokémon that justified retreating', async () => {
    // A loaded attacker and an empty wall: the retreat logic wants the attacker, so the
    // promotion answer must too — the old scorer used a different heuristic for each half.
    const hitter = mon({ name: '打手', hp: '80', attacks: [attack('重擊', ['Grass'], '90')] });
    const wall = mon({ name: '肉牆', hp: '200' });
    const G = duel(mon({ name: '前排' }));
    const hitterCard = makeGameCard(hitter, 0, { attachedEnergy: [energy('e9')] });
    const wallCard = makeGameCard(wall, 0);
    G.players[0].bench = [wallCard, hitterCard, null, null, null];
    withChoice(G, {
      effectKey: 'retreat', prompt: '選擇要換上場的備戰寶可夢',
      choiceType: 'select_bench_pokemon', count: 1,
      options: [{ id: wallCard.id, label: '肉牆' }, { id: hitterCard.id, label: '打手' }],
      context: { step: 'pick_bench' },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [wallCard.id] }, '上肉牆'),
      mv('resolve_choice', { selection: [hitterCard.id] }, '上打手'),
    ]);
    expect(chosen.description).toBe('上打手');
  });

  it('pays a retreat cost with the energy its attacks cannot even use', async () => {
    const active = makeGameCard(mon({ name: '撤退者', attacks: [attack('草擊', ['Grass'], '50')] }), 0, {
      attachedEnergy: [energy('g1', 'Grass'), energy('f1', 'Fire')],
    });
    const G = duel(mon({ name: 'x' }));
    G.players[0].active = active;
    withChoice(G, {
      effectKey: 'retreat', prompt: '選擇 1 張要棄置的能量（撤退費用）', count: 1,
      options: [{ id: 'g1', label: '草' }, { id: 'f1', label: '火' }],
      context: { step: 'pick_energy', benchIdx: 0 },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: ['g1'] }, '棄草'),
      mv('resolve_choice', { selection: ['f1'] }, '棄火'),
    ]);
    // The Grass energy pays 草擊; the Fire energy pays nothing this Pokémon does.
    expect(chosen.description).toBe('棄火');
  });

  it('discards the opponent hand card that hurts them most', async () => {
    const G = duel(mon({ name: '搶匪' }));
    const supporter = makeGameCard(makeCard({ name: '對手的支援者', supertype: 'Trainer', subtypes: ['Supporter'] }), 1);
    const energyCard = makeGameCard(BASIC_ENERGY, 1);
    G.players[1].hand = [supporter, energyCard];
    withChoice(G, {
      prompt: '選擇 1 張丟棄', count: 1, revealsOpponentHand: true,
      options: [{ id: supporter.id, label: '對手的支援者' }, { id: energyCard.id, label: '基礎草能量' }],
      context: { kind: 'discard_opponent_hand' },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [supporter.id] }, '丟支援者'),
      mv('resolve_choice', { selection: [energyCard.id] }, '丟能量'),
    ]);
    expect(chosen.description).toBe('丟支援者');
  });
  it('answers a 「由對手選擇」 forced switch with its best attacker, not at random', async () => {
    // The choice raiseAttackPick raises is ALWAYS choiceType select_from_list — an earlier guard
    // on the choiceType excluded exactly this kind from the promotion branch.
    const hitter = mon({ name: '打手', hp: '80', attacks: [attack('重擊', ['Grass'], '90')] });
    const wall = mon({ name: '肉牆', hp: '200' });
    const G = duel(mon({ name: '前排' }));
    const hitterCard = makeGameCard(hitter, 0, { attachedEnergy: [energy('e9')] });
    const wallCard = makeGameCard(wall, 0);
    G.players[0].bench = [wallCard, hitterCard, null, null, null];
    withChoice(G, {
      prompt: '對手的招式效果：選擇要換上戰鬥場的寶可夢', count: 1,
      choiceType: 'select_from_list',
      options: [{ id: wallCard.id, label: '肉牆' }, { id: hitterCard.id, label: '打手' }],
      context: { kind: 'opponent_switch' },
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [wallCard.id] }, '上肉牆'),
      mv('resolve_choice', { selection: [hitterCard.id] }, '上打手'),
    ]);
    expect(chosen.description).toBe('上打手');
  });

  it('takes every free mulligan bench placement it is offered', async () => {
    const G = duel(mon({ name: '主戰' }));
    const b1 = makeGameCard(BASIC_MON, 0);
    const b2 = makeGameCard(BASIC_MON, 0);
    G.players[0].hand = [b1, b2];
    withChoice(G, {
      effectKey: 'mulligan_bonus_bench', prompt: '可將補抽到的基礎寶可夢直接放上備戰區（可不選）',
      minCount: 0, maxCount: 2,
      options: [{ id: b1.id, label: '測試鼠' }, { id: b2.id, label: '測試鼠' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [] }, '不放'),
      mv('resolve_choice', { selection: [b1.id] }, '放一隻'),
      mv('resolve_choice', { selection: [b1.id, b2.id] }, '放兩隻'),
    ]);
    expect(chosen.description).toBe('放兩隻');
  });
  it('takes the free deck search instead of declining it', async () => {
    // Watched in a real game: 高級球 and 集客 both answered 「(不選)」 with real picks on offer,
    // because the value term was damped to within the 5-point random tie band.
    const G = duel(mon({ name: '主戰' }));
    const found = makeGameCard(mon({ name: '牌庫裡的寶可夢' }), 0);
    G.players[0].deck = [found];
    withChoice(G, {
      effectKey: 'trainer:高級球', prompt: '高級球：從牌庫選 1 張寶可夢加入手牌（可不選）',
      minCount: 0, maxCount: 1,
      options: [{ id: found.id, label: '牌庫裡的寶可夢' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [] }, '不選'),
      mv('resolve_choice', { selection: [found.id] }, '拿牌'),
    ]);
    expect(chosen.description).toBe('拿牌');
  });

  it('does not read 「丟棄」 as a cost when the cards being discarded are the opponent\'s', async () => {
    // 枇琶: 「查看對手手牌，選最多2張物品卡丟棄」 — the prompt says 丟棄, so the classifier
    // minimized, and minimizing meant declining to strip their hand. Ownership settles it.
    const G = duel(mon({ name: '主戰' }));
    const theirItem = makeGameCard(makeCard({ name: '神奇糖果', supertype: 'Trainer', subtypes: ['Item'] }), 1);
    G.players[1].hand = [theirItem];
    withChoice(G, {
      effectKey: 'trainer:枇琶', prompt: '枇琶：查看對手手牌，選最多 2 張物品卡丟棄',
      minCount: 0, maxCount: 2, revealsOpponentHand: true,
      options: [{ id: theirItem.id, label: '神奇糖果' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [] }, '不選'),
      mv('resolve_choice', { selection: [theirItem.id] }, '丟對手的道具'),
    ]);
    expect(chosen.description).toBe('丟對手的道具');
  });
  it('reads a 「其餘放回」 prompt as the reward it is, and keeps the better card', async () => {
    // 偵查指令: 「查看牌庫上方2張，選1張加手牌，其餘放回牌庫下方」 — the 放回 describes the cards
    // NOT selected, and the AI minimized on it, picking the worse of the two it was handed.
    const G = duel(mon({ name: '主戰' }));
    G.players[0].active = makeGameCard(mon({ name: '小火龍' }), 0);
    const evo = makeGameCard(makeCard({ name: '火恐龍', subtypes: ['Stage 1'], evolvesFrom: '小火龍' }), 0);
    const junk = makeGameCard(makeCard({ name: '路人卡', supertype: 'Trainer', subtypes: ['Item'] }), 0);
    G.players[0].deck = [evo, junk];
    withChoice(G, {
      effectKey: 'ability:偵查指令', prompt: '偵查指令：查看牌庫上方 2 張，選 1 張加手牌，其餘放回牌庫下方',
      count: 1, options: [{ id: evo.id, label: '火恐龍' }, { id: junk.id, label: '路人卡' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [evo.id] }, '拿進化'),
      mv('resolve_choice', { selection: [junk.id] }, '拿路人'),
    ]);
    expect(chosen.description).toBe('拿進化');
  });

  it('still pays a hand-discard cost with its least useful card', async () => {
    const G = duel(mon({ name: '小火龍' }));
    const evo = makeGameCard(makeCard({ name: '火恐龍', subtypes: ['Stage 1'], evolvesFrom: '小火龍' }), 0);
    const junk = makeGameCard(makeCard({ name: '路人卡', supertype: 'Trainer', subtypes: ['Item'] }), 0);
    G.players[0].hand = [evo, junk];
    withChoice(G, {
      effectKey: 'trainer:高級球', prompt: '高級球：選擇 2 張手牌丟棄',
      count: 1, options: [{ id: evo.id, label: '火恐龍' }, { id: junk.id, label: '路人卡' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [evo.id] }, '丟進化'),
      mv('resolve_choice', { selection: [junk.id] }, '丟路人'),
    ]);
    expect(chosen.description).toBe('丟路人');
  });

  it('answers an ability-driven switch with bestSwitchIn like every other promotion', async () => {
    // 支配鎖鏈 raises select_pokemon with an empty context and no kind, so it fell to the generic
    // card-value classifier — watched swapping a non-attacker in and undoing the AI's own retreat.
    const hitter = mon({ name: '打手', hp: '80', attacks: [attack('重擊', ['Grass'], '90')] });
    const idler = mon({ name: '閒人', hp: '200', attacks: [attack('大招', ['Grass', 'Grass', 'Grass'], '150')] });
    const G = duel(mon({ name: '前排' }));
    const hitterCard = makeGameCard(hitter, 0, { attachedEnergy: [energy('e9')] });
    const idlerCard = makeGameCard(idler, 0);   // no energy: its attack is unpayable
    G.players[0].bench = [idlerCard, hitterCard, null, null, null];
    withChoice(G, {
      effectKey: 'ability:支配鎖鏈', prompt: '支配鎖鏈：選擇要換上場的惡寶可夢',
      choiceType: 'select_pokemon', count: 1,
      options: [{ id: idlerCard.id, label: '閒人' }, { id: hitterCard.id, label: '打手' }],
      context: {},
    });
    const chosen = await pick(G, [
      mv('resolve_choice', { selection: [idlerCard.id] }, '換閒人'),
      mv('resolve_choice', { selection: [hitterCard.id] }, '換打手'),
    ]);
    expect(chosen.description).toBe('換打手');
  });

  it('will not use a swap ability that displaces its own best attacker', async () => {
    const striker = mon({ name: '主攻手', attacks: [attack('猛擊', ['Grass'], '120')] });
    const weakling = mon({ name: '弱雞', hp: '60' });
    const G = duel(striker, mon({ name: '對手', hp: '300' }));
    G.players[0].active!.attachedEnergy = [energy('e1')];
    const holder = makeGameCard(mon({
      name: '鎖鏈持有者',
      abilities: [{ name: '支配鎖鏈', type: 'Ability', text: '選擇1隻自己的備戰區的寶可夢，與戰鬥寶可夢互換。' }],
    }), 0);
    G.players[0].bench = [holder, makeGameCard(weakling, 0), null, null, null];
    const chosen = await pick(G, [
      mv('use_ability', { cardId: holder.id }, '用支配鎖鏈'),
      mv('end_turn'),
    ]);
    // Every ability scoring a flat 750 meant the AI took this every turn, swapping its loaded
    // attacker out for nothing and never attacking — a real multi-turn loop.
    expect(chosen.description).toBe('end_turn');
  });
  it('will not spend a switch Trainer that changes nothing', async () => {
    // Watched in a real game: the AI played 寶可夢交替 and then retreated in the same turn, the
    // two undoing each other — a flat 770 for any Item meant the card looked free.
    const striker = mon({ name: '主攻手', attacks: [attack('猛擊', ['Grass'], '120')] });
    const G = duel(striker, mon({ name: '對手', hp: '300' }));
    G.players[0].active!.attachedEnergy = [energy('e1')];
    G.players[0].bench = [makeGameCard(mon({ name: '弱雞', hp: '60' }), 0), null, null, null, null];
    const swap = makeGameCard(makeCard({
      name: '寶可夢交替', supertype: 'Trainer', subtypes: ['Item'],
      rules: ['將自己的戰鬥寶可夢與備戰寶可夢互換。'],
    }), 0);
    G.players[0].hand = [swap];
    const chosen = await pick(G, [
      mv('play_trainer', { cardId: swap.id }, '打交替'),
      mv('end_turn'),
    ]);
    expect(chosen.description).toBe('end_turn');
  });

  it('keeps every "does nothing" score clear of the random tie band', async () => {
    // The design rule, not one instance of it: POINTLESS must lose to end_turn OUTRIGHT. At 2 vs
    // 5 the gap was 3, inside TIE_EPSILON, so every pointless move was a coin flip against
    // passing — caught as a flaky spec rather than by reading the numbers.
    const G = duel(mon({ name: '主戰' }));
    const results = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const chosen = await pick(G, [mv('discard_fossil', { cardId: 'fossil-1' }, '棄化石'), mv('end_turn')]);
      results.add(chosen.description);
    }
    expect([...results]).toEqual(['end_turn']);
  });
});
