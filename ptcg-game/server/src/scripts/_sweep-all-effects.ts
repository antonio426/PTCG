/**
 * Systematic sweep: exercise every registered trainer/ability effect handler
 * at least once against a rich synthetic game state, auto-resolving any
 * pendingChoice steps, and report which ones (a) threw, (b) ran but had no
 * valid targets ("did nothing" — not a bug, just an under-tested scenario),
 * or (c) fully exercised their real logic. Most of these handlers were only
 * type-checked, never actually run, before this — this is the first pass
 * that actually calls each one.
 *
 * Run with: npx tsx src/scripts/_sweep-all-effects.ts
 */
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { PtcgGameState } from '../game/GameState';
import { trainerEffects } from '../game/effects/trainers';
import { abilityEffects } from '../game/effects/abilities';
import type { EffectContext, EffectHandler, EffectStep } from '../game/effects/types';

function pokemonCard(id: string, name: string, hp: string, types: Card['types'], subtypes: Card['subtypes'], opts: Partial<Card> = {}): Card {
  return {
    id, name, supertype: 'Pokémon', subtypes, hp, types,
    attacks: [{ name: 'Tackle', cost: [], convertedEnergyCost: 0, damage: '10', text: '' }],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
    ...opts,
  };
}

function trainerCardData(id: string, name: string, subtypes: Card['subtypes']): Card {
  return {
    id, name, supertype: 'Trainer', subtypes,
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
  };
}

function energyCardData(id: string, name: string, type: Card['types']): Card {
  return {
    id, name, supertype: 'Energy', subtypes: ['Basic Energy'], types: type,
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
  };
}

// ── Build a diverse card pool so most handlers have something to act on ──
const cardData: Record<string, Card> = {
  basicGrass: pokemonCard('basicGrass', '草基礎獸', '70', ['Grass'], ['Basic']),
  basicFire: pokemonCard('basicFire', '火基礎獸', '60', ['Fire'], ['Basic']),
  basicWater: pokemonCard('basicWater', '水基礎獸', '80', ['Water'], ['Basic']),
  basicLightning: pokemonCard('basicLightning', '雷基礎獸', '65', ['Lightning'], ['Basic']),
  basicFighting: pokemonCard('basicFighting', '鬥基礎獸', '75', ['Fighting'], ['Basic']),
  stage2: pokemonCard('stage2', '測試2階獸', '200', ['Grass'], ['Stage 2'], { evolvesFrom: '草基礎獸' }),
  exMon: pokemonCard('exMon', '測試ex獸', '250', ['Fire'], ['Basic', 'ex']),
  megaMon: pokemonCard('megaMon', '超級測試獸ex', '320', ['Psychic'], ['Basic', 'ex']),
  stadiumCard: trainerCardData('stadiumCard', '測試競技場', ['Stadium']),
  toolCard: trainerCardData('toolCard', '測試道具卡', ['Pokémon Tool']),
  supporterCard: trainerCardData('supporterCard', '測試支援者', ['Supporter']),
  itemCard: trainerCardData('itemCard', '測試物品卡', ['Item']),
  grassEnergy: energyCardData('grassEnergy', '基本草能量', ['Grass']),
  fireEnergy: energyCardData('fireEnergy', '基本火能量', ['Fire']),
  waterEnergy: energyCardData('waterEnergy', '基本水能量', ['Water']),
  lightningEnergy: energyCardData('lightningEnergy', '基本雷能量', ['Lightning']),
};

function buildDeck(): string[] {
  const pool = Object.keys(cardData);
  const deck: string[] = [];
  for (let i = 0; i < 60; i++) deck.push(pool[i % pool.length]);
  return deck;
}

function freshState(): PtcgGameState {
  const G = setup({ decks: [buildDeck(), buildDeck()], cardData, seed: Date.now() });
  G.turn = 3; // clear of the first-turn restriction
  G.currentPlayer = 0;
  G.phase = 'main';
  const p0 = G.players[0];
  const p1 = G.players[1];

  // Stock both players with a wide mix so handlers have real targets: hand, discard, deck, bench.
  // Force-overwrite (not "if empty") since setup()'s own placeBasics() may have already filled
  // active/bench with plain, energy-less Pokémon — leaving handlers that need attached energy
  // or specific types/subtypes with nothing to act on and no way to tell that apart from a real bug.
  for (const idKey of Object.keys(cardData)) {
    p0.hand.push({ id: `${idKey}_h${Math.random()}`, cardData: cardData[idKey], owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });
    p0.discardPile.push({ id: `${idKey}_d${Math.random()}`, cardData: cardData[idKey], owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });
  }
  p0.active = { id: 'active0', cardData: cardData.basicGrass, owner: 0, damage: 20, statusConditions: [], attachedEnergy: [{ id: 'e1', type: 'Grass' }, { id: 'e2', type: 'Lightning' }] };
  p0.bench[0] = { id: 'bench0_0', cardData: cardData.basicFire, owner: 0, damage: 10, statusConditions: [], attachedEnergy: [{ id: 'be0', type: 'Fire' }] };
  p0.bench[1] = { id: 'bench0_1', cardData: cardData.basicLightning, owner: 0, damage: 30, statusConditions: [], attachedEnergy: [{ id: 'be1', type: 'Lightning' }] };
  p0.bench[2] = { id: 'bench0_2', cardData: cardData.megaMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  p1.active = { id: 'active1', cardData: cardData.basicWater, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [{ id: 'oe1', type: 'Water' }] };
  p1.bench[0] = { id: 'bench1_0', cardData: cardData.basicLightning, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [{ id: 'oe2', type: 'Lightning' }] };
  p1.bench[1] = { id: 'bench1_1', cardData: cardData.basicFighting, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };

  // Guarantee at least one Supporter/Stadium/Rocket-named-Supporter near the top of the deck
  // (deck.slice(-N) reads from the end) for the "look at top N" / "search deck" handlers.
  const rocketSupporter: Card = { ...cardData.supporterCard, id: 'rocketSupporter', name: '火箭隊的測試卡' };
  const topStack = [cardData.supporterCard, cardData.stadiumCard, rocketSupporter, cardData.basicGrass, cardData.fireEnergy]
    .map((cd, i) => ({ id: `top_${i}_${Math.random()}`, cardData: cd, owner: 0 as const, damage: 0, statusConditions: [], attachedEnergy: [] }));
  p0.deck.push(...topStack);

  return G;
}

function autoResolve(handler: EffectHandler, ctx: EffectContext): { outcome: 'ran-empty' | 'exercised' | 'error'; error?: string; steps: number } {
  try {
    let step: EffectStep = handler.start(ctx);
    if (step === 'done') return { outcome: 'ran-empty', steps: 0 };
    let steps = 1;
    while (step !== 'done' && steps < 20) {
      const options = step.options?.map(o => o.id) ?? (step.choiceType === 'select_hand_cards' ? ctx.G.players[ctx.playerIndex].hand.map(c => c.id) : []);
      const n = step.count ?? Math.min(step.maxCount ?? options.length, options.length);
      const selection = options.slice(0, n);
      step = handler.resume(ctx, step.context, selection);
      steps++;
    }
    if (steps >= 20) return { outcome: 'error', error: 'did not terminate within 20 steps (possible infinite loop)', steps };
    return { outcome: 'exercised', steps };
  } catch (e: any) {
    return { outcome: 'error', error: e?.message || String(e), steps: 0 };
  }
}

function main() {
  let errors = 0, exercised = 0, ranEmpty = 0;
  console.log('=== Trainer effects ===');
  for (const [name, handler] of Object.entries(trainerEffects)) {
    const G = freshState();
    const ctx: EffectContext = { G, playerIndex: 0, sourceCardId: `sweep-${name}` };
    const result = autoResolve(handler, ctx);
    if (result.outcome === 'error') { console.log(`  ERROR  ${name}: ${result.error}`); errors++; }
    else if (result.outcome === 'exercised') { console.log(`  ok     ${name} (${result.steps} steps)`); exercised++; }
    else { console.log(`  empty  ${name} (no valid targets in test scenario)`); ranEmpty++; }
  }

  console.log('\n=== Ability effects ===');
  for (const [name, handler] of Object.entries(abilityEffects)) {
    const G = freshState();
    const ctx: EffectContext = { G, playerIndex: 0, sourceCardId: G.players[0].active!.id };
    const result = autoResolve(handler, ctx);
    if (result.outcome === 'error') { console.log(`  ERROR  ${name}: ${result.error}`); errors++; }
    else if (result.outcome === 'exercised') { console.log(`  ok     ${name} (${result.steps} steps)`); exercised++; }
    else { console.log(`  empty  ${name} (no valid targets in test scenario)`); ranEmpty++; }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Exercised (ran real logic): ${exercised}`);
  console.log(`  Ran but did nothing (no targets in this scenario): ${ranEmpty}`);
  console.log(`  ERRORS (threw or hung): ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main();
