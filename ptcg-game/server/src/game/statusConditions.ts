import { PtcgGameState } from './GameState';
import { handleKo } from './damage';

/**
 * "Between Turns" processing (runs once per turn transition, checking BOTH
 * players' Active Pokémon — not just the player whose turn is starting):
 * Poisoned deals 10, Burned deals 20 then a coin flip may cure it. Confusion
 * and Sleep/Paralysis-blocking-actions are handled elsewhere (moves.attack /
 * validation.canAttack); this only covers the two condition are damage tick.
 */
export function processBetweenTurns(G: PtcgGameState): void {
  for (let idx = 0 as 0 | 1; idx <= 1; idx = (idx + 1) as 0 | 1) {
    const p = G.players[idx];
    const active = p.active;
    if (!active) continue;

    if (active.statusConditions.includes('Poisoned')) {
      active.damage += 10;
    }
    if (active.statusConditions.includes('Burned')) {
      active.damage += 20;
      if (Math.random() < 0.5) {
        active.statusConditions = active.statusConditions.filter(c => c !== 'Burned');
      }
    }

    const hp = parseInt(active.cardData.hp || '0', 10);
    if (hp > 0 && active.damage >= hp) {
      handleKo(G, idx, active.id);
    }
  }
}

/** Asleep wakes up on a coin flip at the start of its controller's turn (checked once that turn begins). */
export function processWakeUpCheck(G: PtcgGameState, playerIndex: 0 | 1): void {
  const active = G.players[playerIndex].active;
  if (!active || !active.statusConditions.includes('Asleep')) return;
  if (Math.random() < 0.5) {
    active.statusConditions = active.statusConditions.filter(c => c !== 'Asleep');
  }
}

/** Real rules: leaving the Active Spot (retreat/switch) clears all special conditions. */
export function clearStatusConditionsOnLeaveActive(card: { statusConditions: string[] } | null | undefined): void {
  if (card) card.statusConditions = [];
}
