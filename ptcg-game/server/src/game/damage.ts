import { Attack, GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { getOutgoingDamageReduction, getPassiveDamageBonus, getPassiveDamageReduction, getPassiveMaxHpBonus, getPrizeReduction, getWeaknessTypeOverride, hasPassiveAbilityNamed, isDamageBlocked, rollBonusPrizeOnActiveKo, shouldExilePrizes } from './effects/passiveAbilities';
import { getToolDamageBonus, getToolHpBonus } from './effects/tools';
import { parseBaseNumber } from './effects/genericAttacks';

/** Rule-box Pokémon (ex/V/VMAX/VSTAR/GX/Mega/TAG TEAM) — same test as prizesForKo below. */
function isBigPokemon(card: GameCard): boolean {
  if (card.cardData.name.startsWith('超級') && card.cardData.subtypes.includes('ex')) return true;
  const bigSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  return card.cardData.subtypes.some(s => bigSubtypes.includes(s));
}

/** `card`'s max HP including any passive-ability bonus (e.g. 腎上腺力量's +100 while holding
 * Darkness energy) and any attached Tool's HP bonus (e.g. 英雄斗篷's +100). The Tool side of this
 * was a real bug: getToolHpBonus() existed and was exported but never actually called from
 * anywhere, so a Tool's hpBonus field silently did nothing even when correctly registered. */
export function effectiveMaxHp(G: PtcgGameState, card: GameCard): number {
  const base = parseInt(card.cardData.hp || '0', 10);
  return base > 0 ? base + getPassiveMaxHpBonus(G, card) + getToolHpBonus(G, card) : 0;
}

/**
 * Apply weakness (×2) / resistance (flat reduction) for `attacker`'s types onto a given base
 * damage number. `weaknessOverride`, when given, replaces `defender`'s printed weakness type
 * (e.g. 妖精領域 turning every opposing Dragon's weakness into Psychic).
 */
// The underlying card data mixes character variants for the same value depending on which
// source scraped/returned a given card — e.g. weakness "×2" (U+00D7 multiplication sign) vs
// "x2" (ASCII 'x'; 5828 of ~10714 cards in the current snapshot use this form), and resistance
// "-30" (ASCII hyphen-minus) vs "－30" (U+FF0D fullwidth) vs "₋30" (U+208B subscript minus).
// Comparing/parsing against only one variant silently no-ops weakness/resistance for every card
// using the other(s) — this single distinction affects the majority of the card pool.
function isDoubleWeakness(value: string | undefined): boolean {
  return !!value && /^[x×]2$/i.test(value.trim());
}

function parseResistanceValue(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.trim().replace(/^[-－₋−]/, '-');
  const n = parseInt(normalized, 10);
  return isNaN(n) ? 0 : n;
}

export function applyWeaknessResistance(baseDamageIn: number, attacker: GameCard, defender: GameCard, weaknessOverride?: string, ignoreResistance?: boolean, ignoreWeakness?: boolean): number {
  let baseDamage = baseDamageIn;
  const attackerTypes = attacker.cardData.types || [];

  for (const attackerType of attackerTypes) {
    if (!ignoreWeakness) {
      const weaknesses = weaknessOverride
        ? [{ type: weaknessOverride, value: '×2' }]
        : (defender.cardData.weaknesses || []);
      for (const weakness of weaknesses) {
        if (weakness.type === attackerType) {
          if (isDoubleWeakness(weakness.value)) baseDamage *= 2;
        }
      }
    }

    if (ignoreResistance) continue;
    const resistances = defender.cardData.resistances || [];
    for (const resistance of resistances) {
      if (resistance.type === attackerType) {
        // resistValue is already the signed correction as printed (e.g. -30) — ADD it to apply
        // the reduction. Subtracting it (as this line used to) flips the sign: `dmg - (-30)` =
        // `dmg + 30`, making Resistance increase damage instead of reducing it. This bug
        // predates the value-format fix above — it affected every card with a Resistance,
        // regardless of which minus-sign character its value happened to use.
        const resistValue = parseResistanceValue(resistance.value);
        if (resistValue !== 0) baseDamage = Math.max(0, baseDamage + resistValue);
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
export function calculateDamage(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, attack: Attack, defender: GameCard, ignoreResistance?: boolean, ignoreWeakness?: boolean): number {
  // Reuses genericAttacks.ts's parser (not a raw parseInt) so an attack whose text goes
  // unrecognized by every generic template — instead of falling through with its damage field
  // substituted by the resolved outcome — doesn't misread a coin-flip "40x" multiplier as a
  // guaranteed flat 40 damage.
  let baseDamage = parseBaseNumber(attack.damage);
  if (isDamageBlocked(G, attacker, defender, baseDamage)) return 0;
  baseDamage += getPassiveDamageBonus(G, attackerIdx, attacker, defender);
  baseDamage += getToolDamageBonus(G, attacker, defender);
  for (const boost of G.players[attackerIdx].turnDamageBoosts) {
    if (boost.typeFilter && !(attacker.cardData.types || []).includes(boost.typeFilter as any)) continue;
    if (boost.vsBigOnly && !isBigPokemon(defender)) continue;
    if (boost.excludeRuleBoxAttacker && isBigPokemon(attacker)) continue;
    baseDamage += boost.amount;
  }
  // Timed self-nerf from the attacker's own earlier attack (e.g. "在下個對手的回合，受到這個招式
  // 的寶可夢使用招式的傷害「-N」點" — printed on the DEFENDER at the time, so it reduces THEIR
  // outgoing damage once it becomes their turn to attack).
  baseDamage = Math.max(0, baseDamage - getOutgoingDamageReduction(G, attacker));
  const weaknessOverride = getWeaknessTypeOverride(G, (1 - attackerIdx) as 0 | 1, defender);
  const afterWeakness = applyWeaknessResistance(baseDamage, attacker, defender, weaknessOverride, ignoreResistance, ignoreWeakness);
  const defenderIdx = (1 - attackerIdx) as 0 | 1;
  let reduction = getPassiveDamageReduction(G, defender, attacker);
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

export function handleKo(G: PtcgGameState, koPlayerIndex: number, koCardId: string, attackerCard?: GameCard): void {
  const koPlayer = G.players[koPlayerIndex as 0 | 1];
  const attackingPlayer = G.players[(1 - koPlayerIndex) as 0 | 1];
  let koCard: GameCard | undefined;
  const wasActive = koPlayer.active?.id === koCardId;

  // 無限之影: when KO'd by an attack specifically, this card returns to hand (reset to a fresh
  // state) instead of the discard pile — its attachments still go to the discard pile as normal.
  const returnsToHand = (c: GameCard) => !!attackerCard && hasPassiveAbilityNamed(c, '無限之影');
  const retireCard = (c: GameCard) => {
    if (c.attachedTool) koPlayer.discardPile.push(c.attachedTool);
    if (returnsToHand(c)) {
      c.attachedEnergy = [];
      c.attachedTool = null;
      c.damage = 0;
      c.statusConditions = [];
      koPlayer.hand.push(c);
    } else {
      koPlayer.discardPile.push(c);
    }
  };

  if (koPlayer.active?.id === koCardId) {
    koCard = koPlayer.active;
    retireCard(koCard);
    koPlayer.active = null;
    // New Active selection is deferred to the start of koPlayer's own next turn — see
    // promoteActiveIfNeeded() below. Real rules have the player who lost their Active choose
    // the replacement themselves; auto-grabbing "whichever bench slot happens to be first" here
    // would silently take that choice away. Deferring is safe because the only way to KO an
    // opponent's Active is via an attack, which always ends the attacker's turn immediately —
    // there's no point before koPlayer's own next turn where anything needs their Active to be
    // already resolved.
  } else {
    const idx = koPlayer.bench.findIndex(c => c?.id === koCardId);
    if (idx >= 0) {
      koCard = koPlayer.bench[idx]!;
      retireCard(koCard);
      koPlayer.bench[idx] = null;
    }
  }

  let prizeCount = koCard ? prizesForKo(koCard) : 1;
  // 白蕾雅 / 巴貝娜與荷蓮娜-style "next KO this turn gives N extra prizes" — consumed on the first KO after being set.
  if (attackingPlayer.bonusPrizeNextKo > 0) { prizeCount += attackingPlayer.bonusPrizeNextKo; attackingPlayer.bonusPrizeNextKo = 0; }
  // 鬆口氣: the side that just lost this Pokémon may reduce the opponent's awarded prizes by 1.
  if (koCard) prizeCount = Math.max(0, prizeCount - getPrizeReduction(G, koPlayerIndex as 0 | 1, koCard, attackerCard));
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

/** Fills `playerIndex`'s empty Active slot at the start of their own turn (see handleKo's KO
 * branch, which leaves it empty rather than guessing). Auto-promotes when there's exactly one
 * Benched Pokémon (no real choice to make); otherwise asks via the normal same-player
 * pendingChoice flow, exactly like any other "pick one of your own Pokémon" effect. */
export function promoteActiveIfNeeded(G: PtcgGameState, playerIndex: 0 | 1): void {
  const player = G.players[playerIndex];
  if (player.active) return;
  const benchOptions = player.bench.filter((c): c is GameCard => c !== null);
  if (benchOptions.length === 0) return;
  if (benchOptions.length === 1) {
    const idx = player.bench.indexOf(benchOptions[0]);
    player.active = benchOptions[0];
    player.bench[idx] = null;
    return;
  }
  G.pendingChoice = {
    player: playerIndex,
    effectKey: 'ko_promotion',
    prompt: '你的出戰寶可夢已離場，選擇一隻備戰寶可夢上場',
    choiceType: 'select_bench_pokemon',
    count: 1,
    options: benchOptions.map(c => ({ id: c.id, label: c.cardData.name })),
    context: {},
  };
}
