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
    if (hasAbility(holder, '皇家聲援')) bonus += 20;
  }
  return bonus;
}

/** True if `defender` takes zero damage (and, per real rules for these two, zero attack effects) from `attacker`'s attack. */
export function isDamageBlocked(G: PtcgGameState, attacker: GameCard, defender: GameCard): boolean {
  // 礎石之勢: immune to damage from any Pokémon that itself has an ability.
  if (hasAbility(defender, '礎石之勢') && attacker.cardData.abilities?.some(a => a.text)) return true;
  // 藏隱: while benched, untouchable by opponent attacks entirely (relevant to bench-hitting attacks).
  if (hasAbility(defender, '藏隱') && isBenchedPokemon(G, defender)) return true;
  // 化隱: untouchable regardless of board position (a stronger, unconditional variant of 藏隱).
  if (hasAbility(defender, '化隱')) return true;
  // 花之帷幔: own non-rule-box Benched Pokémon are immune to opponent attack damage.
  if (isBenchedPokemon(G, defender) && !isRuleBoxPokemon(defender)
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '花之帷幔'))) return true;
  // 神秘石居: immune to damage specifically from an opponent's "ex" Pokémon.
  if (hasAbility(defender, '神秘石居') && attacker.cardData.subtypes.includes('ex')) return true;
  // 腎上腺費洛蒙: while holding Darkness Energy, a coin flip may negate the hit entirely.
  if (hasAbility(defender, '腎上腺費洛蒙') && defender.attachedEnergy.some(e => e.type === 'Darkness') && Math.random() < 0.5) return true;
  return false;
}

/** Rule-box Pokémon (ex/V/VMAX/VSTAR/GX/Mega/TAG TEAM) — local copy to avoid a cross-module import cycle. */
function isRuleBoxPokemon(card: GameCard): boolean {
  const subs = card.cardData.subtypes || [];
  const ruleBoxSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  if (subs.some(s => ruleBoxSubtypes.includes(s))) return true;
  return card.cardData.name.startsWith('超級');
}

/** Flat damage reduction (before floor-at-0) applied to hits `defender` takes, from its own ability. */
export function getPassiveDamageReduction(defender: GameCard): number {
  if (hasAbility(defender, '爆炸頭防守')) return 20;
  return 0;
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
export function getPassiveMaxHpBonus(G: PtcgGameState, card: GameCard): number {
  if (hasAbility(card, '腎上腺力量') && card.attachedEnergy.some(e => e.type === 'Darkness')) return 100;
  if (hasAbility(card, '雜草魂')) return G.players[(1 - ownerIndexOf(G, card)) as 0 | 1].takenPrizes * 50;
  return 0;
}

/** False if `card`'s passive ability makes its own attacks currently unusable (e.g. 力量抑制者's family-count gate). */
export function canUsePassiveGatedAttack(G: PtcgGameState, card: GameCard): boolean {
  if (hasAbility(card, '力量抑制者')) {
    const rocketCount = teamOf(G, ownerIndexOf(G, card)).filter(c => c.cardData.name.includes('火箭隊的')).length;
    return rocketCount >= 4;
  }
  return true;
}

/** Extra prizes awarded to `attackerIdx` when their attack KOs `defender` (beyond the normal count). */
export function getBonusPrizesForAttackKo(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard): number {
  // 貪婪食客: +1 prize if this Pokémon's own attack KOs an opponent's Basic Pokémon.
  if (hasAbility(attacker, '貪婪食客') && defender.cardData.subtypes.includes('Basic')) return 1;
  return 0;
}

/** Coin-flip bonus prize (奇跡之吻-style): whenever the opponent's Active Pokémon faints (any cause),
 * `victimIdx`'s opponent flips a coin for +1 prize if any of their own team has this ability.
 * Doesn't stack across multiple holders per the printed text. */
export function rollBonusPrizeOnActiveKo(G: PtcgGameState, victimIdx: 0 | 1): number {
  const beneficiaryIdx = (1 - victimIdx) as 0 | 1;
  if (!teamOf(G, beneficiaryIdx).some(c => hasAbility(c, '奇跡之吻'))) return 0;
  return Math.random() < 0.5 ? 1 : 0;
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

/** 崗哨: while `card` is Benched and its own team has this ability in play, its attached Energy
 * can't be discarded by the opponent's Item/Supporter effects (e.g. 粉碎之錘, 改造之錘). Real
 * text only protects Basic Energy specifically, but attachedEnergy doesn't retain whether the
 * source card was Basic vs Special — so this protects all attached Energy on the Pokémon,
 * a documented over-protection rather than under-protection. */
export function isEnergyDiscardProtected(G: PtcgGameState, card: GameCard): boolean {
  if (!isBenchedPokemon(G, card)) return false;
  return teamOf(G, ownerIndexOf(G, card)).some(c => hasAbility(c, '崗哨'));
}

export { hasAbility as hasPassiveAbilityNamed };

/** Every ability name this module gives real, non-default behavior to — used by coverage-report.ts. */
export const PASSIVE_ABILITY_NAMES = new Set([
  '輝煌聲援', '閃焰象徵', '鈷藍指令', '腎上腺力量', '礎石之勢', '藏隱', '天空徑線', '鋼之橋',
  '妖精領域', '劇毒支配', '老練招式', '虹色DNA', '放逐區障礙', '祭典樂舞', '崗哨',
  '皇家聲援', '化隱', '花之帷幔', '神秘石居', '腎上腺費洛蒙', '爆炸頭防守', '雜草魂',
  '力量抑制者', '貪婪食客', '奇跡之吻', '毒刺',
]);
