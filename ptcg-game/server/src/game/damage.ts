import { Attack, GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { getPassiveDamageBonus, getPassiveDamageReduction, getPassiveMaxHpBonus, getWeaknessTypeOverride, isDamageBlocked, rollBonusPrizeOnActiveKo, shouldExilePrizes } from './effects/passiveAbilities';
import { getToolDamageBonus } from './effects/tools';

/** Rule-box Pokémon (ex/V/VMAX/VSTAR/GX/Mega/TAG TEAM) — same test as prizesForKo below. */
function isBigPokemon(card: GameCard): boolean {
  if (card.cardData.name.startsWith('超級') && card.cardData.subtypes.includes('ex')) return true;
  const bigSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  return card.cardData.subtypes.some(s => bigSubtypes.includes(s));
}

/** `card`'s max HP including any passive-ability bonus (e.g. 腎上腺力量's +100 while holding Darkness energy). */
export function effectiveMaxHp(G: PtcgGameState, card: GameCard): number {
  const base = parseInt(card.cardData.hp || '0', 10);
  return base > 0 ? base + getPassiveMaxHpBonus(G, card) : 0;
}

/**
 * Apply weakness (×2) / resistance (flat reduction) for `attacker`'s types onto a given base
 * damage number. `weaknessOverride`, when given, replaces `defender`'s printed weakness type
 * (e.g. 妖精領域 turning every opposing Dragon's weakness into Psychic).
 */
export function applyWeaknessResistance(baseDamageIn: number, attacker: GameCard, defender: GameCard, weaknessOverride?: string): number {
  let baseDamage = baseDamageIn;
  const attackerTypes = attacker.cardData.types || [];

  for (const attackerType of attackerTypes) {
    const weaknesses = weaknessOverride
      ? [{ type: weaknessOverride, value: '×2' }]
      : (defender.cardData.weaknesses || []);
    for (const weakness of weaknesses) {
      if (weakness.type === attackerType) {
        if (weakness.value === '×2') baseDamage *= 2;
      }
    }

    const resistances = defender.cardData.resistances || [];
    for (const resistance of resistances) {
      if (resistance.type === attackerType) {
        const resistValue = parseInt(resistance.value);
        if (!isNaN(resistValue)) baseDamage = Math.max(0, baseDamage - resistValue);
      }
    }
  }

  return baseDamage;
}

/**
 * `G`/`attackerIdx` are needed (beyond the two cards involved) because several real abilities
 * are field-wide passives — a damage bonus can come from a *different* Pokémon on the attacker's
 * bench (e.g. 輝煌聲援), and a weakness override can come from the attacker's whole team
 * (e.g. 妖精領域). Returns 0 if a passive ability blocks the hit outright (e.g. 藏隱, 礎石之勢).
 */
export function calculateDamage(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, attack: Attack, defender: GameCard): number {
  if (isDamageBlocked(G, attacker, defender)) return 0;
  let baseDamage = parseInt(attack.damage) || 0;
  if (isNaN(baseDamage)) baseDamage = 0;
  baseDamage += getPassiveDamageBonus(G, attackerIdx, attacker, defender);
  baseDamage += getToolDamageBonus(G, attacker, defender);
  for (const boost of G.players[attackerIdx].turnDamageBoosts) {
    if (boost.typeFilter && !(attacker.cardData.types || []).includes(boost.typeFilter as any)) continue;
    if (boost.vsBigOnly && !isBigPokemon(defender)) continue;
    if (boost.excludeRuleBoxAttacker && isBigPokemon(attacker)) continue;
    baseDamage += boost.amount;
  }
  const weaknessOverride = getWeaknessTypeOverride(G, (1 - attackerIdx) as 0 | 1, defender);
  const afterWeakness = applyWeaknessResistance(baseDamage, attacker, defender, weaknessOverride);
  const defenderIdx = (1 - attackerIdx) as 0 | 1;
  let reduction = getPassiveDamageReduction(G, defender);
  for (const r of G.players[defenderIdx].incomingDamageReduction) {
    if (r.typeFilter && !(defender.cardData.types || []).includes(r.typeFilter as any)) continue;
    reduction += r.amount;
  }
  return Math.max(0, afterWeakness - reduction);
}

export function applyDamage(G: PtcgGameState, playerIndex: number, targetId: string, damage: number): void {
  const player = G.players[playerIndex as 0 | 1];

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;

  if (!target) return;
  target.damage += damage;
}

/** Standard-format prize rule: Mega ("超級...ex") = 3 prizes, other ex/V/VMAX/VSTAR/GX = 2, everything else = 1. */
export function prizesForKo(card: GameCard): number {
  if (card.cardData.name.startsWith('超級') && card.cardData.subtypes.includes('ex')) return 3;
  const bigSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  if (card.cardData.subtypes.some(s => bigSubtypes.includes(s))) return 2;
  return 1;
}

export function handleKo(G: PtcgGameState, koPlayerIndex: number, koCardId: string): void {
  const koPlayer = G.players[koPlayerIndex as 0 | 1];
  const attackingPlayer = G.players[(1 - koPlayerIndex) as 0 | 1];
  let koCard: GameCard | undefined;
  const wasActive = koPlayer.active?.id === koCardId;

  if (koPlayer.active?.id === koCardId) {
    koCard = koPlayer.active;
    if (koCard.attachedTool) koPlayer.discardPile.push(koCard.attachedTool);
    koPlayer.discardPile.push(koCard);
    koPlayer.active = null;

    const promo = koPlayer.bench.find(s => s !== null);
    if (promo) {
      const idx = koPlayer.bench.indexOf(promo);
      koPlayer.active = promo;
      koPlayer.bench[idx] = null;
    }
  } else {
    const idx = koPlayer.bench.findIndex(c => c?.id === koCardId);
    if (idx >= 0) {
      koCard = koPlayer.bench[idx]!;
      if (koCard.attachedTool) koPlayer.discardPile.push(koCard.attachedTool);
      koPlayer.discardPile.push(koCard);
      koPlayer.bench[idx] = null;
    }
  }

  let prizeCount = koCard ? prizesForKo(koCard) : 1;
  // 白蕾雅-style "next KO this turn gives 1 extra prize" — consumed on the first KO after being set.
  if (attackingPlayer.bonusPrizeNextKo) { prizeCount += 1; attackingPlayer.bonusPrizeNextKo = false; }
  // 奇跡之吻: whenever the koPlayer's Active specifically faints (any cause), a coin flip may
  // grant the opposing side (whichever holds the ability) 1 extra prize.
  if (wasActive) prizeCount += rollBonusPrizeOnActiveKo(G, koPlayerIndex as 0 | 1);
  // 放逐區障礙: if the side that just lost a Pokémon still has this ability in play, the
  // attacking side's prizes go to their exile zone instead of hand — permanently unusable.
  const exile = shouldExilePrizes(G, koPlayerIndex as 0 | 1);
  for (let i = 0; i < prizeCount; i++) {
    const prize = attackingPlayer.prizes.pop();
    if (prize) {
      if (exile) attackingPlayer.exileZone.push(prize);
      else attackingPlayer.hand.push(prize);
      attackingPlayer.takenPrizes++;
    }
  }
}
