import { Attack, DamageDetail, GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { getOutgoingDamageReduction, getPassiveDamageBonus, getPassiveDamageReduction, getPassiveMaxHpBonus, getPrizeReduction, getWeaknessTypeOverride, hasPassiveAbilityNamed, isDamageBlocked, isWeaknessRemovedByTimedEffect, rollBonusPrizeOnActiveKo, shouldExilePrizes, isProtectedFromOpponentAbility } from './effects/passiveAbilities';
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
 * Call whenever `oldCard` stops being the in-play top card because `newTop` is replacing it
 * (evolving, de-evolving-away, or any other "one card becomes another in the same board slot"
 * effect) — real rules: the old card does NOT go to the discard pile yet, it stays stacked
 * underneath until the whole thing is eventually removed from play. `newTop.preEvolutions`
 * accumulates oldest-first, correctly nesting a Stage-2 evolution's full history.
 *
 * Strips `oldCard`'s own attachedEnergy/attachedTool/damage/statusConditions before stacking it
 * — without this, `oldCard.attachedEnergy` stays the SAME array object as `newTop.attachedEnergy`
 * (every evolution site does a bare reference assignment, never a clone), so any later
 * energy-discard effect on the current top card would silently also mutate every stacked
 * historical entry. Making stacked entries permanently attachment-free (the top card is the sole
 * "live" owner of attachments) sidesteps that aliasing hazard entirely rather than chasing clones
 * through every evolution-shaped effect.
 */
export function stackAsPreEvolution(newTop: GameCard, oldCard: GameCard): void {
  oldCard.attachedEnergy = [];
  oldCard.attachedTool = null;
  oldCard.damage = 0;
  oldCard.statusConditions = [];
  newTop.preEvolutions = [...(oldCard.preEvolutions || []), oldCard];
  oldCard.preEvolutions = undefined;
}

/** Moves `card`'s stacked pre-evolution history (see `stackAsPreEvolution`) into `zone`, and
 * detaches it from the card so the caller can move the top card separately. No-op if the card
 * never evolved (`preEvolutions` unset).
 *
 * Which zone is correct is decided by the printed text of the effect doing the moving, NOT by
 * where the top card is going — 「將這隻寶可夢與附加的卡，全部放回自己的牌庫」 counts the lower
 * Stages stacked underneath as part of "附加的卡", so 土龍節節 takes 土龍弟弟 back into the deck
 * with it. Pass the destination the text names. */
export function flushPreEvolutionsTo(card: GameCard, zone: GameCard[]): void {
  if (card.preEvolutions) {
    zone.push(...card.preEvolutions);
    card.preEvolutions = undefined;
  }
}

/** The discard-pile case of `flushPreEvolutionsTo` — call this wherever a top card permanently
 * leaves play into the discard pile (KO'd, discarded by an effect). An effect that bounces the
 * Pokémon to hand/deck usually wants `flushPreEvolutionsTo(card, hand|deck)` instead; read the
 * card's printed text before assuming the stack is discarded. */
export function flushPreEvolutionsToDiscard(card: GameCard, discardPile: GameCard[]): void {
  flushPreEvolutionsTo(card, discardPile);
}

/** Call whenever a card sitting in the discard pile re-enters hand/deck/bench (e.g. 夜間擔架,
 * 聖灰, 溫柔鰭) — a KO'd Pokémon is pushed to the discard pile with its damage/energy/tool/status
 * still attached (see handleKo's normal-KO branch, which bundles them along rather than
 * unpacking each into its own discard entry), so without this reset a retrieved Pokémon carries
 * its old lethal damage back into play with nothing left to re-trigger a KO check — it just sits
 * on the board past 0 HP. Mirrors the reset handleKo already does for the 無限之影 return-to-hand
 * case. Doesn't touch `preEvolutions`: any card in the discard pile already had that flushed by
 * flushPreEvolutionsToDiscard before it got there. */
export function resetCardForReentry(card: GameCard, discardPile: GameCard[]): void {
  card.damage = 0;
  card.statusConditions = [];
  // The attachments have to go SOMEWHERE. Clearing the fields outright deleted them from the
  // game: a KO'd Pokémon reaches the discard pile still carrying its energy (handleKo's
  // normal-KO branch bundles them rather than unpacking each into its own entry), so retrieving
  // it with 夜間擔架 / 水蓮的照顧 silently destroyed every energy card that had been on it.
  // Unbundling into the discard pile here reproduces the real-rules end state, where those cards
  // were discarded separately the moment the Pokémon was Knocked Out.
  // `discardPile` is required rather than optional so a new call site can't quietly drop them.
  for (const energy of card.attachedEnergy.splice(0)) {
    if (energy.cardData) {
      discardPile.push({
        id: energy.id, cardData: energy.cardData, owner: card.owner,
        damage: 0, statusConditions: [], attachedEnergy: [],
      });
    }
  }
  if (card.attachedTool) {
    discardPile.push(card.attachedTool);
    card.attachedTool = null;
  }
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
/**
 * Same computation as `calculateDamage`, plus a structured breakdown for battle-log display
 * (weakness/resistance flags computed independently of the combined `afterWeakness` number,
 * since `applyWeaknessResistance` applies both effects together internally).
 */
export function calculateDamageBreakdown(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, attack: Attack, defender: GameCard, ignoreResistance?: boolean, ignoreWeakness?: boolean): DamageDetail {
  // Reuses genericAttacks.ts's parser (not a raw parseInt) so an attack whose text goes
  // unrecognized by every generic template — instead of falling through with its damage field
  // substituted by the resolved outcome — doesn't misread a coin-flip "40x" multiplier as a
  // guaranteed flat 40 damage.
  let baseDamage = parseBaseNumber(attack.damage);
  if (isDamageBlocked(G, attacker, defender, baseDamage)) {
    return { baseDamage: 0, afterWeakness: 0, weaknessApplied: false, resistanceApplied: false, finalDamage: 0 };
  }
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
  // 妖精領域-style added weakness is an opponent ABILITY's effect on the defender — 光之翼 ignores it.
  const weaknessOverride = isProtectedFromOpponentAbility(G, defender)
    ? undefined : getWeaknessTypeOverride(G, (1 - attackerIdx) as 0 | 1, defender);
  const weaknessRemoved = ignoreWeakness || isWeaknessRemovedByTimedEffect(G, defender);
  const afterWeakness = applyWeaknessResistance(baseDamage, attacker, defender, weaknessOverride, ignoreResistance, weaknessRemoved);
  const defenderIdx = (1 - attackerIdx) as 0 | 1;
  // 藏青浪濤: this attacker's damage ignores every "attached effect" (Tool/ability-based
  // incoming-damage reduction) the defender has — both incoming-reduction pipelines below.
  let reduction = hasPassiveAbilityNamed(G, attacker, '藏青浪濤') ? 0 : getPassiveDamageReduction(G, defender, attacker);
  if (!hasPassiveAbilityNamed(G, attacker, '藏青浪濤')) {
    for (const r of G.players[defenderIdx].incomingDamageReduction) {
      if (r.typeFilter && !(defender.cardData.types || []).includes(r.typeFilter as any)) continue;
      reduction += r.amount;
    }
  }
  const finalDamage = Math.max(0, afterWeakness - reduction);

  const attackerTypes = attacker.cardData.types || [];
  const weaknessApplied = !weaknessRemoved && attackerTypes.some(t => {
    const weaknesses = weaknessOverride ? [{ type: weaknessOverride, value: '×2' }] : (defender.cardData.weaknesses || []);
    return weaknesses.some(w => w.type === t && isDoubleWeakness(w.value));
  });
  const resistanceApplied = !ignoreResistance && attackerTypes.some(t =>
    (defender.cardData.resistances || []).some(r => r.type === t && parseResistanceValue(r.value) !== 0)
  );

  return { baseDamage, afterWeakness, weaknessApplied, resistanceApplied, finalDamage };
}

export function calculateDamage(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, attack: Attack, defender: GameCard, ignoreResistance?: boolean, ignoreWeakness?: boolean): number {
  return calculateDamageBreakdown(G, attackerIdx, attacker, attack, defender, ignoreResistance, ignoreWeakness).finalDamage;
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
  // Feeds "did my Pokémon faint during the opponent's last turn"-gated abilities (e.g. 吉雉雞ex's
  // 扭轉乾坤) — recorded for every KO cause (attack, Poison/Burn, self-damage, ability), including
  // the 無限之影 return-to-hand branch below, which is still a real KO (prizes awarded) even
  // though the card doesn't end up in the discard pile.
  koPlayer.lastPokemonFaintedTurn = G.turn;

  // 無限之影: when KO'd by an attack specifically, this card returns to hand (reset to a fresh
  // state) instead of the discard pile — its attachments still go to the discard pile as normal.
  const returnsToHand = (c: GameCard) => !!attackerCard && hasPassiveAbilityNamed(G, c, '無限之影');
  const retireCard = (c: GameCard) => {
    if (c.attachedTool) {
      koPlayer.discardPile.push(c.attachedTool);
      // Detach after unpacking it. Attached ENERGY deliberately rides along on the card into the
      // discard pile (see the normal-KO branch below) rather than becoming its own entry, but the
      // Tool is unpacked into its own entry here — so leaving the field set put the same card in
      // the pile twice: once standalone, once still hanging off the KO'd Pokémon. Discard piles
      // are public, so the duplicate was visible, and any effect that retrieves or counts Tools
      // in the discard could act on it twice.
      c.attachedTool = null;
    }
    if (returnsToHand(c)) {
      // Inlined rather than imported from effects/primitives.ts — that file imports handleKo
      // from here, so importing back would be circular.
      for (const energy of c.attachedEnergy.splice(0)) {
        if (energy.cardData) {
          koPlayer.discardPile.push({ id: energy.id, cardData: energy.cardData, owner: koPlayerIndex as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
      }
      c.attachedTool = null;
      c.damage = 0;
      c.statusConditions = [];
      // Only the top card returns to hand — any stacked pre-evolution history is lost same as
      // real rules (it doesn't ride along into hand as a hidden freebie).
      flushPreEvolutionsToDiscard(c, koPlayer.discardPile);
      koPlayer.hand.push(c);
    } else {
      flushPreEvolutionsToDiscard(c, koPlayer.discardPile);
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

/**
 * State-based Knock Out check for both sides: any Pokémon whose damage has reached its CURRENT
 * effective max HP is Knocked Out, even though nothing just damaged it.
 *
 * Damage is checked at the moment it's dealt, but max HP is not fixed — it moves when a
 * modifier arrives or leaves: 激動競技場 gives every Basic +30 and 引力山岳 takes 30 off every
 * Stage 2, so replacing one Stadium with another can drop a Pokémon's ceiling below the damage
 * already on it. The same goes for an HP-granting Tool being removed, or 阻礙之塔 arriving and
 * switching every Tool off. Without this sweep those Pokémon just kept playing at, say, 130/120.
 *
 * Victims are collected before any KO is applied, since handleKo mutates the board it's read
 * from. One pass is enough: a KO can only lower the board's HP modifiers further in ways this
 * sweep's own callers (turn transitions, Stadium changes) will re-check.
 */
export function sweepKnockedOut(G: PtcgGameState): void {
  const victims: { owner: 0 | 1; id: string }[] = [];
  for (let idx = 0 as 0 | 1; idx <= 1; idx = (idx + 1) as 0 | 1) {
    const p = G.players[idx];
    for (const card of [p.active, ...p.bench]) {
      if (!card) continue;
      const hp = effectiveMaxHp(G, card);
      if (hp > 0 && card.damage >= hp) victims.push({ owner: idx, id: card.id });
    }
  }
  for (const v of victims) handleKo(G, v.owner, v.id);
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
