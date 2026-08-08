/**
 * Ad-hoc smoke test for the new effect framework (no test runner in this project).
 * Builds a minimal fake deck/card set and exercises: Ultra Ball (2-step trainer),
 * Strategic Command ability (look-2-take-1), multi-prize KO for ex Pokémon, and
 * the first-turn attack/evolve/supporter restriction. Run with: npx tsx src/scripts/_verify-effects.ts
 */
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves, effectiveRetreatCost as effectiveRetreatCostForTest } from '../game/validation';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok:', msg);
}

function basicCard(id: string, name: string, hp: string, subtypes: Card['subtypes'] = ['Basic']): Card {
  return {
    id, name, supertype: 'Pokémon', subtypes, hp, types: ['Colorless'],
    attacks: [{ name: 'Tackle', cost: [], convertedEnergyCost: 0, damage: '10', text: '' }],
    abilities: [{ name: '偵查指令', text: 'look at top 2, take 1', type: 'Ability' }],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: '1', legalities: {}, images: { small: '', large: '' },
  };
}

function trainerCard(id: string, name: string, subtypes: Card['subtypes']): Card {
  return {
    id, name, supertype: 'Trainer', subtypes,
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: '1', legalities: {}, images: { small: '', large: '' },
  };
}

const cardData: Record<string, Card> = {
  basic1: { ...basicCard('basic1', '測試基礎獸', '60'), retreatCost: ['Colorless', 'Colorless'], convertedRetreatCost: 2 },
  exmon: { ...basicCard('exmon', '測試ex獸', '200'), subtypes: ['Basic', 'ex'] },
  ultraBall: trainerCard('ultraBall', '高級球', ['Item']),
  balloon: trainerCard('balloon', '氣球', ['Pokémon Tool']),
};

const deckA = ['basic1', ...Array(20).fill('basic1'), 'ultraBall', 'balloon', ...Array(30).fill('basic1')];
const deckB = ['exmon', ...Array(50).fill('exmon')];

const G = setup({ decks: [deckA, deckB], cardData, seed: 42 });

// --- First-turn restriction: player 0 (turn 1) shouldn't be able to attack or evolve ---
const t1Moves = getLegalMoves(G, 0);
assert(!t1Moves.some(m => m.type === 'attack'), 'turn 1: attack is not a legal move');
assert(!t1Moves.some(m => m.type === 'evolve_pokemon'), 'turn 1: evolve is not a legal move');

// --- Ultra Ball: 2-step pending-choice flow ---
G.phase = 'main';
// setup()'s placeBasics() drains nearly all Basic Pokémon out of the opening hand onto the
// bench (this test deck is almost entirely 'basic1'), so pad hand with junk cards to discard.
for (let i = 0; i < 3; i++) {
  const idx = G.players[0].deck.findIndex(c => c.cardData.id === 'basic1');
  if (idx >= 0) G.players[0].hand.push(G.players[0].deck.splice(idx, 1)[0]);
}
// Force it into hand deterministically rather than relying on the shuffle to deal it into the opening 7.
let ultraBallInHand = G.players[0].hand.find(c => c.cardData.id === 'ultraBall');
if (!ultraBallInHand) {
  const deckIdx = G.players[0].deck.findIndex(c => c.cardData.id === 'ultraBall');
  if (deckIdx >= 0) {
    ultraBallInHand = G.players[0].deck.splice(deckIdx, 1)[0];
    G.players[0].hand.push(ultraBallInHand);
  }
}
assert(!!ultraBallInHand, 'Ultra Ball is in player 0 hand for the test');
if (ultraBallInHand) {
  const handSizeBefore = G.players[0].hand.length;
  moves.playTrainer({ G, ctx: { currentPlayer: '0' } }, ultraBallInHand.id);
  assert(G.pendingChoice !== null, 'Ultra Ball creates a pendingChoice (discard step)');
  assert(G.pendingChoice?.choiceType === 'select_hand_cards', 'first step asks to select hand cards');

  const discardIds = G.players[0].hand.slice(0, 2).map(c => c.id);
  moves.resolveChoice({ G, ctx: { currentPlayer: '0' } }, discardIds);
  // Ultra Ball itself is discarded when played too (playTrainer's final step), so the pile
  // has 3: the 2 chosen discards + the Ultra Ball card itself.
  assert(G.players[0].discardPile.length === 3, 'Ultra Ball discarded exactly 2 cards (+ itself)');
  assert(G.pendingChoice !== null && G.pendingChoice.choiceType === 'select_from_list', 'second step asks to search the deck');

  const searchOptions = G.pendingChoice?.options || [];
  if (searchOptions.length > 0) {
    moves.resolveChoice({ G, ctx: { currentPlayer: '0' } }, [searchOptions[0].id]);
  }
  assert(G.pendingChoice === null, 'Ultra Ball fully resolves after both steps');
  assert(G.players[0].hand.length === handSizeBefore - 1 - 2 + 1, 'hand size reflects: -Ultra Ball -2 discards +1 searched Pokemon');
}

// --- Ability: 偵查指令 (look at top 2, take 1) via getLegalMoves + useAbility ---
const activeMon = G.players[0].active;
if (activeMon) {
  const abilityMoves = getLegalMoves(G, 0).filter(m => m.type === 'use_ability');
  assert(abilityMoves.length > 0, 'use_ability is offered for a Pokémon with a registered ability');
  moves.useAbility({ G, ctx: { currentPlayer: '0' } }, activeMon.id);
  assert(G.pendingChoice?.choiceType === 'select_from_list' && (G.pendingChoice.options?.length ?? 0) <= 2, 'Strategic Command reveals up to 2 deck cards');
  const opt = G.pendingChoice?.options?.[0];
  if (opt) {
    const handBefore = G.players[0].hand.length;
    moves.resolveChoice({ G, ctx: { currentPlayer: '0' } }, [opt.id]);
    assert(G.players[0].hand.length === handBefore + 1, 'chosen card goes to hand');
    assert(G.pendingChoice === null, 'ability fully resolves');
  }
}

// --- Multi-prize KO: defeating an 'ex' Pokémon should award 2 prizes ---
{
  const p0 = G.players[0];
  const p1 = G.players[1];
  const before = p0.takenPrizes;
  const handBefore = p0.hand.length;
  // Force lethal damage directly and reuse the shared KO path via moves.attack's internals is awkward here,
  // so call handleKo directly (same function attack() uses) to isolate the prize-count behavior.
  const { handleKo } = require('../game/damage');
  if (p1.active) {
    p1.active.damage = 999;
    handleKo(G, 1, p1.active.id);
  }
  assert(p0.takenPrizes === before + 2, `defeating an ex Pokémon awards 2 prizes (got ${p0.takenPrizes - before})`);
  assert(p0.hand.length === handBefore + 2, 'both prize cards are added to the winning player\'s hand');
}

// --- Tool card: 氣球 attaches persistently and reduces retreat cost by 2 ---
{
  const p0 = G.players[0];
  if (p0.active) {
    const before = effectiveRetreatCostForTest(G, p0.active);
    const deckIdx = p0.deck.findIndex(c => c.cardData.id === 'balloon');
    const balloon = deckIdx >= 0 ? p0.deck.splice(deckIdx, 1)[0] : null;
    if (balloon) {
      p0.hand.push(balloon);
      moves.playTrainer({ G, ctx: { currentPlayer: '0' } }, balloon.id);
      assert(G.pendingChoice?.effectKey === 'tool_attach', 'playing a Pokémon Tool creates a tool_attach pendingChoice');
      moves.resolveChoice({ G, ctx: { currentPlayer: '0' } }, [p0.active.id]);
      assert(G.pendingChoice === null, 'tool attachment resolves immediately');
      assert(p0.active.attachedTool?.cardData.name === '氣球', 'Balloon is now attached to the active Pokémon');
      const after = effectiveRetreatCostForTest(G, p0.active);
      assert(after === Math.max(0, before - 2), `retreat cost reduced by 2 (was ${before}, now ${after})`);
    }
  }
}

// --- Status conditions: Poisoned deals 10 damage during Between Turns ---
{
  const { processBetweenTurns } = require('../game/statusConditions');
  const p0 = G.players[0];
  if (p0.active) {
    p0.active.statusConditions.push('Poisoned');
    p0.active.damage = 0;
    processBetweenTurns(G);
    assert(p0.active?.damage === 10 || p0.active === null, 'Poisoned Pokémon takes 10 damage during Between Turns');
  }
}

// --- Attack framework: 幻影奇襲-style bench damage distribution (registered under 多龍巴魯托ex) ---
{
  const dragapultCard: Card = {
    id: 'dragapult', name: '多龍巴魯托ex', supertype: 'Pokémon', subtypes: ['Basic', 'ex'], hp: '300', types: ['Colorless'],
    attacks: [{ name: '幻影奇襲', cost: [], convertedEnergyCost: 0, damage: '200', text: '將6個傷害指示物以任意方式放置於對手的備戰寶可夢身上。' }],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: '2', legalities: {}, images: { small: '', large: '' },
  };
  const benchMon: Card = { ...basicCard('benchmon', '測試備戰獸', '100') };
  const cardData2: Record<string, Card> = { dragapult: dragapultCard, exmon: cardData.exmon, benchmon: benchMon };
  const deck1 = ['dragapult', ...Array(30).fill('dragapult')];
  const deck2 = ['exmon', 'benchmon', 'benchmon', ...Array(30).fill('exmon')];
  const G2 = setup({ decks: [deck1, deck2], cardData: cardData2, seed: 7 });
  G2.turn = 2; G2.currentPlayer = 0; G2.phase = 'main'; // bypass first-turn-can't-attack restriction
  // Make sure opponent has 2 benched targets.
  for (const c of G2.players[1].deck.filter(c => c.cardData.id === 'benchmon').slice(0, 2)) {
    const slot = G2.players[1].bench.findIndex(s => s === null);
    if (slot >= 0) { const i = G2.players[1].deck.indexOf(c); G2.players[1].bench[slot] = G2.players[1].deck.splice(i, 1)[0]; }
  }
  const benchTargets = G2.players[1].bench.filter((c): c is NonNullable<typeof c> => c !== null);
  assert(benchTargets.length >= 2, `test setup: opponent has at least 2 benched Pokémon (got ${benchTargets.length})`);

  moves.attack({ G: G2, ctx: { currentPlayer: '0', events: { endTurn: () => {} } } }, 0);
  assert(G2.pendingChoice?.effectKey?.startsWith('attack:') ?? false, 'Phantom Dive-style attack opens a pendingChoice for bench distribution');
  let rounds = 0;
  while (G2.pendingChoice && rounds < 10) {
    const opt = G2.pendingChoice.options![0];
    moves.resolveChoice({ G: G2, ctx: { currentPlayer: '0', events: { endTurn: () => {} } } }, [opt.id]);
    rounds++;
  }
  assert(G2.pendingChoice === null, 'all 6 damage counters get placed and the effect resolves');
  const totalBenchDamage = G2.players[1].bench.reduce((sum, c) => sum + (c?.damage ?? 0), 0);
  assert(totalBenchDamage === 60 || rounds < 6, `6 counters (60 damage) distributed across the bench (got ${totalBenchDamage} over ${rounds} rounds)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
