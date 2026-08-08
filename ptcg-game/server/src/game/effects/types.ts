import { GameCard } from '@ptcg/shared';
import { PendingChoice, PtcgGameState } from '../GameState';

export interface EffectContext {
  G: PtcgGameState;
  playerIndex: 0 | 1;
  /** The instance id of the trainer/pokemon/tool card that triggered this effect */
  sourceCardId: string;
}

/** Result of starting or resuming an effect: either it's fully resolved, or it needs another player choice. */
export type EffectStep = 'done' | Omit<PendingChoice, 'player' | 'effectKey'>;

export interface EffectHandler {
  /** Begin resolving the effect. Called once when the card/ability is used. */
  start(ctx: EffectContext): EffectStep;
  /**
   * Continue resolving after the player answered `choice` with `selection`.
   * `context` is whatever this handler previously stashed on the PendingChoice.
   */
  resume(ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep;
}

export function player(G: PtcgGameState, idx: 0 | 1) {
  return G.players[idx];
}

export function opponent(G: PtcgGameState, idx: 0 | 1) {
  return G.players[(1 - idx) as 0 | 1];
}

/** Find a Pokémon (active or benched) belonging to `idx` by instance id. */
export function findOwnPokemon(G: PtcgGameState, idx: 0 | 1, id: string): GameCard | null {
  const p = player(G, idx);
  if (p.active?.id === id) return p.active;
  return p.bench.find(c => c?.id === id) || null;
}

/** Every Pokémon (active + bench, non-null) belonging to `idx`. */
export function allPokemon(G: PtcgGameState, idx: 0 | 1): GameCard[] {
  const p = player(G, idx);
  return [p.active, ...p.bench].filter((c): c is GameCard => c !== null);
}

export function shuffleDeck(deck: GameCard[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}
