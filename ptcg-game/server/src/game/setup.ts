import { Card, GameCard, TurnAction } from '@ptcg/shared';
import { PtcgGameState, PtcgPlayerState } from './GameState';

export interface PtcgSetupData {
  decks: string[][];
  cardData: Record<string, Card>;
  seed?: number;
  /** Which player index (if any) picks their own opening Active instead of having the
   * first Basic in their hand auto-placed — used for the human side of a human-vs-AI
   * battle. That player's hand keeps every Basic; they place one as Active via the
   * 'choose_active' move, and any others normally via 'play_pokemon' on their first turn. */
  interactivePlayer?: 0 | 1;
  /** Local-2P form: BOTH seats are human (e.g. [0, 1]). Supersedes interactivePlayer. */
  interactivePlayers?: (0 | 1)[];
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
    retreatedThisTurn: false,
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

function addSetupLog(log: TurnAction[], player: 0 | 1, action: string, details: string): void {
  log.push({ player, turn: 1, action, details, timestamp: Date.now() });
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
  const interactive = new Set<0 | 1>(
    setupData.interactivePlayers ?? (setupData.interactivePlayer !== undefined ? [setupData.interactivePlayer] : []),
  );

  const players: [PtcgPlayerState, PtcgPlayerState] = [
    createPlayerState(setupData.decks[0], setupData.cardData, 0, seed),
    createPlayerState(setupData.decks[1], setupData.cardData, 1, seed),
  ];

  drawCards(players[0], 7);
  drawCards(players[1], 7);

  const mulliganCounts = [0, 0];
  const turnLog: TurnAction[] = [];
  const mulliganReveals: { player: 0 | 1; cards: { name: string; image: string }[] }[] = [];

  const MAX_MULLIGANS = 100;
  for (let p = 0; p < 2; p++) {
    const player = players[p as 0 | 1];
    // A deck with zero Basic Pokémon anywhere in it (malformed deck list, whether from a client
    // bug or a direct API call) can never satisfy hasBasicInHand no matter how many times it's
    // reshuffled — without this cap that's an unconditional infinite loop, hanging whatever
    // request triggered it forever.
    while (!hasBasicInHand(player)) {
      mulliganCounts[p]++;
      if (mulliganCounts[p] > MAX_MULLIGANS) {
        throw new Error(`Deck for player ${p} has no Basic Pokémon — cannot complete setup`);
      }
      mulliganReveals.push({
        player: p as 0 | 1,
        cards: player.hand.map(c => ({ name: c.cardData.name, image: c.cardData.images?.small ?? '' })),
      });
      player.deck.push(...player.hand);
      player.hand = [];
      player.deck = shuffle(player.deck, seed + p + mulliganCounts[p]);
      drawCards(player, 7);
      addSetupLog(turnLog, p as 0 | 1, 'mulligan', `No Basic Pokémon in hand — reshuffled and drew a new hand of 7`);
    }
  }

  const pendingMulliganBonuses: { player: 0 | 1; max: number }[] = [];
  for (let p = 0; p < 2; p++) {
    const opponentIdx = (1 - p) as 0 | 1;
    if (mulliganCounts[p] === 0) continue;
    if (interactive.has(opponentIdx)) {
      // Real rules: the compensation draw is OPTIONAL (0..max). Defer the interactive player's
      // decision to a PendingChoice raised by chooseActive — auto-drawing here took the choice
      // away. Non-interactive sides below keep the auto-max behavior (what the reference AI
      // did in all 220 audited games).
      pendingMulliganBonuses.push({ player: opponentIdx, max: mulliganCounts[p] });
      addSetupLog(turnLog, opponentIdx, 'mulligan_reveal', `對手起手無基礎寶可夢，重抽懲罰 ${mulliganCounts[p]} 次 → 你可選擇多抽 ${mulliganCounts[p]} 張`);
      continue;
    }
    for (let m = 0; m < mulliganCounts[p]; m++) {
      const card = players[opponentIdx].deck.pop();
      if (card) players[opponentIdx].hand.push(card);
    }
    addSetupLog(turnLog, opponentIdx, 'mulligan_bonus_draw', `選擇補抽 ${mulliganCounts[p]} 張（對手重抽懲罰補償）`);
  }

  for (let p = 0; p < 2; p++) {
    if (interactive.has(p as 0 | 1)) continue;
    placeBasics(players[p as 0 | 1]);
  }

  for (let p = 0; p < 2; p++) {
    setupPrizes(players[p as 0 | 1], 6);
  }

  // Real rules: a coin flip decides who CHOOSES to go first or second (the winner picks —
  // going first is not automatic). Seeded so battleRunner simulations stay reproducible.
  const coinWinner = (seededRandom(seed + 7919)() < 0.5 ? 0 : 1) as 0 | 1;
  const seatName = (p: 0 | 1) =>
    interactive.size === 2 ? `玩家 ${p + 1}`
    : interactive.size === 1 ? (interactive.has(p) ? '你' : 'AI 對手')
    : `玩家 ${p}`;
  addSetupLog(turnLog, coinWinner, 'coin_flip', `擲硬幣：${seatName(coinWinner)} 獲勝`);

  const interactiveWonFlip = interactive.has(coinWinner);
  // A non-interactive flip winner (AI opponent, or either side of a headless simulation)
  // decides immediately, and always takes first — the near-universal real-play choice.
  const firstPlayer = interactiveWonFlip ? undefined : coinWinner;
  if (!interactiveWonFlip) addSetupLog(turnLog, coinWinner, 'choose_first', '選擇先攻');

  return {
    players,
    turn: 1,
    // Interactive setups keep the interactive player as currentPlayer through the
    // choose_first/choose_active phases (getLegalMoves gates on currentPlayer); the decided
    // firstPlayer takes over in moves.chooseActive. Headless games start with the flip winner.
    // choose_first's actor is the flip winner; otherwise the (single) interactive seat picks
    // its Active; headless games start with the flip winner immediately.
    currentPlayer: interactiveWonFlip ? coinWinner : (interactive.size > 0 ? [...interactive][0] : coinWinner),
    phase: interactiveWonFlip ? 'choose_first' : (interactive.size > 0 ? 'choose_active' : 'draw'),
    coinWinner,
    firstPlayer,
    interactivePlayers: [...interactive].sort(),
    pendingMulliganBonuses,
    mulliganReveals,
    winner: null,
    winReason: null,
    turnLog,
    pendingChoice: null,
    activeStadium: null,
  };
}
