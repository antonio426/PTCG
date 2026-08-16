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

/** 對戰圓形競技場 Battle VS Arena: while in play, Benched Pokémon on both sides can't have
 * damage counters placed on them by the OPPONENT's attack-effect or ability-effect ("spread")
 * damage — printed text explicitly carves out direct attack damage ("[會受到招式的傷害。]"), but
 * this codebase's attack model always resolves an attack's own damage against the defending
 * Active (see moves.ts's `attack`), never the bench directly — every existing bench-damage code
 * path already IS one of the "effect" kinds this card blocks, so gating all of them is a complete
 * and correct implementation, not an approximation. */
export function benchDamageFromEffectsBlocked(G: PtcgGameState): boolean {
  return isStadiumActive(G, '對戰圓形競技場');
}
