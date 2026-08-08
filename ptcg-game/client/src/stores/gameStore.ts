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

  createBattle: (deckA: string[], deckB?: string[]) => Promise<string>;
  submitMove: (type: string, payload?: Record<string, unknown>) => Promise<void>;
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

  createBattle: async (deckA: string[], deckB?: string[]) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deckA, deckB }),
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
