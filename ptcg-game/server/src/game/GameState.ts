import { GameCard, TurnAction } from '@ptcg/shared';

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
}

export type GamePhase = PtcgGameState['phase'];
