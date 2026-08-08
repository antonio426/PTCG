import { EnergyType, GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { normalizeAbilityName } from './types';

/**
 * Most real Pokémon abilities are NOT "use once per turn" triggered effects (the shape
 * abilities.ts/EffectHandler was originally built for) — they're passive, always-on field
 * effects worded "只要...在場上" (as long as ... is in play): damage boosts, retreat-cost
 * waivers, damage immunity, weakness overrides. Those need to be queried continuously from
 * damage.ts/validation.ts/statusConditions.ts rather than fired once by a use_ability move,
 * the same way Tool cards (tools.ts) are queried rather than resolved through a PendingChoice.
 * This module is that query surface for abilities.
 */

function hasAbility(card: GameCard | null | undefined, name: string): boolean {
  if (!card) return false;
  return !!card.cardData.abilities?.some(a => a.text && normalizeAbilityName(a.name) === name);
}

function teamOf(G: PtcgGameState, idx: 0 | 1): GameCard[] {
  const p = G.players[idx];
  return [p.active, ...p.bench].filter((c): c is GameCard => c !== null);
}

function ownerIndexOf(G: PtcgGameState, card: GameCard): 0 | 1 {
  return card.owner;
}

function isActivePokemon(G: PtcgGameState, card: GameCard): boolean {
  return G.players[ownerIndexOf(G, card)].active?.id === card.id;
}

function isBenchedPokemon(G: PtcgGameState, card: GameCard): boolean {
  return G.players[ownerIndexOf(G, card)].bench.some(c => c?.id === card.id);
}

/** Extra damage `attacker` deals to `defender`, from any of the attacker's own team's passive abilities. */
export function getPassiveDamageBonus(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard): number {
  let bonus = 0;
  for (const holder of teamOf(G, attackerIdx)) {
    if (hasAbility(holder, '輝煌聲援') && attacker.cardData.name.includes('竹蘭的')) bonus += 30;
    if (hasAbility(holder, '閃焰象徵') && holder.id !== attacker.id
      && attacker.cardData.types?.includes('Fire') && attacker.cardData.subtypes.includes('Basic')) bonus += 10;
    if (hasAbility(holder, '鈷藍指令') && holder.id !== attacker.id
      && attacker.cardData.subtypes.includes('Future')) bonus += 20;
    if (hasAbility(holder, '腎上腺力量') && holder.id === attacker.id
      && attacker.attachedEnergy.some(e => e.type === 'Darkness')) bonus += 100;
  }
  return bonus;
}

/** True if `defender` takes zero damage (and, per real rules for these two, zero attack effects) from `attacker`'s attack. */
export function isDamageBlocked(G: PtcgGameState, attacker: GameCard, defender: GameCard): boolean {
  // 礎石之勢: immune to damage from any Pokémon that itself has an ability.
  if (hasAbility(defender, '礎石之勢') && attacker.cardData.abilities?.some(a => a.text)) return true;
  // 藏隱: while benched, untouchable by opponent attacks entirely (relevant to bench-hitting attacks).
  if (hasAbility(defender, '藏隱') && isBenchedPokemon(G, defender)) return true;
  return false;
}

/** Retreat cost is fully waived for `card` by any of its own team's passive abilities. */
export function getPassiveRetreatWaiver(G: PtcgGameState, idx: 0 | 1, card: GameCard): boolean {
  for (const holder of teamOf(G, idx)) {
    if (hasAbility(holder, '天空徑線') && card.cardData.subtypes.includes('Basic')) return true;
    if (hasAbility(holder, '鋼之橋') && card.attachedEnergy.some(e => e.type === 'Metal')) return true;
  }
  return false;
}

/** Extra max-HP `card` gains from its own passive ability. */
export function getPassiveMaxHpBonus(card: GameCard): number {
  if (hasAbility(card, '腎上腺力量') && card.attachedEnergy.some(e => e.type === 'Darkness')) return 100;
  return 0;
}

/** If an opponent's passive ability overrides `defender`'s weakness type, returns that type. */
export function getWeaknessTypeOverride(G: PtcgGameState, defenderIdx: 0 | 1, defender: GameCard): EnergyType | undefined {
  const attackerIdx = (1 - defenderIdx) as 0 | 1;
  for (const holder of teamOf(G, attackerIdx)) {
    if (hasAbility(holder, '妖精領域') && defender.cardData.types?.includes('Dragon')) return 'Psychic';
  }
  return undefined;
}

/** Extra damage counters (on top of the normal 1) placed on `poisoned` by Between-Turns poison tick. */
export function getPoisonCounterBonus(G: PtcgGameState, poisonedIdx: 0 | 1): number {
  const opponentActive = G.players[(1 - poisonedIdx) as 0 | 1].active;
  if (opponentActive && hasAbility(opponentActive, '劇毒支配') && isActivePokemon(G, opponentActive)) return 5;
  return 0;
}

/** Colorless-cost reduction for a specific Pokémon+attack combo, from the attacker's own passive ability. */
export function getPassiveAttackCostReduction(G: PtcgGameState, ownerIdx: 0 | 1, card: GameCard, attackName: string): number {
  if (hasAbility(card, '老練招式') && card.cardData.name === '月月熊 赫月 ex' && attackName === '血月') {
    return G.players[(1 - ownerIdx) as 0 | 1].takenPrizes;
  }
  return 0;
}

/** 虹色DNA: 伊布ex lets any "Eevee"-evolution ex be played from hand directly onto it, as if it evolved from 伊布. */
export function canEvolveViaPassive(target: GameCard, evolutionCardData: GameCard['cardData']): boolean {
  if (!hasAbility(target, '虹色DNA')) return false;
  return evolutionCardData.evolvesFrom === '伊布';
}

/** 放逐區障礙: if `defenderIdx`'s side has this ability in play, the attacking side's prizes are exiled, not drawn to hand. */
export function shouldExilePrizes(G: PtcgGameState, koVictimIdx: 0 | 1): boolean {
  return teamOf(G, koVictimIdx).some(c => hasAbility(c, '放逐區障礙'));
}

export { hasAbility as hasPassiveAbilityNamed };
