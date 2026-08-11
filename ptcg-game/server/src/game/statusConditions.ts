import { PtcgGameState } from './GameState';
import { effectiveMaxHp, handleKo } from './damage';
import { getBurnCounterBonus, getColdCurtainVictims, getPoisonCounterBonus, getSandstormVictims } from './effects/passiveAbilities';

/**
 * "Between Turns" processing (runs once per turn transition, checking BOTH
 * players' Active Pokémon — not just the player whose turn is starting):
 * Poisoned deals 10, Burned deals 20 then a coin flip may cure it. Confusion
 * and Sleep/Paralysis-blocking-actions are handled elsewhere (moves.attack /
 * validation.canAttack); this only covers the two condition are damage tick.
 */
export function processBetweenTurns(G: PtcgGameState): void {
  // The player whose turn just ended — i.e. whoever was G.currentPlayer up until this call
  // (applyTurnBegin/turn.onBegin already flip G.currentPlayer to the new turn's player before
  // calling this). Needed for Paralysis below.
  const justFinishedIdx = (1 - G.currentPlayer) as 0 | 1;

  for (let idx = 0 as 0 | 1; idx <= 1; idx = (idx + 1) as 0 | 1) {
    const p = G.players[idx];
    const active = p.active;
    if (!active) continue;

    if (active.statusConditions.includes('Poisoned')) {
      // Normally 1 counter (10 HP); some opposing abilities (e.g. 劇毒支配) add more.
      active.damage += 10 + getPoisonCounterBonus(G, idx) * 10;
    }
    if (active.statusConditions.includes('Burned')) {
      // Normally 2 counters (20 HP); some opposing abilities (e.g. 熔岩波動) add more.
      active.damage += 20 + getBurnCounterBonus(G, idx) * 10;
      if (Math.random() < 0.5) {
        active.statusConditions = active.statusConditions.filter(c => c !== 'Burned');
      }
    }
    // Paralyzed: no coin flip (unlike Burned) and not re-checked at the start of the paralyzed
    // player's OWN turn (unlike Asleep, via processWakeUpCheck) — clearing it then would let
    // them act freely on the very turn it's meant to lock out. It clears once their one locked
    // turn has passed, i.e. right as the turn transitions to their opponent.
    if (idx === justFinishedIdx && active.statusConditions.includes('Paralyzed')) {
      active.statusConditions = active.statusConditions.filter(c => c !== 'Paralyzed');
    }

    const hp = effectiveMaxHp(G, active);
    if (hp > 0 && active.damage >= hp) {
      handleKo(G, idx, active.id);
    }
  }

  // 冰冷之帳: every ability-holding Pokémon on both sides (except the holder itself) takes
  // 1 damage counter each Between-Turns check, as long as its holder is still in play.
  for (const victim of getColdCurtainVictims(G)) {
    victim.damage += 10;
    const victimHp = effectiveMaxHp(G, victim);
    if (victimHp > 0 && victim.damage >= victimHp) handleKo(G, victim.owner, victim.id);
  }
  // 揚沙: every opponent Basic Pokémon takes 1 damage counter each Between-Turns check, gated
  // on the holder being its own side's Active.
  for (const victim of getSandstormVictims(G)) {
    victim.damage += 10;
    const victimHp = effectiveMaxHp(G, victim);
    if (victimHp > 0 && victim.damage >= victimHp) handleKo(G, victim.owner, victim.id);
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
