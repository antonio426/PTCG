/**
 * Synthetic card data + state builders for the test suite.
 *
 * Deliberately does NOT read `server/data/cards.json`: that file is a curated dataset that gets
 * re-fetched and patched by the one-off scripts, so tests keyed to it would break for reasons
 * that have nothing to do with the rule under test. Everything here is hand-built and stable.
 */
import { Card, GameCard, EnergyType, Subtype, Attack } from '@ptcg/shared';
import { PtcgGameState, PtcgPlayerState } from '../src/game/GameState';

const EMPTY_SET = {
  id: 'TEST',
  name: 'Test Set',
  series: 'Test',
  printedTotal: 100,
  total: 100,
  releaseDate: '2026-01-01',
};

let cardSeq = 0;

export function makeCard(overrides: Partial<Card> & { name: string }): Card {
  const id = overrides.id ?? `TEST-${String(++cardSeq).padStart(3, '0')}`;
  return {
    id,
    supertype: 'Pokémon',
    subtypes: ['Basic'] as Subtype[],
    set: EMPTY_SET,
    number: id.split('-')[1] ?? '001',
    legalities: { standard: 'Legal' },
    images: { small: '', large: '' },
    ...overrides,
  } as Card;
}

export function attack(name: string, cost: EnergyType[], damage: string, text = ''): Attack {
  return { name, cost, convertedEnergyCost: cost.length, damage, text };
}

/** A Basic with one 1-Colorless attack — the default body for most rule tests. */
export const BASIC_MON = makeCard({
  id: 'TEST-001',
  name: '測試鼠',
  hp: '60',
  types: ['Colorless'],
  subtypes: ['Basic'],
  attacks: [attack('撞擊', ['Colorless'], '10')],
  retreatCost: ['Colorless'],
  convertedRetreatCost: 1,
});

/** Stage 1 evolving from BASIC_MON — for evolution + pre-evolution-stack tests. */
export const STAGE1_MON = makeCard({
  id: 'TEST-002',
  name: '測試鼠進化',
  hp: '100',
  types: ['Colorless'],
  subtypes: ['Stage 1'],
  evolvesFrom: '測試鼠',
  attacks: [attack('強力撞擊', ['Colorless', 'Colorless'], '50')],
  retreatCost: ['Colorless', 'Colorless'],
  convertedRetreatCost: 2,
});

export const BASIC_ENERGY = makeCard({
  id: 'TEST-003',
  name: '基礎草能量',
  supertype: 'Energy',
  subtypes: ['Basic Energy'],
  types: ['Grass'],
});

/** A plain draw Supporter — used to assert the first-turn Supporter restriction. */
export const SUPPORTER = makeCard({
  id: 'TEST-004',
  name: '測試支援者',
  supertype: 'Trainer',
  subtypes: ['Supporter'],
  rules: ['從自己的牌庫抽出3張卡。'],
});

/**
 * 丹瑜 is one of the two real cards printed with an explicit "may be played on the first turn"
 * override (`FIRST_TURN_SUPPORTER_EXCEPTIONS` in validation.ts). Shaped as a Supporter here only
 * so the exception path is exercised by name.
 */
export const EXEMPT_SUPPORTER = makeCard({
  id: 'TEST-005',
  name: '丹瑜',
  supertype: 'Trainer',
  subtypes: ['Supporter'],
  rules: ['從自己的牌庫抽出2張卡。'],
});

let instanceSeq = 0;

export function makeGameCard(data: Card, owner: 0 | 1 = 0, overrides: Partial<GameCard> = {}): GameCard {
  return {
    id: `${data.id}_t${instanceSeq++}`,
    cardData: data,
    owner,
    damage: 0,
    statusConditions: [],
    attachedEnergy: [],
    ...overrides,
  } as GameCard;
}

export function makePlayer(overrides: Partial<PtcgPlayerState> = {}): PtcgPlayerState {
  return {
    deck: [],
    hand: [],
    bench: [null, null, null, null, null],
    active: null,
    discardPile: [],
    prizes: [],
    takenPrizes: 0,
    exileZone: [],
    energyAttachedThisTurn: 0,
    basicPokemonPlayedThisTurn: 0,
    supporterPlayedThisTurn: false,
    supporterNamesPlayedThisTurn: [],
    attacksUsedThisTurn: [],
    attacksUsedLastTurn: [],
    pokemonPlayedThisTurn: [],
    cardsPlayedThisTurn: 0,
    abilitiesUsedThisTurn: [],
    usedBonusAttackThisTurn: false,
    turnDamageBoosts: [],
    bonusPrizeNextKo: 0,
    incomingDamageReduction: [],
    itemLockedUntilTurn: null,
    supporterLockedUntilTurn: null,
    stadiumLockedUntilTurn: null,
    evolutionLockedUntilTurn: null,
    poisonedCantRetreatUntilTurn: null,
    retreatedThisTurn: false,
    lastPokemonFaintedTurn: null,
    stadiumActionUsedThisTurn: false,
    ...overrides,
  };
}

/** A minimal mid-game state: both sides have an Active, it's player 0's `turn` and 'main' phase. */
export function makeState(overrides: Partial<PtcgGameState> = {}): PtcgGameState {
  return {
    players: [
      makePlayer({ active: makeGameCard(BASIC_MON, 0) }),
      makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
    ],
    turn: 3,
    currentPlayer: 0,
    phase: 'main',
    winner: null,
    winReason: null,
    turnLog: [],
    pendingChoice: null,
    activeStadium: null,
    attackEnergyReturns: null,
    ...overrides,
  };
}

/** A 60-card deck id list suitable for `setup()` — all Basics, so a mulligan is impossible. */
export function basicOnlyDeckIds(): string[] {
  return Array.from({ length: 60 }, () => BASIC_MON.id);
}

export function testCardData(): Record<string, Card> {
  return {
    [BASIC_MON.id]: BASIC_MON,
    [STAGE1_MON.id]: STAGE1_MON,
    [BASIC_ENERGY.id]: BASIC_ENERGY,
    [SUPPORTER.id]: SUPPORTER,
    [EXEMPT_SUPPORTER.id]: EXEMPT_SUPPORTER,
  };
}
