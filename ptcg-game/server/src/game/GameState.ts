import { GameCard, TurnAction, PendingChoice } from '@ptcg/shared';

export type { PendingChoice };

export interface PtcgPlayerState {
  deck: GameCard[];
  hand: GameCard[];
  bench: (GameCard | null)[];
  active: GameCard | null;
  discardPile: GameCard[];
  prizes: GameCard[];
  takenPrizes: number;
  energyAttachedThisTurn: number;
  basicPokemonPlayedThisTurn: number;
  supporterPlayedThisTurn: boolean;
  pokemonPlayedThisTurn: string[];
  cardsPlayedThisTurn: number;
}

export interface PtcgGameState {
  players: [PtcgPlayerState, PtcgPlayerState];
  turn: number;
  currentPlayer: number;
  phase: 'draw' | 'main' | 'attack' | 'end';
  winner: number | null;
  winReason: string | null;
  turnLog: TurnAction[];
  pendingChoice: PendingChoice | null;
  /** Only one Stadium card may be in play at a time; playing a new one discards the old (to its owner's pile). */
  activeStadium: GameCard | null;
}

export type GamePhase = PtcgGameState['phase'];
