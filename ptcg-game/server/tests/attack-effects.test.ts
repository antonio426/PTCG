import { describe, it, expect } from 'vitest';
import { hasAttackEffect, startAttackEffect } from '../src/game/effects/attacks';
import { stackAsPreEvolution } from '../src/game/damage';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, STAGE1_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const KANGASKHAN = makeCard({ name: '火箭隊的袋獸ex', hp: '230', types: ['Colorless'], subtypes: ['Basic', 'ex'] });
const ESPEON = makeCard({ name: '太陽伊布ex', hp: '270', types: ['Psychic'], subtypes: ['Stage 1', 'ex'] });
const PLAIN = makeCard({ name: '木頭鼠', hp: '300', types: ['Colorless'], subtypes: ['Basic'] });

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
