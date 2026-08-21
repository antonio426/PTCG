import { describe, it, expect } from 'vitest';
import { PtcgGame, checkGameOver } from '../src/game/PtcgGame';
import { basicOnlyDeckIds, testCardData, makeGameCard, BASIC_MON } from './fixtures';
import type { PtcgGameState } from '../src/game/GameState';

/**
 * The boardgame.io game object is the fourth driver of the shared engine (see CLAUDE.md), and the
 * only one no client talks to — it exists for online multiplayer later. That makes it the one most
 * likely to rot unnoticed: nothing renders it, and until now nothing tested it either, so its own
 * wiring (the ctx.events shim, the phase endIf/onEnd, the top-level endIf guards) could break
 * without a single failure anywhere.
 */
const setupState = (): PtcgGameState =>
  (PtcgGame.setup as any)(undefined, { decks: [basicOnlyDeckIds(), basicOnlyDeckIds()], cardData: testCardData(), seed: 4242 });

describe('the boardgame.io game object', () => {
  it('builds a playable state through its own setup entry point', () => {
    const G = setupState();
    expect(G.players).toHaveLength(2);
    expect(G.players[0].prizes).toHaveLength(6);
    expect(G.players[0].deck.length + G.players[0].hand.length).toBeGreaterThan(40);
  });

  it('copies boardgame.io 0.50 events onto ctx, or every endTurn from a shared move no-ops', () => {
    // The shim is the reason this engine works at all: the shared moves call ctx.events.endTurn(),
    // which 0.50 passes as a sibling of ctx rather than inside it.
    const G = setupState();
    G.phase = 'main';
    let ended = false;
    (PtcgGame.moves as any).endTurn({ G, ctx: { currentPlayer: '0' }, events: { endTurn: () => { ended = true; } } });
    expect(ended).toBe(true);
    expect(G.phase).toBe('end');
  });

  it('runs its turn-begin through the shared lifecycle', () => {
    const G = setupState();
    G.turn = 1;
    G.currentPlayer = 0;
    const before = G.players[0].hand.length;
    const onBegin = (PtcgGame.phases as any).play.turn.onBegin;
    onBegin({ G, ctx: { currentPlayer: '0' } });
    // Turn-begin sets the draw phase and resets the per-turn counters — the drift this engine
    // shared with the other three for months was getting exactly this wrong.
    expect(G.phase).toBe('draw');
    expect(G.players[0].energyAttachedThisTurn).toBe(0);
    expect(G.players[0].hand.length).toBe(before);
  });

  it('never ends the game during the opening choices, and honours prizes afterwards', () => {
    const G = setupState();
    G.phase = 'choose_active';
    G.players[0].active = null;
    G.players[0].bench = [null, null, null, null, null];
    // Without the phase guard, boardgame.io ended every interactive match before its first move.
    expect(checkGameOver({ G })).toBeUndefined();

    G.phase = 'main';
    G.players[0].active = makeGameCard(BASIC_MON, 0);
    G.players[0].takenPrizes = 6;
    expect(checkGameOver({ G })).toBe(0);
  });
});
