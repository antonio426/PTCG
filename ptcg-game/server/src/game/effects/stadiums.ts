import { PtcgGameState } from '../GameState';

/**
 * Like Tool cards, Stadiums are persistent field effects queried on demand
 * rather than resolved once through a PendingChoice. Only one Stadium is ever
 * in play (see GameState.activeStadium); entering/leaving play is handled
 * generically in moves.ts, same pattern as Tool attachment.
 */
export function isStadiumActive(G: PtcgGameState, name: string): boolean {
  return G.activeStadium?.cardData.name === name;
}

/** 阻礙之塔 Blocking Tower: cancels every Pokémon Tool's effect while it's in play. */
export function toolsAreDisabled(G: PtcgGameState): boolean {
  return isStadiumActive(G, '阻礙之塔');
}
