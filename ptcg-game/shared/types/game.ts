import { Card } from './card';

export interface GameCard {
  id: string;
  cardData: Card;
  owner: 0 | 1;
  damage: number;
  statusConditions: StatusCondition[];
  attachedEnergy: AttachedEnergy[];
  /** At most one Pokémon Tool card may be attached per Pokémon under current rules. */
  attachedTool?: GameCard | null;
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

/**
 * Multi-step trainer/ability/attack effects (e.g. Ultra Ball: discard 2, then
 * search 1) can't resolve in a single move. When one is mid-resolution,
 * `pendingChoice` describes what response is needed next; the client must
 * answer it with a `resolve_choice` move (`{ selection: string[] }`) before
 * any other move becomes legal again.
 */
export interface PendingChoice {
  player: 0 | 1;
  /** Effect registry key that owns this choice, e.g. 'trainer:高級球' */
  effectKey: string;
  prompt: string;
  choiceType: 'select_hand_cards' | 'select_pokemon' | 'select_bench_pokemon' | 'select_from_list' | 'select_energy_type' | 'confirm';
  /** Exact required selection count, if fixed. */
  count?: number;
  minCount?: number;
  maxCount?: number;
  /** For select_from_list: the concrete options being chosen from. */
  options?: { id: string; label: string }[];
  context: Record<string, unknown>;
}
