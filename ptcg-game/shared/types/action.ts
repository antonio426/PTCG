export type GameActionType =
  | 'choose_active'
  | 'draw_card'
  | 'play_pokemon'
  | 'evolve_pokemon'
  | 'attach_energy'
  | 'play_trainer'
  | 'use_ability'
  | 'retreat'
  | 'attack'
  | 'resolve_choice'
  | 'end_turn'
  | 'forfeit';

export interface GameAction {
  type: GameActionType;
  payload: Record<string, unknown>;
  player: number;
}

export interface ChooseActivePayload {
  cardId: string;
}

export interface PlayPokemonPayload {
  cardId: string;
  benchPosition: number;
}

export interface EvolvePokemonPayload {
  cardId: string;
  targetId: string;
}

export interface AttachEnergyPayload {
  cardId: string;
  targetId: string;
}

export interface PlayTrainerPayload {
  cardId: string;
  targets?: string[];
}

export interface AttackPayload {
  attackIndex: number;
}

export interface RetreatPayload {
  targetBenchPosition?: number;
  /** ids of attached-energy instances to discard as the retreat cost (player's choice) */
  discardEnergyIds?: string[];
}

export interface ResolveChoicePayload {
  /** ids selected in response to the current PendingChoice (card ids, pokemon ids, or option ids) */
  selection: string[];
}

export type LegalAction = {
  type: GameActionType;
  description: string;
  payload?: Record<string, unknown>;
};
