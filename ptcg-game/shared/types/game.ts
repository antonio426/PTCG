import { Card } from './card';

export interface GameCard {
  id: string;
  cardData: Card;
  owner: 0 | 1;
  damage: number;
  statusConditions: StatusCondition[];
  attachedEnergy: AttachedEnergy[];
  turnedFacedown?: boolean;
}

export interface AttachedEnergy {
  id: string;
  type: string;
}

export type StatusCondition = 'Asleep' | 'Burned' | 'Confused' | 'Paralyzed' | 'Poisoned';

export interface BenchSlot {
  card: GameCard | null;
}

export interface PlayerState {
  deck: GameCard[];
  hand: GameCard[];
  bench: [BenchSlot, BenchSlot, BenchSlot, BenchSlot, BenchSlot];
  active: GameCard | null;
  discardPile: GameCard[];
  prizes: GameCard[];
  takenPrizes: number;
  energyAttachedThisTurn: number;
  cardsPlayedThisTurn: number;
}

export interface GameState {
  players: [PlayerState, PlayerState];
  turn: number;
  currentPlayer: 0 | 1;
  phase: GamePhase;
  turnStage: TurnStage;
  winner: 0 | 1 | null;
  winReason: string | null;
  turnHistory: TurnAction[];
}

export type GamePhase = 'setup' | 'play' | 'attack' | 'end';

export type TurnStage = 'draw_phase' | 'main_phase' | 'attack_phase' | 'end_phase';

export interface TurnAction {
  player: 0 | 1;
  turn: number;
  action: string;
  details: string;
  timestamp: number;
}

export interface DeckValidation {
  valid: boolean;
  errors: string[];
  cardCount: number;
}
