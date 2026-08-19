import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { canEvolve, canRetreat, getLegalMoves } from '../src/game/validation';
import { effectiveMaxHp } from '../src/game/damage';
import { areAbilitiesNegated } from '../src/game/effects/passiveAbilities';
import { benchDamageFromEffectsBlocked, benchLimit as benchLimitFor, isStadiumActive, toolsAreDisabled } from '../src/game/effects/stadiums';
import { processBetweenTurns as processBetweenTurnsForTest } from '../src/game/statusConditions';
import { applyStatusCondition } from '../src/game/effects/primitives';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Card, Subtype } from '@ptcg/shared';

/**
 * Stadiums are the blind spot of coverage-report.ts: it counts every Stadium "covered" because
 * they all get the generic field-slot handling, so a Stadium whose printed effect is wired
 * nowhere still reports as done. These specs check what each one actually DOES.
 */

const stadium = (name: string): Card =>
  makeCard({ name, supertype: 'Trainer', subtypes: ['Stadium'] as Subtype[] });

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });

/** Puts `name` straight into the field slot, as playTrainer would. */
function withStadium(G: PtcgGameState, name: string, owner: 0 | 1 = 0) {
  G.activeStadium = makeGameCard(stadium(name), owner);
  return G;
}

const mon = (over: Partial<Card> & { name: string }) => makeCard({ hp: '100', types: ['Colorless'], subtypes: ['Basic'], ...over });

// ─────────────────────────── the field slot itself ───────────────────────────

describe('the Stadium field slot', () => {
  function boardWith(handStadium: string) {
    const card = makeGameCard(stadium(handStadium), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), hand: [card] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, card };
  }

  it('playing a Stadium puts it in the field slot instead of the discard pile', () => {
    const { G, card } = boardWith('引力山岳');
    moves.playTrainer({ G, ctx: ctxFor(G) } as any, card.id);
    expect(G.activeStadium?.id).toBe(card.id);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('only one is ever in play — the old one goes to ITS OWN owner\'s discard pile', () => {
    const { G, card } = boardWith('引力山岳');
    const old = makeGameCard(stadium('激動競技場'), 1);
    G.activeStadium = old;
    moves.playTrainer({ G, ctx: ctxFor(G) } as any, card.id);
    expect(G.activeStadium?.id).toBe(card.id);
    expect(G.players[1].discardPile.map(c => c.id)).toContain(old.id);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('isStadiumActive matches by printed name', () => {
    const G = withStadium(makeState(), '引力山岳');
    expect(isStadiumActive(G, '引力山岳')).toBe(true);
    expect(isStadiumActive(G, '激動競技場')).toBe(false);
  });
});

// ─────────────────────────── passive Stadiums ───────────────────────────

describe('激動競技場 / 引力山岳 (max-HP modifiers)', () => {
  const basic = makeGameCard(mon({ name: '基礎鼠', hp: '100' }), 0);
  const stage2 = makeGameCard(mon({ name: '二階鼠', hp: '200', subtypes: ['Stage 2'] as Subtype[] }), 1);

  it('激動競技場 gives every Basic +30, on BOTH sides', () => {
    const G = withStadium(makeState(), '激動競技場');
    expect(effectiveMaxHp(G, basic)).toBe(130);
    expect(effectiveMaxHp(G, makeGameCard(mon({ name: '敵基礎鼠', hp: '60' }), 1))).toBe(90);
  });

  it('激動競技場 leaves a Stage 2 alone', () => {
    const G = withStadium(makeState(), '激動競技場');
    expect(effectiveMaxHp(G, stage2)).toBe(200);
  });

  it('引力山岳 takes 30 off every Stage 2', () => {
    const G = withStadium(makeState(), '引力山岳');
    expect(effectiveMaxHp(G, stage2)).toBe(170);
  });

  it('引力山岳 leaves a Basic alone', () => {
    const G = withStadium(makeState(), '引力山岳');
    expect(effectiveMaxHp(G, basic)).toBe(100);
  });

  it('neither applies with no Stadium in play', () => {
    const G = makeState();
    expect(effectiveMaxHp(G, basic)).toBe(100);
    expect(effectiveMaxHp(G, stage2)).toBe(200);
  });
});

describe('火箭隊的監視塔 (negates Colorless abilities)', () => {
  const colorless = makeGameCard(mon({
    name: '無屬性鼠', types: ['Colorless'],
    abilities: [{ name: '測試特性', type: 'Ability', text: 'x' }],
  }), 0);
  const psychic = makeGameCard(mon({
    name: '超屬性鼠', types: ['Psychic'],
    abilities: [{ name: '測試特性', type: 'Ability', text: 'x' }],
  }), 1);

  it('negates a Colorless Pokémon\'s abilities', () => {
    const G = withStadium(makeState(), '火箭隊的監視塔');
    expect(areAbilitiesNegated(G, colorless)).toBe(true);
  });

  it('leaves a non-Colorless Pokémon alone', () => {
    const G = withStadium(makeState(), '火箭隊的監視塔');
    expect(areAbilitiesNegated(G, psychic)).toBe(false);
  });

  it('applies to the Stadium owner\'s own Pokémon too — the text says both sides', () => {
    const G = withStadium(makeState(), '火箭隊的監視塔', 0);
    expect(areAbilitiesNegated(G, makeGameCard(mon({
      name: '我方無屬性鼠', types: ['Colorless'],
      abilities: [{ name: '測試特性', type: 'Ability', text: 'x' }],
    }), 0))).toBe(true);
  });
});

describe('N的城堡 (waives 「N的」 retreat cost)', () => {
  function board(name: string, stadiumName?: string) {
    const active = makeGameCard(mon({
      name, retreatCost: ['Colorless', 'Colorless'] as any, convertedRetreatCost: 2,
    }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active, bench: [makeGameCard(BASIC_MON, 0), null, null, null, null] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    if (stadiumName) withStadium(G, stadiumName);
    return G;
  }

  it('lets an N-family Pokémon retreat with no energy attached', () => {
    expect(canRetreat(board('N的索羅亞克ex', 'N的城堡'), 0)).toBe(true);
  });

  it('does nothing for a Pokémon outside the family', () => {
    expect(canRetreat(board('普通鼠', 'N的城堡'), 0)).toBe(false);
  });

  it('the same N-family Pokémon still can\'t retreat with no Stadium out', () => {
    expect(canRetreat(board('N的索羅亞克ex'), 0)).toBe(false);
  });
});

describe('活力森林 (Grass may evolve the turn it was played)', () => {
  const GRASS_BASIC = mon({ name: '草基礎鼠', types: ['Grass'] });
  const GRASS_STAGE1 = mon({
    name: '草一階鼠', types: ['Grass'], subtypes: ['Stage 1'] as Subtype[], evolvesFrom: '草基礎鼠',
  });
  const FIRE_BASIC = mon({ name: '火基礎鼠', types: ['Fire'] });
  const FIRE_STAGE1 = mon({
    name: '火一階鼠', types: ['Fire'], subtypes: ['Stage 1'] as Subtype[], evolvesFrom: '火基礎鼠',
  });

  function board(basic: Card, evo: Card, stadiumName?: string, turn = 3) {
    const target = makeGameCard(basic, 0);
    const evolution = makeGameCard(evo, 0);
    const G = makeState({
      turn, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: target, hand: [evolution], pokemonPlayedThisTurn: [target.id] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    if (stadiumName) withStadium(G, stadiumName);
    return { G, target, evolution };
  }

  it('normally a Pokémon played this turn cannot evolve', () => {
    const { G, target, evolution } = board(GRASS_BASIC, GRASS_STAGE1);
    expect(canEvolve(G, 0, evolution.id, target.id)).toBe(false);
  });

  it('with 活力森林 out, Grass into Grass may evolve the same turn', () => {
    const { G, target, evolution } = board(GRASS_BASIC, GRASS_STAGE1, '活力森林');
    expect(canEvolve(G, 0, evolution.id, target.id)).toBe(true);
  });

  it('does not extend to a non-Grass line', () => {
    const { G, target, evolution } = board(FIRE_BASIC, FIRE_STAGE1, '活力森林');
    expect(canEvolve(G, 0, evolution.id, target.id)).toBe(false);
  });

  it('never overrides the game\'s own first-turn evolution ban', () => {
    // The printed text keeps that exclusion ("自己的最初回合除外").
    const { G, target, evolution } = board(GRASS_BASIC, GRASS_STAGE1, '活力森林', 1);
    expect(canEvolve(G, 0, evolution.id, target.id)).toBe(false);
  });
});

describe('險惡廢墟 (2 counters on a Basic placed on the Bench)', () => {
  function board(card: Card) {
    const inHand = makeGameCard(card, 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), hand: [inHand], prizes: [makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    withStadium(G, '險惡廢墟');
    return { G, inHand };
  }

  it('places 2 damage counters on a Basic as it arrives', () => {
    const { G, inHand } = board(mon({ name: '普通基礎鼠', types: ['Psychic'] }));
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, inHand.id);
    expect(inHand.damage).toBe(20);
  });

  it('spares Darkness Pokémon, as printed', () => {
    const { G, inHand } = board(mon({ name: '惡基礎鼠', types: ['Darkness'] }));
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, inHand.id);
    expect(inHand.damage).toBe(0);
  });

  it('can KO on arrival when the Pokémon is small enough', () => {
    const { G, inHand } = board(mon({ name: '脆皮鼠', hp: '20', types: ['Psychic'] }));
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, inHand.id);
    expect(G.players[0].discardPile.map(c => c.id)).toContain(inHand.id);
    expect(G.players[1].takenPrizes).toBe(1);
  });
});

describe('阻礙之塔 / 對戰圓形競技場 (blanket field switches)', () => {
  it('阻礙之塔 disables Tools', () => {
    expect(toolsAreDisabled(withStadium(makeState(), '阻礙之塔'))).toBe(true);
    expect(toolsAreDisabled(makeState())).toBe(false);
  });

  it('對戰圓形競技場 blocks bench damage from effects', () => {
    expect(benchDamageFromEffectsBlocked(withStadium(makeState(), '對戰圓形競技場'))).toBe(true);
    expect(benchDamageFromEffectsBlocked(makeState())).toBe(false);
  });
});

describe('祭典會場 (Special Condition immunity for energy-bearing Pokémon)', () => {
  // 「雙方的所有身上附有能量卡的寶可夢不會陷入特殊狀態，並將受到的特殊狀態全部恢復。」
  const withEnergy = () => makeGameCard(mon({ name: '帶能量鼠' }), 0, {
    attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
  });
  const withoutEnergy = () => makeGameCard(mon({ name: '無能量鼠' }), 0);

  it('a Pokémon with Energy attached cannot be given a Special Condition', () => {
    const G = withStadium(makeState(), '祭典會場');
    const card = withEnergy();
    G.players[0].active = card;
    applyStatusCondition(G, card, 'Asleep');
    expect(card.statusConditions).toEqual([]);
  });

  it('a Pokémon with no Energy attached is affected normally', () => {
    const G = withStadium(makeState(), '祭典會場');
    const card = withoutEnergy();
    G.players[0].active = card;
    applyStatusCondition(G, card, 'Asleep');
    expect(card.statusConditions).toContain('Asleep');
  });

  it('applies to the opponent\'s Pokémon too — the text says both sides', () => {
    const G = withStadium(makeState(), '祭典會場');
    const card = makeGameCard(mon({ name: '敵帶能量鼠' }), 1, {
      attachedEnergy: [{ id: 'e2', type: 'Fire', cardData: BASIC_ENERGY }],
    });
    G.players[1].active = card;
    applyStatusCondition(G, card, 'Poisoned');
    expect(card.statusConditions).toEqual([]);
  });

  it('without the Stadium out, an energy-bearing Pokémon is affected normally', () => {
    const G = makeState();
    const card = withEnergy();
    G.players[0].active = card;
    applyStatusCondition(G, card, 'Asleep');
    expect(card.statusConditions).toContain('Asleep');
  });
});

// ─────────────────────────── once-per-turn action Stadiums ───────────────────────────

describe('once-per-turn Stadium actions', () => {
  function board(stadiumName: string, over: Partial<ReturnType<typeof makePlayer>> = {}) {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: makeGameCard(BASIC_MON, 0), ...over }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    withStadium(G, stadiumName);
    return G;
  }

  const actionFor = (G: PtcgGameState) => getLegalMoves(G, 0).filter(m => m.type === 'use_stadium_action');

  it('稜鏡塔 discards 2 and draws 1', () => {
    const hand = [makeGameCard(BASIC_ENERGY, 0), makeGameCard(BASIC_ENERGY, 0)];
    const G = board('稜鏡塔', { hand, deck: [makeGameCard(BASIC_MON, 0)] });
    const ctx = ctxFor(G);
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx } as any, 'prism_tower_draw');
    const pick = getLegalMoves(G, 0).find(m => m.type === 'resolve_choice')!;
    moves.resolveChoice({ G, ctx } as any, pick.payload!.selection as string[]);
    expect(G.players[0].discardPile).toHaveLength(2);
    expect(G.players[0].hand).toHaveLength(1);
    expect(G.players[0].stadiumActionUsedThisTurn).toBe(true);
  });

  it('稜鏡塔 is not offered with fewer than 2 cards in hand', () => {
    expect(actionFor(board('稜鏡塔', { hand: [makeGameCard(BASIC_ENERGY, 0)] }))).toHaveLength(0);
  });

  it('夜間學院 puts a hand card back on top of the deck', () => {
    const card = makeGameCard(BASIC_ENERGY, 0);
    const G = board('夜間學院', { hand: [card], deck: [makeGameCard(BASIC_MON, 0)] });
    const ctx = ctxFor(G);
    moves.useStadiumAction({ G, ctx } as any, 'night_school_topdeck');
    const pick = getLegalMoves(G, 0).find(m => m.type === 'resolve_choice')!;
    moves.resolveChoice({ G, ctx } as any, pick.payload!.selection as string[]);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].deck[G.players[0].deck.length - 1].id).toBe(card.id);
  });

  it('居民會館 heals 10 off all your Pokémon, but only after a Supporter this turn', () => {
    const hurt = makeGameCard(BASIC_MON, 0, { damage: 30 });
    const G = board('居民會館', { active: hurt, supporterPlayedThisTurn: true });
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx: ctxFor(G) } as any, 'resident_hall_heal');
    expect(hurt.damage).toBe(20);
  });

  it('居民會館 is not offered before a Supporter has been played', () => {
    expect(actionFor(board('居民會館', { supporterPlayedThisTurn: false }))).toHaveLength(0);
  });

  it('火箭隊的工廠 draws 2, but only after a 火箭隊 Supporter', () => {
    const G = board('火箭隊的工廠', {
      supporterNamesPlayedThisTurn: ['火箭隊的老大的指令'],
      deck: [makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0)],
    });
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx: ctxFor(G) } as any, 'rocket_factory_draw');
    expect(G.players[0].hand).toHaveLength(2);
  });

  it('火箭隊的工廠 is not offered for a Supporter outside the family', () => {
    expect(actionFor(board('火箭隊的工廠', { supporterNamesPlayedThisTurn: ['博士的研究'] }))).toHaveLength(0);
  });

  it('衝浪海灘 swaps a Water Active with a Water Bench Pokémon', () => {
    const water = mon({ name: '水鼠', types: ['Water'] });
    const active = makeGameCard(water, 0);
    const benched = makeGameCard(water, 0);
    const G = board('衝浪海灘', { active, bench: [benched, null, null, null, null] });
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx: ctxFor(G) } as any, 'surf_beach_swap');
    expect(G.players[0].active?.id).toBe(benched.id);
    expect(G.players[0].bench[0]?.id).toBe(active.id);
  });

  it('衝浪海灘 is not offered when the Active is not Water', () => {
    const water = makeGameCard(mon({ name: '水鼠', types: ['Water'] }), 0);
    expect(actionFor(board('衝浪海灘', {
      active: makeGameCard(BASIC_MON, 0), bench: [water, null, null, null, null],
    }))).toHaveLength(0);
  });

  it('尖釘鎮道館 searches out a 瑪俐的 Pokémon', () => {
    const target = makeGameCard(mon({ name: '瑪俐的長毛巨魔ex' }), 0);
    const G = board('尖釘鎮道館', { deck: [target, makeGameCard(BASIC_MON, 0)] });
    const ctx = ctxFor(G);
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx } as any, 'spike_town_gym_search');
    const pick = getLegalMoves(G, 0).find(m => m.type === 'resolve_choice' && (m.payload!.selection as string[])[0] === target.id)!;
    moves.resolveChoice({ G, ctx } as any, pick.payload!.selection as string[]);
    expect(G.players[0].hand.map(c => c.id)).toContain(target.id);
  });

  it('尖釘鎮道館 is not offered with no 瑪俐的 Pokémon in the deck', () => {
    expect(actionFor(board('尖釘鎮道館', { deck: [makeGameCard(BASIC_MON, 0)] }))).toHaveLength(0);
  });

  it('神秘花園 draws up to the number of your Psychic Pokémon', () => {
    const psychic = mon({ name: '超鼠', types: ['Psychic'] });
    const energy = makeGameCard(BASIC_ENERGY, 0);
    const G = board('神秘花園', {
      active: makeGameCard(psychic, 0),
      bench: [makeGameCard(psychic, 0), null, null, null, null],
      hand: [energy],
      deck: Array.from({ length: 5 }, () => makeGameCard(BASIC_MON, 0)),
    });
    const ctx = ctxFor(G);
    expect(actionFor(G)).toHaveLength(1);
    moves.useStadiumAction({ G, ctx } as any, 'mystery_garden_draw');
    const pick = getLegalMoves(G, 0).find(m => m.type === 'resolve_choice' && (m.payload!.selection as string[])[0] === energy.id)!;
    moves.resolveChoice({ G, ctx } as any, pick.payload!.selection as string[]);
    // 2 Psychic Pokémon in play, energy discarded from hand -> draw up to a hand of 2.
    expect(G.players[0].hand).toHaveLength(2);
  });

  it('every action Stadium is once per turn', () => {
    const G = board('居民會館', {
      active: makeGameCard(BASIC_MON, 0, { damage: 50 }),
      supporterPlayedThisTurn: true,
      stadiumActionUsedThisTurn: true,
    });
    expect(actionFor(G)).toHaveLength(0);
    moves.useStadiumAction({ G, ctx: ctxFor(G) } as any, 'resident_hall_heal');
    expect(G.players[0].active?.damage).toBe(50);
  });

  it('both players get their own use — the flag is per player', () => {
    const G = board('稜鏡塔', { hand: [makeGameCard(BASIC_ENERGY, 0), makeGameCard(BASIC_ENERGY, 0)] });
    G.players[0].stadiumActionUsedThisTurn = true;
    expect(G.players[1].stadiumActionUsedThisTurn).toBe(false);
  });
});

// ─────────────────────────── 零之大空洞 (variable Bench size) ───────────────────────────

describe('零之大空洞 (8 Bench slots for a player with a 太晶 Pokémon)', () => {
  const TERA_TEXT = '只要這隻寶可夢在備戰區，不會受到招式的傷害。';
  const TERA = mon({
    name: '太晶鼠',
    attacks: [{ name: '太晶', cost: ['Colorless'] as any, convertedEnergyCost: 1, damage: '10', text: TERA_TEXT }],
  });

  function board(opts: { stadium?: boolean; tera?: boolean; benchCount?: number } = {}) {
    const bench: (ReturnType<typeof makeGameCard> | null)[] =
      Array.from({ length: 5 }, (_, i) => (i < (opts.benchCount ?? 0) ? makeGameCard(BASIC_MON, 0) : null));
    const extra = makeGameCard(BASIC_MON, 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(opts.tera ? TERA : BASIC_MON, 0),
          bench: bench as any,
          hand: [extra],
          prizes: [makeGameCard(BASIC_MON, 0)],
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    if (opts.stadium) withStadium(G, '零之大空洞');
    return { G, extra };
  }

  const benchCount = (G: PtcgGameState) => G.players[0].bench.filter(Boolean).length;

  it('a full Bench of 5 normally refuses a 6th', () => {
    const { G, extra } = board({ tera: true, benchCount: 5 });
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, extra.id);
    expect(benchCount(G)).toBe(5);
    expect(G.players[0].hand.map(c => c.id)).toContain(extra.id);
  });

  it('with the Stadium out and a 太晶 Pokémon in play, a 6th fits', () => {
    const { G, extra } = board({ stadium: true, tera: true, benchCount: 5 });
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, extra.id);
    expect(benchCount(G)).toBe(6);
  });

  it('the Stadium alone does nothing without a 太晶 Pokémon', () => {
    const { G, extra } = board({ stadium: true, tera: false, benchCount: 5 });
    moves.playPokemon({ G, ctx: ctxFor(G) } as any, extra.id);
    expect(benchCount(G)).toBe(5);
  });

  it('the limit is per player — the opponent without a 太晶 keeps 5', () => {
    const { G } = board({ stadium: true, tera: true });
    expect(benchLimitFor(G, 0)).toBe(8);
    expect(benchLimitFor(G, 1)).toBe(5);
  });

  it('caps at 8, not higher', () => {
    const { G } = board({ stadium: true, tera: true });
    expect(benchLimitFor(G, 0)).toBe(8);
  });

  it('discards back down to 5 once the Stadium is replaced', () => {
    // Fill to 7 under the Stadium, then swap in a different Stadium.
    const { G } = board({ stadium: true, tera: true, benchCount: 5 });
    G.players[0].bench.push(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0));
    expect(benchCount(G)).toBe(7);

    const replacement = makeGameCard(stadium('引力山岳'), 0);
    G.players[0].hand = [replacement];
    moves.playTrainer({ G, ctx: ctxFor(G) } as any, replacement.id);

    expect(benchCount(G)).toBe(5);
    expect(G.players[0].discardPile.filter(c => c.cardData.name === BASIC_MON.name)).toHaveLength(2);
  });

  it('discards back down to 5 once the last 太晶 Pokémon is gone', () => {
    const { G } = board({ stadium: true, tera: true, benchCount: 5 });
    G.players[0].bench.push(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0));
    // The Tera Active leaves play; nothing Tera remains.
    G.players[0].active = makeGameCard(BASIC_MON, 0);
    processBetweenTurnsForTest(G);
    expect(benchCount(G)).toBe(5);
  });

  it('keeps the extra slots while a 太晶 Pokémon is still benched', () => {
    const { G } = board({ stadium: true, tera: false, benchCount: 4 });
    G.players[0].bench[4] = makeGameCard(TERA, 0);
    G.players[0].bench.push(makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0));
    processBetweenTurnsForTest(G);
    expect(benchCount(G)).toBe(7);
  });
});
