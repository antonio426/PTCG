import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useGameStore } from '../src/stores/gameStore';

/**
 * The server keeps a battle session for two hours and serves its whole state from
 * GET /api/human-battle/:id — but the client only ever held the id in memory, so a reload or a
 * stray Back button abandoned a game that was still sitting there. These specs cover the
 * round trip and, just as importantly, the giving-up path: a stale id must drop itself and let
 * the player back into the lobby rather than wedging the battle page.
 */

const KEY = 'ptcg-battle-session';

const playingState = (winner: number | null = null) => ({
  player: { hand: [], active: null, bench: [], prizes: 6, discardPile: [], deckCount: 50 },
  opponent: { active: null, bench: [], handCount: 7, prizes: 6, discardCount: 0, discardPile: [], deckCount: 50 },
  turn: 4, isPlayerTurn: true, phase: 'main', legalMoves: [], turnLog: [],
  winner, winReason: null, pendingChoice: null, activeStadium: null, canUndo: false,
  viewerIndex: 0 as const, mode: 'ai' as const, mulliganReveals: [],
});

const reset = () => {
  localStorage.clear();
  useGameStore.setState({ sessionId: null, battleState: null, battlePhase: 'select', error: null, loading: false });
};

beforeEach(reset);
afterEach(() => { vi.restoreAllMocks(); });

describe('resumeBattle', () => {
  it('does nothing at all when this browser was never in a battle', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await useGameStore.getState().resumeBattle()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useGameStore.getState().battlePhase).toBe('select');
  });

  it('re-attaches to the stored battle', async () => {
    localStorage.setItem(KEY, 'sess-1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ sessionId: 'sess-1', state: playingState() }),
    } as Response);

    expect(await useGameStore.getState().resumeBattle()).toBe(true);
    const s = useGameStore.getState();
    expect(s.sessionId).toBe('sess-1');
    expect(s.battlePhase).toBe('playing');
    expect(s.battleState?.turn).toBe(4);
  });

  it('drops a session the server no longer has, and stays out of the way', async () => {
    localStorage.setItem(KEY, 'gone');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => ({}) } as Response);

    expect(await useGameStore.getState().resumeBattle()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(useGameStore.getState().battlePhase).toBe('select');
    expect(useGameStore.getState().error).toBeNull();
  });

  it('does not resume a game that already has a winner', async () => {
    localStorage.setItem(KEY, 'done');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ sessionId: 'done', state: playingState(0) }),
    } as Response);

    expect(await useGameStore.getState().resumeBattle()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(useGameStore.getState().battlePhase).toBe('select');
  });

  it('keeps the id through a network blip so the next try can still reconnect', async () => {
    localStorage.setItem(KEY, 'sess-2');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    expect(await useGameStore.getState().resumeBattle()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('sess-2');
  });
});

describe('the stored id follows the battle it belongs to', () => {
  it('createBattle stores it, leaveGame clears it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ sessionId: 'new-1', state: playingState() }),
    } as Response);

    await useGameStore.getState().createBattle(['a']);
    expect(localStorage.getItem(KEY)).toBe('new-1');

    useGameStore.getState().leaveGame();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a move that ends the game clears it', async () => {
    useGameStore.setState({ sessionId: 's', battleState: playingState() as never, battlePhase: 'playing' });
    localStorage.setItem(KEY, 's');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ state: playingState(0) }),
    } as Response);

    await useGameStore.getState().submitMove('end_turn');
    expect(useGameStore.getState().battlePhase).toBe('ended');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
