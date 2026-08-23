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

/**
 * 「由對手選擇」 effects: the seat that must answer is `pendingChoice.player`, which is often not
 * the turn player. The other three engines re-read the actor from it every iteration. This one
 * could not: boardgame.io only accepts moves from its own currentPlayer unless stages say
 * otherwise, and the play phase declared none — so the seat that had to answer was the one seat
 * that couldn't, and the attacker could answer their opponent's choice unchallenged.
 */
describe('a choice that belongs to the other seat', () => {
  const pendingFor = (G: PtcgGameState, seat: 0 | 1) => {
    G.pendingChoice = {
      player: seat, owner: seat, effectKey: 'attack_pick', prompt: '對手選擇',
      choiceType: 'select_from_list', count: 1,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      context: { kind: 'opponent_switch' },
    } as PtcgGameState['pendingChoice'];
  };

  /** Records what the turn's onMove asks boardgame.io to do. */
  function activeAfterMove(G: PtcgGameState) {
    let asked: any = null;
    const onMove = (PtcgGame.phases as any).play.turn.onMove;
    onMove({ G, events: { setActivePlayers: (v: any) => { asked = v; } } });
    return asked;
  }

  it('hands the move right to the seat that owes the answer', () => {
    const G = setupState();
    G.currentPlayer = 0;
    pendingFor(G, 1);
    expect(activeAfterMove(G)).toEqual({ value: { '1': 'answering' } });
  });

  it('gives it back to the turn player once the choice is gone', () => {
    const G = setupState();
    G.currentPlayer = 0;
    G.pendingChoice = null;
    expect(activeAfterMove(G)).toEqual({ currentPlayer: 'play' });
  });

  it('leaves the turn player in charge of their own choices', () => {
    const G = setupState();
    G.currentPlayer = 0;
    pendingFor(G, 0);
    expect(activeAfterMove(G)).toEqual({ currentPlayer: 'play' });
  });

  it('the answering stage exposes resolveChoice and nothing else', () => {
    const stages = (PtcgGame.phases as any).play.turn.stages;
    expect(Object.keys(stages.answering.moves)).toEqual(['resolveChoice']);
  });

  it('passes playerID through to the shared move, so the seat check can fire', () => {
    const G = setupState();
    G.currentPlayer = 0;
    pendingFor(G, 1);
    // The attacker tries to answer the defender's choice: rejected, choice still standing.
    (PtcgGame.moves as any).resolveChoice({ G, ctx: { currentPlayer: '0' }, playerID: '0' }, ['a']);
    expect(G.pendingChoice).not.toBeNull();
    // The defender answers: accepted.
    (PtcgGame.moves as any).resolveChoice({ G, ctx: { currentPlayer: '0' }, playerID: '1' }, ['a']);
    expect(G.pendingChoice).toBeNull();
  });
});
