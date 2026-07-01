import { create } from 'zustand';
import type { Card } from '@ptcg/shared';

interface MatchResult {
  wins: number;
  losses: number;
  total: number;
}

interface GameState {
  gameId: string | null;
  playerName: string;
  matchResult: MatchResult;
  createAIBattle: (deckA: string[], deckB: string[]) => Promise<string>;
  joinBattle: (gameId: string) => void;
  updateMatchResult: (result: Partial<MatchResult>) => void;
  setPlayerName: (name: string) => void;
  leaveGame: () => void;
}

export const useGameStore = create<GameState>((set) => ({
  gameId: null,
  playerName: 'Player',
  matchResult: { wins: 0, losses: 0, total: 0 },

  createAIBattle: async (deckA: string[], deckB: string[]) => {
    const res = await fetch('/api/games/ai-battle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckA, deckB }),
    });

    if (!res.ok) {
      throw new Error('Failed to create AI battle');
    }

    const data = await res.json();
    set({ gameId: data.gameId });
    return data.gameId;
  },

  joinBattle: (gameId: string) => {
    set({ gameId });
  },

  updateMatchResult: (result: Partial<MatchResult>) => {
    set((state) => ({
      matchResult: { ...state.matchResult, ...result },
    }));
  },

  setPlayerName: (name: string) => {
    set({ playerName: name });
  },

  leaveGame: () => {
    set({ gameId: null });
  },
}));
