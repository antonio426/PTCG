import { create } from 'zustand';
import type { Card, LegalAction, TurnAction, PendingChoice } from '@ptcg/shared';

/* ------------------------------------------------------- */
/*  Types mirroring server response                        */
/* ------------------------------------------------------- */

export interface SanitizedGameCard {
  id: string;
  cardData: Card;
  damage: number;
  statusConditions: string[];
  attachedEnergy: { id: string; type: string }[];
  attachedTool: { id: string; cardData: Card } | null;
  /** Max HP after every in-play modifier the server applies (Pokémon Tools like 英雄斗篷's +100,
   * passive max-HP abilities) — NOT the printed `cardData.hp`. Always render HP from this: the
   * server decides KOs against it, so showing printed HP instead makes a boosted Pokémon appear
   * to sit at 0 HP without fainting, which reads as the boost having done nothing. */
  maxHp: number;
}

export interface BattlePlayerState {
  hand: Card[];
  active: SanitizedGameCard | null;
  bench: (SanitizedGameCard | null)[];
  prizes: number;
  discardPile: SanitizedGameCard[];
  deckCount: number;
}

export interface BattleOpponentState {
  active: SanitizedGameCard | null;
  bench: (SanitizedGameCard | null)[];
  handCount: number;
  prizes: number;
  discardCount: number;
  discardPile: SanitizedGameCard[];
  deckCount: number;
}

export interface BattleState {
  player: BattlePlayerState;
  opponent: BattleOpponentState;
  turn: number;
  isPlayerTurn: boolean;
  phase: string;
  legalMoves: LegalAction[];
  turnLog: TurnAction[];
  winner: number | null;
  winReason: string | null;
  pendingChoice: PendingChoice | null;
  activeStadium: { id: string; cardData: Card } | null;
  /** Whether the server holds an undo snapshot (悔棋 button enablement). */
  canUndo: boolean;
  /** Which seat this state was built for (vs-AI: 0; local 2P: the seat that must act). */
  viewerIndex: 0 | 1;
  mode: 'ai' | 'local';
}

export type BattlePhase = 'select' | 'playing' | 'ended';

/* ------------------------------------------------------- */
/*  Store                                                  */
/* ------------------------------------------------------- */

interface GameState {
  sessionId: string | null;
  battleState: BattleState | null;
  loading: boolean;
  error: string | null;
  battlePhase: BattlePhase;

  matchResult: { wins: number; losses: number; total: number };
  playerName: string;

  createBattle: (deckA: string[], deckB?: string[], difficulty?: 'easy' | 'normal' | 'hard', mode?: 'ai' | 'local') => Promise<string>;
  submitMove: (type: string, payload?: Record<string, unknown>) => Promise<void>;
  undo: () => Promise<void>;
  refreshState: () => Promise<void>;
  leaveGame: () => void;
  setPlayerName: (name: string) => void;
  updateMatchResult: (result: Partial<{ wins: number; losses: number; total: number }>) => void;
}

const BASE = '/api/human-battle';

export const useGameStore = create<GameState>((set, get) => ({
  sessionId: null,
  battleState: null,
  loading: false,
  error: null,
  battlePhase: 'select',
  matchResult: { wins: 0, losses: 0, total: 0 },
  playerName: 'Player',

  createBattle: async (deckA: string[], deckB?: string[], difficulty?: 'easy' | 'normal' | 'hard', mode?: 'ai' | 'local') => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckA, deckB, difficulty, mode }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create battle');
      }
      const data = await res.json();
      set({
        sessionId: data.sessionId,
        battleState: data.state,
        battlePhase: 'playing',
        loading: false,
      });
      return data.sessionId;
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      throw err;
    }
  },

  undo: async () => {
    const { sessionId, battleState } = get();
    if (!sessionId || !battleState || battleState.winner !== null || !battleState.canUndo) return;
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${BASE}/${sessionId}/undo`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Undo failed');
      set({ battleState: data.state, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  },

  submitMove: async (type: string, payload?: Record<string, unknown>) => {
    const { sessionId, battleState } = get();
    if (!sessionId || !battleState) return;
    if (battleState.winner !== null) return;

    set({ loading: true, error: null });
    try {
      const res = await fetch(`${BASE}/${sessionId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.state) {
          set({ battleState: errData.state, loading: false });
        }
        throw new Error(errData.error || 'Move rejected');
      }
      const data = await res.json();
      set({ battleState: data.state, loading: false });

      if (data.state.winner !== null) {
        set((s) => ({
          battlePhase: 'ended',
          matchResult: {
            wins: s.matchResult.wins + (data.state.winner === 0 ? 1 : 0),
            losses: s.matchResult.losses + (data.state.winner === 1 ? 1 : 0),
            total: s.matchResult.total + 1,
          },
        }));
      }
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Move failed',
      });
    }
  },

  refreshState: async () => {
    const { sessionId } = get();
    if (!sessionId) return;
    try {
      const res = await fetch(`${BASE}/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      set({ battleState: data.state });
    } catch {
      // ignore
    }
  },

  leaveGame: () => {
    set({
      sessionId: null,
      battleState: null,
      battlePhase: 'select',
      error: null,
      loading: false,
    });
  },

  setPlayerName: (name: string) => {
    set({ playerName: name });
  },

  updateMatchResult: (result: Partial<{ wins: number; losses: number; total: number }>) => {
    set((state) => ({
      matchResult: { ...state.matchResult, ...result },
    }));
  },
}));
