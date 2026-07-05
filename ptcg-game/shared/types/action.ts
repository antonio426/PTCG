export type GameActionType =
  | 'draw_card'
  | 'play_pokemon'
  | 'evolve_pokemon'
  | 'attach_energy'
  | 'play_trainer'
  | 'use_ability'
  | 'retreat'
  | 'attack'
  | 'end_turn'
  | 'forfeit';

export interface GameAction {
  type: GameActionType;
  payload: Record<string, unknown>;
  player: number;
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
}

export type LegalAction = {
  type: GameActionType;
  description: string;
  payload?: Record<string, unknown>;
};
