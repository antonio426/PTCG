import Router from '@koa/router';
import { randomUUID } from 'crypto';
import { Card, LegalAction, TurnAction, GameActionType } from '@ptcg/shared';
import type { PtcgGameState, PendingChoice } from '../game/GameState';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { moves } from '../game/moves';
import { processBetweenTurns, processWakeUpCheck } from '../game/statusConditions';
import { fetchCardsByIds } from '../card-api/tcgdex';
import { MockAI, IAIPlayer } from '../ai/aiPlayer';

/* ------------------------------------------------------- */
/*  Types                                                  */
/* ------------------------------------------------------- */

interface SanitizedGameCard {
  id: string;
  cardData: Card;
  damage: number;
  statusConditions: string[];
  attachedEnergy: { id: string; type: string }[];
}

interface SanitizedPlayerState {
  hand: Card[];
  active: SanitizedGameCard | null;
  bench: (SanitizedGameCard | null)[];
  prizes: number;
  discardPile: SanitizedGameCard[];
  deckCount: number;
}

interface BattleStateResponse {
  player: SanitizedPlayerState;
  opponent: {
    active: SanitizedGameCard | null;
    bench: (SanitizedGameCard | null)[];
    handCount: number;
    prizes: number;
    discardCount: number;
    deckCount: number;
  };
  turn: number;
  isPlayerTurn: boolean;
  phase: string;
  legalMoves: LegalAction[];
  turnLog: TurnAction[];
  winner: number | null;
  winReason: string | null;
  /** Set while a multi-step trainer/ability effect (e.g. Ultra Ball) is awaiting the player's answer. */
  pendingChoice: PendingChoice | null;
}

interface BattleSession {
  id: string;
  gameState: PtcgGameState;
  playerDeck: string[];
  aiDeck: string[];
  aiPlayer: IAIPlayer;
  createdAt: number;
}

/* ------------------------------------------------------- */
/*  Helpers                                                */
/* ------------------------------------------------------- */

const sessions = new Map<string, BattleSession>();

function sanitizeCard(gc: PtcgGameState['players'][0]['active']): SanitizedGameCard | null {
  if (!gc) return null;
  return {
    id: gc.id,
    cardData: gc.cardData,
    damage: gc.damage,
    statusConditions: gc.statusConditions,
    attachedEnergy: gc.attachedEnergy,
  };
}

function buildResponse(session: BattleSession): BattleStateResponse {
  const G = session.gameState;
  const player = G.players[0];
  const opponent = G.players[1];

  return {
    player: {
      // Override the catalog id with the game-instance id (e.g. "SV6-016_2") — legalMoves'
      // payload.cardId always refers to the instance, so the client's hand-to-move matching
      // (groupMovesByHandCard) needs the same id here, not the shared catalog id.
      hand: player.hand.map(c => ({ ...c.cardData, id: c.id })),
      active: sanitizeCard(player.active),
      bench: player.bench.map(c => sanitizeCard(c)),
      prizes: player.prizes.length,
      discardPile: player.discardPile.map(c => sanitizeCard(c)).filter(Boolean) as SanitizedGameCard[],
      deckCount: player.deck.length,
    },
    opponent: {
      active: sanitizeCard(opponent.active),
      bench: opponent.bench.map(c => sanitizeCard(c)),
      handCount: opponent.hand.length,
      prizes: opponent.prizes.length,
      discardCount: opponent.discardPile.length,
      deckCount: opponent.deck.length,
    },
    turn: G.turn,
    isPlayerTurn: G.currentPlayer === 0,
    phase: G.phase,
    legalMoves: getLegalMoves(G, 0),
    turnLog: G.turnLog,
    winner: G.winner,
    winReason: G.winReason,
    pendingChoice: G.pendingChoice && G.pendingChoice.player === 0 ? G.pendingChoice : null,
  };
}

function checkAndApplyWin(G: PtcgGameState): boolean {
  if (G.winner !== null) return true;
  for (let p = 0; p < 2; p++) {
    const pState = G.players[p as 0 | 1];
    const opponent = G.players[(1 - p) as 0 | 1];
    if (pState.takenPrizes >= 6) {
      G.winner = p as 0 | 1;
      G.winReason = 'took all prizes';
      return true;
    }
    if (!opponent.active && opponent.bench.every(s => s === null)) {
      G.winner = p as 0 | 1;
      G.winReason = 'opponent has no pokemon';
      return true;
    }
  }
  const cur = G.players[G.currentPlayer];
  if (cur.deck.length === 0 && G.phase === 'draw') {
    G.winner = (1 - G.currentPlayer) as 0 | 1;
    G.winReason = 'deck empty at draw';
    return true;
  }
  return false;
}

function applyTurnBegin(G: PtcgGameState): void {
  if (G.turn > 1) processBetweenTurns(G);
  G.phase = G.turn === 1 ? 'main' : 'draw';
  processWakeUpCheck(G, G.currentPlayer as 0 | 1);
  const player = G.players[G.currentPlayer];
  player.energyAttachedThisTurn = 0;
  player.basicPokemonPlayedThisTurn = 0;
  player.supporterPlayedThisTurn = false;
  player.pokemonPlayedThisTurn = [];
  player.cardsPlayedThisTurn = 0;
  player.abilitiesUsedThisTurn = [];
  player.usedBonusAttackThisTurn = false;
  player.turnDamageBoosts = [];
  player.bonusPrizeNextKo = false;
  player.incomingDamageReduction = [];
}

function executeGameAction(G: PtcgGameState, action: { type: string; payload?: Record<string, any> }): void {
  const ctx: any = {
    currentPlayer: String(G.currentPlayer),
    turn: G.turn,
    events: { endTurn: () => { G.phase = 'end'; } },
  };
  const p = action.payload || {};
  switch (action.type) {
    case 'draw_card': moves.drawCard({ G, ctx }); break;
    case 'play_pokemon': moves.playPokemon({ G, ctx }, p.cardId as string, p.benchPosition as number); break;
    case 'evolve_pokemon': moves.evolvePokemon({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'attach_energy': moves.attachEnergy({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'play_trainer': moves.playTrainer({ G, ctx }, p.cardId as string); break;
    case 'use_ability': moves.useAbility({ G, ctx }, p.cardId as string); break;
    case 'resolve_choice': moves.resolveChoice({ G, ctx }, p.selection as string[]); break;
    case 'retreat': moves.retreat({ G, ctx }, p.targetBenchPosition as number, p.discardEnergyIds as string[]); break;
    case 'attack': moves.attack({ G, ctx }, p.attackIndex as number); break;
    case 'end_turn': moves.endTurn({ G, ctx }); break;
    case 'forfeit': moves.forfeit({ G, ctx }); break;
  }
}

/** Run AI turns until it's the human's turn again or game ends */
async function runAiTurns(session: BattleSession): Promise<void> {
  const G = session.gameState;
  while (G.winner === null && G.currentPlayer === 1) {
    const ai = session.aiPlayer;
    const legalMoves = getLegalMoves(G, 1);
    if (legalMoves.length === 0) {
      G.winner = 0;
      G.winReason = 'no legal moves';
      break;
    }
    const { action } = await ai.decide(G, 1, legalMoves);
    executeGameAction(G, action);
    if (checkAndApplyWin(G)) break;
    if (G.phase === 'end') {
      // Advance turn
      G.currentPlayer = 0;
      G.turn++;
      applyTurnBegin(G);
      if (checkAndApplyWin(G)) break;
    }
  }
}

/* ------------------------------------------------------- */
/*  Routes                                                 */
/* ------------------------------------------------------- */

const router = new Router();

/** Create a new human-vs-AI battle */
router.post('/', async (ctx) => {
  try {
    const { deckA, deckB } = ctx.request.body as { deckA: string[]; deckB?: string[] };
    if (!deckA || !Array.isArray(deckA) || deckA.length === 0) {
      ctx.status = 400;
      ctx.body = { error: 'deckA required (array of card IDs)' };
      return;
    }
    const opponentDeck = deckB || [...deckA].sort(() => Math.random() - 0.5);
    const allIds = [...new Set([...deckA, ...opponentDeck])];
    const cardDataRaw = await fetchCardsByIds(allIds);
    const cardData = cardDataRaw as unknown as Record<string, Card>;
    const G = setup({ decks: [deckA, opponentDeck], cardData, seed: Date.now() });
    const session: BattleSession = {
      id: randomUUID(),
      gameState: G,
      playerDeck: deckA,
      aiDeck: opponentDeck,
      aiPlayer: new MockAI(),
      createdAt: Date.now(),
    };
    sessions.set(session.id, session);
    // If AI goes first, run AI turns immediately
    if (G.currentPlayer === 1) {
      await runAiTurns(session);
    }
    ctx.body = { sessionId: session.id, state: buildResponse(session) };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: err.message || 'Failed to create battle' };
  }
});

/** Get current battle state */
router.get('/:id', (ctx) => {
  const session = sessions.get(ctx.params.id);
  if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return; }
  ctx.body = { sessionId: session.id, state: buildResponse(session) };
});

/** Submit a move as the human player */
router.post('/:id/move', async (ctx) => {
  try {
    const session = sessions.get(ctx.params.id);
    if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return; }
    const G = session.gameState;
    if (G.winner !== null) {
      ctx.body = { sessionId: session.id, state: buildResponse(session) };
      return;
    }
    if (G.currentPlayer !== 0) {
      ctx.status = 400;
      ctx.body = { error: 'Not your turn', state: buildResponse(session) };
      return;
    }
    const { type, payload } = ctx.request.body as { type: string; payload?: Record<string, any> };
    if (!type) { ctx.status = 400; ctx.body = { error: 'Move type required' }; return; }
    // Validate move is legal
    const legalMoves = getLegalMoves(G, 0);
    const matched = legalMoves.find(m => m.type === type &&
      JSON.stringify(m.payload || {}) === JSON.stringify(payload || {}));
    if (!matched) {
      ctx.status = 400;
      ctx.body = { error: 'Illegal move', legalMoves, state: buildResponse(session) };
      return;
    }
    executeGameAction(G, { type, payload });
    if (checkAndApplyWin(G)) {
      ctx.body = { sessionId: session.id, state: buildResponse(session) };
      return;
    }
    // If turn ended, advance to next turn (AI's turn)
    if (G.phase === 'end') {
      G.currentPlayer = 1;
      G.turn++;
      applyTurnBegin(G);
      if (checkAndApplyWin(G)) {
        ctx.body = { sessionId: session.id, state: buildResponse(session) };
        return;
      }
      // Run AI turns
      await runAiTurns(session);
    }
    ctx.body = { sessionId: session.id, state: buildResponse(session) };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: err.message || 'Move execution failed' };
  }
});

export { router as humanBattleRoutes };
