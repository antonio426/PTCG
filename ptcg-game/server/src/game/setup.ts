import { Card, GameCard } from '@ptcg/shared';
import { PtcgGameState, PtcgPlayerState } from './GameState';

export interface PtcgSetupData {
  decks: string[][];
  cardData: Record<string, Card>;
  seed?: number;
}

function seededRandom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(array: T[], seed: number): T[] {
  const rng = seededRandom(seed);
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

let instanceCounter = 0;

function createGameCard(cardId: string, cardData: Card, owner: 0 | 1): GameCard {
  return {
    id: `${cardId}_${instanceCounter++}`,
    cardData,
    owner,
    damage: 0,
    statusConditions: [],
    attachedEnergy: [],
  };
}

function createPlayerState(deckCardIds: string[], cardData: Record<string, Card>, playerIndex: 0 | 1, seed: number): PtcgPlayerState {
  const rawCards: GameCard[] = deckCardIds.map(cardId => {
    const data = cardData[cardId];
    if (!data) throw new Error(`Card data not found for ${cardId}`);
    return createGameCard(cardId, data, playerIndex);
  });

  const shuffled = shuffle(rawCards, seed + playerIndex);

  return {
    deck: shuffled,
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
    pokemonPlayedThisTurn: [],
    cardsPlayedThisTurn: 0,
    abilitiesUsedThisTurn: [],
    usedBonusAttackThisTurn: false,
    turnDamageBoosts: [],
    bonusPrizeNextKo: 0,
    incomingDamageReduction: [],
    itemLockedUntilTurn: null,
    poisonedCantRetreatUntilTurn: null,
  };
}

function drawCards(player: PtcgPlayerState, count: number): void {
  for (let i = 0; i < count; i++) {
    const card = player.deck.pop();
    if (!card) break;
    player.hand.push(card);
  }
}

function hasBasicInHand(player: PtcgPlayerState): boolean {
  return player.hand.some(c =>
    c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic')
  );
}

function placeBasics(player: PtcgPlayerState): void {
  const basicIndex = player.hand.findIndex(c =>
    c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic')
  );
  if (basicIndex === -1) return;

  const active = player.hand.splice(basicIndex, 1)[0];
  player.active = active;

  const otherBasics = player.hand.filter(c =>
    c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic')
  );

  for (const basic of otherBasics) {
    const idx = player.hand.indexOf(basic);
    if (idx === -1) continue;
    player.hand.splice(idx, 1);
    const freeSlot = player.bench.findIndex(s => s === null);
    if (freeSlot >= 0 && freeSlot < 5) {
      player.bench[freeSlot] = basic;
    }
  }
}

function setupPrizes(player: PtcgPlayerState, count: number): void {
  for (let i = 0; i < count; i++) {
    const card = player.deck.shift();
    if (card) player.prizes.push(card);
  }
}

export function setup(setupData?: PtcgSetupData): PtcgGameState {
  if (!setupData) throw new Error('Setup data required');
  if (!setupData.decks || setupData.decks.length !== 2) throw new Error('Two decks required');
  if (!setupData.cardData) throw new Error('Card data required');

  const seed = setupData.seed ?? Date.now();
  instanceCounter = 0;

  const players: [PtcgPlayerState, PtcgPlayerState] = [
    createPlayerState(setupData.decks[0], setupData.cardData, 0, seed),
    createPlayerState(setupData.decks[1], setupData.cardData, 1, seed),
  ];

  drawCards(players[0], 7);
  drawCards(players[1], 7);

  const mulliganCounts = [0, 0];

  for (let p = 0; p < 2; p++) {
    const player = players[p as 0 | 1];
    while (!hasBasicInHand(player)) {
      mulliganCounts[p]++;
      player.deck.push(...player.hand);
      player.hand = [];
      player.deck = shuffle(player.deck, seed + p + mulliganCounts[p]);
      drawCards(player, 7);
    }
  }

  for (let p = 0; p < 2; p++) {
    const opponentIdx = (1 - p) as 0 | 1;
    for (let m = 0; m < mulliganCounts[p]; m++) {
      const card = players[opponentIdx].deck.pop();
      if (card) players[opponentIdx].hand.push(card);
    }
  }

  for (let p = 0; p < 2; p++) {
    placeBasics(players[p as 0 | 1]);
  }

  for (let p = 0; p < 2; p++) {
    setupPrizes(players[p as 0 | 1], 6);
  }

  return {
    players,
    turn: 1,
    currentPlayer: 0,
    phase: 'draw',
    winner: null,
    winReason: null,
    turnLog: [],
    pendingChoice: null,
    activeStadium: null,
  };
}
