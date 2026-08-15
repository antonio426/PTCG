import Router from '@koa/router';
import { randomUUID } from 'crypto';
import { Card, LegalAction, TurnAction, GameActionType } from '@ptcg/shared';
import type { PtcgGameState, PendingChoice } from '../game/GameState';
import type { GameCard } from '@ptcg/shared';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { moves } from '../game/moves';
import { processBetweenTurns, processWakeUpCheck } from '../game/statusConditions';
import { promoteActiveIfNeeded, effectiveMaxHp } from '../game/damage';
import { fetchCardsByIds } from '../card-api/tcgdex';
import { RandomAI, ClaudeAI, IAIPlayer } from '../ai/aiPlayer';
import { HeuristicAI } from '../ai/heuristicAI';

export type Difficulty = 'easy' | 'normal' | 'hard';

/** easy = RandomAI, hard = ClaudeAI (only if a real API key is configured — never silently
 * downgraded to something else, since that would surprise a player expecting to face Claude),
 * anything else (including 'normal'/unspecified) = HeuristicAI, the new default. */
export function resolveAiPlayer(difficulty?: string): { ai: IAIPlayer } | { error: string } {
  if (difficulty === 'easy') return { ai: new RandomAI() };
  if (difficulty === 'hard') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { error: 'Hard mode (Claude) is not configured on this server — no ANTHROPIC_API_KEY set.' };
    return { ai: new ClaudeAI({ apiKey, model: process.env.ANTHROPIC_MODEL }) };
  }
  return { ai: new HeuristicAI() };
}

/* ------------------------------------------------------- */
/*  Types                                                  */
/* ------------------------------------------------------- */

/** Mirrored by `SanitizedGameCard` in client/src/stores/gameStore.ts — keep the two in sync. */
interface SanitizedGameCard {
  id: string;
  cardData: Card;
  damage: number;
  statusConditions: string[];
  attachedEnergy: { id: string; type: string }[];
  attachedTool: { id: string; cardData: Card } | null;
  /** Effective max HP including Tool/passive-ability bonuses — see sanitizeCard's comment. */
  maxHp: number;
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
    // Discard piles are public information in the real rules — either player may look through
    // either pile at any time — so unlike `hand`, sending the actual cards isn't an info leak.
    discardPile: SanitizedGameCard[];
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
  /** Shared, board-wide — only one Stadium may be in play at a time and it affects both sides. */
  activeStadium: { id: string; cardData: Card } | null;
  /** Whether an undo snapshot exists (悔棋 button enablement). */
  canUndo: boolean;
  /** Which seat this response is built for (vs-AI: always 0; local 2P: the seat that must act).
   * The client swaps its "you/opponent" panels and gates the hand on this. */
  viewerIndex: 0 | 1;
  mode: 'ai' | 'local';
  /** Setup-time mulligan hand reveals (public info under real rules) — client shows them once. */
  mulliganReveals: { player: 0 | 1; cards: { name: string; image: string }[] }[];
}

interface BattleSession {
  id: string;
  gameState: PtcgGameState;
  playerDeck: string[];
  aiDeck: string[];
  /** null = local 2P hotseat (both seats human, no AI turns ever run). */
  aiPlayer: IAIPlayer | null;
  createdAt: number;
  /** Pre-move snapshots for undo — one entry per HUMAN move, capped. Undoing pops back to the
   * state before the player's last action, which in a vs-AI game also rewinds any AI turns
   * that followed it (the only sensible undo semantics against an AI). */
  history: PtcgGameState[];
}

const MAX_UNDO_HISTORY = 20;

/* ------------------------------------------------------- */
/*  Helpers                                                */
/* ------------------------------------------------------- */

const sessions = new Map<string, BattleSession>();

// Sessions are never removed on their own (no "leave"/"end" signal from the client — leaving
// the page just resets local state) — without this sweep, every battle ever created stays in
// memory for the server's entire lifetime. Stale ones (long-idle or long-finished) are swept
// periodically rather than deleted the moment a game ends, so a client that re-fetches a
// just-finished game's state still gets it. Also hard-capped by count (MAX_SESSIONS): the
// time-based sweep alone wasn't enough — a sibling map in battles.ts, with the same
// time-only cleanup, was the direct cause of a real "JavaScript heap out of memory" crash
// after a long dev session of repeated testing well within the 2-hour TTL window.
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const SESSION_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 50;
setInterval(() => {
  try {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(id);
    }
  } catch (err) {
    // A timer callback runs outside any request's try/catch — an exception here would
    // otherwise be a genuinely uncaught exception and crash the whole server process.
    console.error('[humanBattle] session sweep failed:', err);
  }
}, SESSION_SWEEP_INTERVAL_MS).unref();

/** Finds a real card by instance id across every zone visible to `viewerIdx` — their own hand/
 * deck/discard/active/bench, plus the opponent's PUBLIC zones only (active/bench/discard; never
 * their hand or deck, which stay hidden). Used to enrich pendingChoice options with real card art
 * for the client — an option whose id doesn't resolve to anything here (e.g. an energy instance
 * already attached to a Pokémon, or an abstract "move N counters" choice) just has no cardData,
 * and the client falls back to a plain text option for it. */
function findCardDataById(G: PtcgGameState, viewerIdx: 0 | 1, id: string): Card | undefined {
  const me = G.players[viewerIdx];
  const opp = G.players[(1 - viewerIdx) as 0 | 1];
  const zones: (GameCard | null | undefined)[] = [
    ...me.hand, ...me.deck, ...me.discardPile, me.active, ...me.bench,
    opp.active, ...opp.bench, ...opp.discardPile,
  ];
  return zones.find((c): c is GameCard => !!c && c.id === id)?.cardData;
}

/** Needs `G` because max HP isn't a property of the card alone — Tools (英雄斗篷 +100) and
 * passive abilities modify it, and only `effectiveMaxHp` knows the full set. The client must not
 * recompute this from `cardData.hp`: the server decides KOs against the effective value, so a
 * client showing printed HP renders a boosted Pokémon as sitting at 0 HP but not fainting. */
function sanitizeCard(G: PtcgGameState, gc: PtcgGameState['players'][0]['active']): SanitizedGameCard | null {
  if (!gc) return null;
  return {
    id: gc.id,
    cardData: gc.cardData,
    damage: gc.damage,
    statusConditions: gc.statusConditions,
    attachedEnergy: gc.attachedEnergy,
    attachedTool: gc.attachedTool ? { id: gc.attachedTool.id, cardData: gc.attachedTool.cardData } : null,
    maxHp: effectiveMaxHp(G, gc),
  };
}

function buildResponse(session: BattleSession): BattleStateResponse {
  const G = session.gameState;
  // vs-AI responses are always seat 0's view. Local 2P builds for whoever must act next —
  // a pending choice's owner outranks currentPlayer (e.g. the opponent resolving a pick).
  const viewer: 0 | 1 = session.aiPlayer ? 0 : ((G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1);
  const player = G.players[viewer];
  const opponent = G.players[(1 - viewer) as 0 | 1];

  return {
    player: {
      // Override the catalog id with the game-instance id (e.g. "SV6-016_2") — legalMoves'
      // payload.cardId always refers to the instance, so the client's hand-to-move matching
      // (groupMovesByHandCard) needs the same id here, not the shared catalog id.
      hand: player.hand.map(c => ({ ...c.cardData, id: c.id })),
      active: sanitizeCard(G, player.active),
      bench: player.bench.map(c => sanitizeCard(G, c)),
      prizes: player.prizes.length,
      discardPile: player.discardPile.map(c => sanitizeCard(G, c)).filter(Boolean) as SanitizedGameCard[],
      deckCount: player.deck.length,
    },
    opponent: {
      active: sanitizeCard(G, opponent.active),
      bench: opponent.bench.map(c => sanitizeCard(G, c)),
      handCount: opponent.hand.length,
      prizes: opponent.prizes.length,
      discardCount: opponent.discardPile.length,
      discardPile: opponent.discardPile.map(c => sanitizeCard(G, c)).filter(Boolean) as SanitizedGameCard[],
      deckCount: opponent.deck.length,
    },
    turn: G.turn,
    isPlayerTurn: G.currentPlayer === viewer,
    phase: G.phase,
    legalMoves: getLegalMoves(G, viewer),
    turnLog: G.turnLog,
    activeStadium: G.activeStadium ? { id: G.activeStadium.id, cardData: G.activeStadium.cardData } : null,
    winner: G.winner,
    winReason: G.winReason,
    canUndo: session.history.length > 0,
    mulliganReveals: G.mulliganReveals ?? [],
    viewerIndex: viewer,
    mode: session.aiPlayer ? 'ai' : 'local',
    pendingChoice: enrichPendingChoice(G, G.pendingChoice && G.pendingChoice.player === viewer ? G.pendingChoice : null),
  };
}

/**
 * Structural (not effectKey-based) detection of "this pendingChoice's options are all drawn from
 * the searching player's own deck" — e.g. Ultra Ball, Strategic Command. Deliberately not a list
 * of hardcoded effectKeys: matching against the actual deck contents stays correct automatically
 * as new deck-search effects get added, and can never misfire on choices whose options are board
 * Pokémon or hand cards (those ids never collide with deck card ids). Callers must already have
 * confirmed `choice.player === 0` (never expose the AI opponent's deck) before calling this.
 */
function isDeckSearchChoice(G: PtcgGameState, choice: PendingChoice): boolean {
  if (!choice.options || choice.options.length === 0) return false;
  const deckIds = new Set(G.players[choice.player].deck.map(c => c.id));
  return choice.options.every(o => deckIds.has(o.id));
}

function enrichPendingChoice(G: PtcgGameState, choice: PendingChoice | null): PendingChoice | null {
  if (!choice?.options) return choice;
  const enriched: PendingChoice = {
    ...choice,
    options: choice.options.map(o => ({ ...o, cardData: findCardDataById(G, choice.player, o.id) })),
  };
  if (isDeckSearchChoice(G, choice)) {
    const optionIds = new Set(choice.options.map(o => o.id));
    enriched.remainingDeckPreview = G.players[choice.player].deck
      .filter(c => !optionIds.has(c.id))
      .map(c => c.cardData);
  }
  return enriched;
}

function checkAndApplyWin(G: PtcgGameState): boolean {
  if (G.winner !== null) return true;
  // During setup phases the human legitimately has no Pokémon in play yet — evaluating the
  // "opponent has no pokemon" condition here declared the AI winner right after the new
  // choose_first move (the pre-coin-flip flow never ran a win check mid-setup, so this was
  // latent). Direct winners (forfeit) are still honored by the G.winner check above.
  if (G.phase === 'choose_first' || G.phase === 'choose_active') return false;
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
  // Before promoteActiveIfNeeded: a KO replacement promoted now also counts as
  // "placed from the Bench this turn".
  G.players[G.currentPlayer].activeIdAtTurnStart = G.players[G.currentPlayer].active?.id;
  // If this player's Active was Knocked Out last turn, they choose their new one now — see
  // promoteActiveIfNeeded's own comment for why this timing is always safe.
  promoteActiveIfNeeded(G, G.currentPlayer as 0 | 1);
  if (G.turn > 1) processBetweenTurns(G);
  // Always 'draw' — see battleRunner.ts's applyTurnBegin for why the first turn draws too.
  // Latent here today (this function is only reached from turn 2 onward, since turn 1 comes in
  // via setup()'s 'choose_active' -> chooseActive's phase='draw'), but kept identical so the two
  // hand-copied turn-lifecycle implementations can't drift apart on the rule.
  G.phase = 'draw';
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
  player.bonusPrizeNextKo = 0;
  player.incomingDamageReduction = [];
  player.retreatedThisTurn = false;
}

function executeGameAction(G: PtcgGameState, action: { type: string; payload?: Record<string, any> }): void {
  const ctx: any = {
    currentPlayer: String(G.currentPlayer),
    turn: G.turn,
    events: { endTurn: () => { G.phase = 'end'; } },
  };
  const p = action.payload || {};
  switch (action.type) {
    case 'choose_first': moves.chooseFirst({ G, ctx }, p.goFirst as boolean); break;
    case 'choose_active': moves.chooseActive({ G, ctx }, p.cardId as string); break;
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
  const ai = session.aiPlayer;
  if (!ai) return; // local 2P hotseat — there is no AI seat
  // Belt-and-suspenders against an AI that keeps re-selecting the same still-legal move without
  // ever advancing G.phase to 'end' (e.g. a validation gap letting a move stay legal after it's
  // already been executed) — without this cap, the loop spins forever, pushing to G.turnLog on
  // every iteration until the process OOMs. Mirrors the moveSafety cap in battles.ts, which never
  // got applied here.
  let aiMoveSafety = 0;
  while (G.winner === null && G.currentPlayer === 1 && aiMoveSafety < 500) {
    aiMoveSafety++;
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
  if (aiMoveSafety >= 500 && G.winner === null) {
    G.winner = 0;
    G.winReason = 'AI turn safety cap exceeded';
  }
}

/* ------------------------------------------------------- */
/*  Routes                                                 */
/* ------------------------------------------------------- */

const router = new Router();

/** Create a new human-vs-AI battle */
router.post('/', async (ctx) => {
  try {
    const { deckA, deckB, difficulty, mode } = ctx.request.body as { deckA: string[]; deckB?: string[]; difficulty?: Difficulty; mode?: 'ai' | 'local' };
    if (!deckA || !Array.isArray(deckA) || deckA.length === 0) {
      ctx.status = 400;
      ctx.body = { error: 'deckA required (array of card IDs)' };
      return;
    }
    const isLocal = mode === 'local';
    if (isLocal && (!deckB || !Array.isArray(deckB) || deckB.length === 0)) {
      ctx.status = 400;
      ctx.body = { error: 'local mode requires deckB (player 2 deck)' };
      return;
    }
    let aiPlayer: IAIPlayer | null = null;
    if (!isLocal) {
      const resolved = resolveAiPlayer(difficulty);
      if ('error' in resolved) {
        ctx.status = 400;
        ctx.body = { error: resolved.error };
        return;
      }
      aiPlayer = resolved.ai;
    }
    const opponentDeck = deckB || [...deckA].sort(() => Math.random() - 0.5);
    const allIds = [...new Set([...deckA, ...opponentDeck])];
    const cardDataRaw = await fetchCardsByIds(allIds);
    const cardData = cardDataRaw as unknown as Record<string, Card>;
    const G = setup(isLocal
      ? { decks: [deckA, opponentDeck], cardData, seed: Date.now(), interactivePlayers: [0, 1] }
      : { decks: [deckA, opponentDeck], cardData, seed: Date.now(), interactivePlayer: 0 });
    const session: BattleSession = {
      id: randomUUID(),
      gameState: G,
      playerDeck: deckA,
      aiDeck: opponentDeck,
      aiPlayer,
      createdAt: Date.now(),
      history: [],
    };
    sessions.set(session.id, session);
    // Map iteration order is insertion order, so the first key is the oldest.
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    // If the AI goes first, run its turns immediately (never in local 2P)
    if (session.aiPlayer && G.currentPlayer === 1) {
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
/** 悔棋: rewind to the state before the player's last move (which, vs an AI, also rewinds
 * any AI turns that followed it). Disabled once the game has a winner. */
router.post('/:id/undo', (ctx) => {
  const session = sessions.get(ctx.params.id);
  if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return; }
  if (session.gameState.winner !== null) {
    ctx.status = 400;
    ctx.body = { error: 'Game is over — nothing to undo', state: buildResponse(session) };
    return;
  }
  const snapshot = session.history.pop();
  if (!snapshot) {
    ctx.status = 400;
    ctx.body = { error: 'Nothing to undo', state: buildResponse(session) };
    return;
  }
  session.gameState = snapshot;
  ctx.body = { sessionId: session.id, state: buildResponse(session) };
});

router.post('/:id/move', async (ctx) => {
  try {
    const session = sessions.get(ctx.params.id);
    if (!session) { ctx.status = 404; ctx.body = { error: 'Session not found' }; return; }
    const G = session.gameState;
    if (G.winner !== null) {
      ctx.body = { sessionId: session.id, state: buildResponse(session) };
      return;
    }
    // vs-AI: only seat 0 may act. Local 2P: whoever the state says must act (hotseat — the
    // device is shared, so there's no cross-seat auth concern).
    const actor: 0 | 1 = session.aiPlayer ? 0 : ((G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1);
    if (session.aiPlayer && G.currentPlayer !== 0) {
      ctx.status = 400;
      ctx.body = { error: 'Not your turn', state: buildResponse(session) };
      return;
    }
    const { type, payload } = ctx.request.body as { type: string; payload?: Record<string, any> };
    if (!type) { ctx.status = 400; ctx.body = { error: 'Move type required' }; return; }
    // Validate move is legal
    const legalMoves = getLegalMoves(G, actor);
    const matched = legalMoves.find(m => m.type === type &&
      JSON.stringify(m.payload || {}) === JSON.stringify(payload || {}));
    if (!matched) {
      ctx.status = 400;
      ctx.body = { error: 'Illegal move', legalMoves, state: buildResponse(session) };
      return;
    }
    // Undo snapshot: taken only after the legality check, so history holds exactly one entry
    // per move that actually executed. structuredClone is safe — PtcgGameState is pure data.
    session.history.push(structuredClone(G));
    if (session.history.length > MAX_UNDO_HISTORY) session.history.shift();
    executeGameAction(G, { type, payload });
    if (checkAndApplyWin(G)) {
      ctx.body = { sessionId: session.id, state: buildResponse(session) };
      return;
    }
    // The coin-flip winner may have given turn 1 to the AI: chooseActive hands over
    // currentPlayer without going through an 'end' phase, so run the AI here too.
    // (Fresh read: the `!== 0` guard above narrowed the type, but executeGameAction mutates it.)
    const playerAfterMove = G.currentPlayer as number;
    if (session.aiPlayer && G.phase !== 'end' && playerAfterMove === 1 && G.winner === null) {
      await runAiTurns(session);
      ctx.body = { sessionId: session.id, state: buildResponse(session) };
      return;
    }
    // If the turn ended, advance to the next turn (the opponent's — AI or the other human)
    if (G.phase === 'end') {
      G.currentPlayer = 1 - G.currentPlayer;
      G.turn++;
      applyTurnBegin(G);
      if (checkAndApplyWin(G)) {
        ctx.body = { sessionId: session.id, state: buildResponse(session) };
        return;
      }
      if (session.aiPlayer) await runAiTurns(session);
    }
    ctx.body = { sessionId: session.id, state: buildResponse(session) };
  } catch (err: any) {
    ctx.status = 500;
    ctx.body = { error: err.message || 'Move execution failed' };
  }
});

export { router as humanBattleRoutes };
