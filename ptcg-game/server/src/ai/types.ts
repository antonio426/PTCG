import { LegalAction, TurnAction } from '@ptcg/shared';
import type { PtcgGameState } from '../game/GameState';

export interface AIThought {
  turn: number;
  player: number;
  thought: string;
  action: LegalAction;
  timestamp: number;
}

export interface AIConfig {
  model: 'random' | 'claude' | 'mock';
  apiKey?: string;
  apiUrl?: string;
  temperature?: number;
  showThought?: boolean;
}

export interface AIPlayerResult {
  gameId: string;
  winner: number | null;
  turns: number;
  thoughts: AIThought[];
  logs: TurnAction[];
}
