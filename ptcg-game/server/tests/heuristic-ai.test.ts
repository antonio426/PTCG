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
