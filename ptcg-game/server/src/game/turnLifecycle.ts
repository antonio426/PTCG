import type { PtcgGameState } from './GameState';
import { promoteActiveIfNeeded } from './damage';
import { processBetweenTurns, processWakeUpCheck } from './statusConditions';

/**
 * The start-of-turn work every engine has to do, in one place.
 *
 * There are four drivers of the same game logic (see CLAUDE.md, "Two parallel battle engines"):
 * `ai/battleRunner.ts`, `routes/humanBattle.ts`, `game/PtcgGame.ts` and `routes/battles.ts`.
 * This block used to be hand-copied into each of them, and the documented failure mode is exactly
 * what that invites: a rule that only some copies get right. Twice now — first the first-player
 * draw (fixed in three copies while `routes/battles.ts`, the BattleLab AI-vs-AI engine, kept the
 * pre-fix ternary and therefore measured win rates under different rules), then four per-turn
 * resets that the same copy never learned about. It is a shared function now; callers that need
 * their own bookkeeping (PtcgGame's `ctx.currentPlayer` mapping and `G.turn++`) do it around the
 * call, not by re-implementing this.
 */
export function applyTurnBegin(G: PtcgGameState): void {
  const idx = G.currentPlayer as 0 | 1;
  // Before promoteActiveIfNeeded: a KO replacement promoted now also counts as
  // "placed from the Bench this turn".
  G.players[idx].activeIdAtTurnStart = G.players[idx].active?.id;
  // If this player's Active was Knocked Out last turn, they choose their new one now — see
  // promoteActiveIfNeeded's own comment for why this timing is always safe.
  promoteActiveIfNeeded(G, idx);
  if (G.turn > 1) processBetweenTurns(G);
  // Every turn starts with a draw, INCLUDING the first player's first turn — going first is
  // paid for by the no-attack/no-evolve/no-Supporter restrictions (see isFirstTurnOfGame in
  // validation.ts), not by skipping the draw. Verified against ptcg-tw-sim.com, whose log reads
  // "Setup 完成！<先手> 行動中。" immediately followed by "<先手> 抽了 1 張牌（手牌 7 張）".
  // This used to read `G.turn === 1 ? 'main' : 'draw'`, which silently clobbered the 'draw' that
  // setup() itself had already set — so the first player never drew.
  G.phase = 'draw';
  processWakeUpCheck(G, idx);
  // 「在這個回合，若這隻寶可夢恢復了HP」 is scoped to the turn being played, so every card in play
  // starts each turn having healed nothing — both sides, since either can be healed on either turn.
  for (const p of G.players) {
    for (const c of [p.active, ...p.bench]) if (c) c.healedThisTurn = false;
  }
  const player = G.players[idx];
  player.energyAttachedThisTurn = 0;
  player.basicPokemonPlayedThisTurn = 0;
  player.supporterPlayedThisTurn = false;
  player.supporterNamesPlayedThisTurn = [];
  player.pokemonPlayedThisTurn = [];
  player.cardsPlayedThisTurn = 0;
  player.abilitiesUsedThisTurn = [];
  player.usedBonusAttackThisTurn = false;
  player.turnDamageBoosts = [];
  player.bonusPrizeNextKo = 0;
  player.incomingDamageReduction = [];
  player.retreatedThisTurn = false;
  player.stadiumActionUsedThisTurn = false;
}
