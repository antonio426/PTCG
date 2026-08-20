import { GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, normalizeCardName, opponent, player, shuffleDeck } from './types';
import { applyWeaknessResistance, handleKo } from '../damage';
import { discardAttachedEnergy } from './primitives';

/**
 * Attacks whose text does something beyond flat weakness/resistance damage
 * (bench damage distribution, discard-for-damage, self-damage, etc.) are
 * keyed by "寶可夢名稱::招式名稱" since the same attack name can appear on
 * different Pokémon with different costs. Only attacks with non-empty
 * `attack.text` need an entry here — plain flat-damage attacks (the vast
 * majority) are handled by the existing calculateDamage() path untouched.
 */
function damageDefenderActive(ctx: EffectContext, baseDamage: number): void {
  const attacker = player(ctx.G, ctx.playerIndex).active;
  const defender = opponent(ctx.G, ctx.playerIndex).active;
  if (!attacker || !defender) return;
  const dmg = applyWeaknessResistance(baseDamage, attacker, defender);
  defender.damage += dmg;
  const hp = parseInt(defender.cardData.hp || '0', 10);
  if (hp > 0 && defender.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, defender.id);
}

/** 幻影奇襲 (Dragapult ex-style): 200 to the Active, then freely distribute 6 damage counters across the opponent's bench. */
const phantomDive: EffectHandler = {
  start(ctx) {
    damageDefenderActive(ctx, 200);
    return placeNextBenchCounter(ctx, 6);
  },
  resume(ctx, context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = opp.bench.find(c => c?.id === selection[0]);
    if (target) {
      target.damage += 10;
      const hp = parseInt(target.cardData.hp || '0', 10);
      if (hp > 0 && target.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
    }
    const remaining = (context.remaining as number) - 1;
    return placeNextBenchCounter(ctx, remaining);
  },
};

function placeNextBenchCounter(ctx: EffectContext, remaining: number): EffectStep {
  if (remaining <= 0) return 'done';
  const opp = opponent(ctx.G, ctx.playerIndex);
  const targets = opp.bench.filter((c): c is GameCard => c !== null);
  if (targets.length === 0) return 'done';
  return {
    prompt: `幻影奇襲：將傷害指示物自由分配到對手備戰寶可夢（剩餘 ${remaining} 個）`,
    choiceType: 'select_pokemon',
    count: 1,
    options: targets.map(t => ({ id: t.id, label: `${t.cardData.name}（${t.damage} 傷害）` })),
    context: { remaining },
  };
}

/** 花冠射線 (Diancie ex-style): discard up to 2 energy from this Pokémon, deal (discarded count) × 120 damage. */
const floralRay: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const attacker = p.active;
    if (!attacker || attacker.attachedEnergy.length === 0) { damageDefenderActive(ctx, 0); return 'done'; }
    return {
      prompt: '花冠射線：選擇最多 2 張這隻寶可夢身上的能量丟棄',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, attacker.attachedEnergy.length),
      options: attacker.attachedEnergy.map(e => ({ id: e.id, label: e.type })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const attacker = p.active;
    if (!attacker) return 'done';
    for (const id of selection) {
      const i = attacker.attachedEnergy.findIndex(e => e.id === id);
      if (i >= 0) discardAttachedEnergy(ctx.G, ctx.playerIndex, attacker.attachedEnergy.splice(i, 1)[0]);
    }
    damageDefenderActive(ctx, selection.length * 120);
    return 'done';
  },
};

/**
 * 惡棍衝擊 (火箭隊的袋獸ex): 120+, and +100 more if a Supporter whose name contains 「火箭隊」
 * was played from hand this turn. `supporterNamesPlayedThisTurn` exists for exactly this
 * family-scoped question, which a plain "played a Supporter" boolean can't answer.
 */
const villainousShock: EffectHandler = {
  start(ctx) {
    const played = player(ctx.G, ctx.playerIndex).supporterNamesPlayedThisTurn;
    const bonus = played.some(n => normalizeCardName(n).includes('火箭隊')) ? 100 : 0;
    damageDefenderActive(ctx, 120 + bonus);
    return 'done';
  },
  resume() { return 'done'; },
};

/**
 * 阿賽斯特萊石 (太陽伊布ex): remove one evolution card from EVERY evolved Pokémon the opponent
 * has in play, de-evolving each by exactly one stage, then shuffle the removed cards into their
 * deck.
 *
 * The removed card is the current top of the stack; the newest entry in `preEvolutions` takes
 * its place and inherits the live attachments, since stacked entries are deliberately kept
 * attachment-free (see stackAsPreEvolution). Damage counters stay on the Pokémon — which is what
 * can make this lethal, so each de-evolved Pokémon is KO-checked against its NEW, lower HP.
 * Special Conditions come off, the same as when a Pokémon evolves.
 */
const alolanVulpixStone: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const oppIdx = (1 - ctx.playerIndex) as 0 | 1;
    const inPlay: { card: GameCard; place: 'active' | number }[] = [];
    if (opp.active) inPlay.push({ card: opp.active, place: 'active' });
    opp.bench.forEach((c, i) => { if (c) inPlay.push({ card: c, place: i }); });

    let deEvolved = 0;
    for (const { card, place } of inPlay) {
      const stack = card.preEvolutions;
      if (!stack || stack.length === 0) continue; // never evolved — nothing to remove

      const newTop = stack[stack.length - 1];
      newTop.preEvolutions = stack.slice(0, -1);
      newTop.attachedEnergy = card.attachedEnergy;
      newTop.attachedTool = card.attachedTool ?? null;
      newTop.damage = card.damage;
      newTop.statusConditions = [];

      card.preEvolutions = undefined;
      card.attachedEnergy = [];
      card.attachedTool = null;
      card.damage = 0;
      card.statusConditions = [];
      opp.deck.push(card);

      if (place === 'active') opp.active = newTop; else opp.bench[place] = newTop;
      deEvolved++;

      const hp = parseInt(newTop.cardData.hp || '0', 10);
      if (hp > 0 && newTop.damage >= hp) handleKo(ctx.G, oppIdx, newTop.id);
    }

    if (deEvolved > 0) shuffleDeck(opp.deck);
    return 'done';
  },
  resume() { return 'done'; },
};

/**
 * 蠱惑挪移 (振翼髮): 「選擇1隻自己的備戰區的「古代」寶可夢，將所選的寶可夢身上放置的傷害指示物，
 * 全部改放於對手的戰鬥寶可夢身上。」 — move every damage counter off one of your own Benched
 * Ancient Pokémon onto the opponent's Active.
 *
 * This was unimplementable until the 古代/未來 subtypes were backfilled: no data source carried
 * them (the label is part of the card artwork), so the Ancient filter matched nothing at all.
 */
const beguilingShift: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const donors = p.bench.filter(
      (c): c is GameCard => c !== null && c.cardData.subtypes.includes('Ancient') && c.damage > 0,
    );
    // An attack with nothing to do is still a legal attack under the real rules, unlike a Trainer
    // — there's no canPlay gate here on purpose.
    if (donors.length === 0) return 'done';
    if (donors.length === 1) { moveCountersToDefender(ctx, donors[0]); return 'done'; }
    return {
      prompt: '蠱惑挪移：選擇要移走傷害指示物的「古代」寶可夢',
      choiceType: 'select_pokemon',
      count: 1,
      options: donors.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const donor = p.bench.find(c => c?.id === selection[0]);
    if (donor) moveCountersToDefender(ctx, donor);
    return 'done';
  },
};

/** Moves every counter off `donor` and onto the defending Active, KO-checking the result. */
function moveCountersToDefender(ctx: EffectContext, donor: GameCard): void {
  const defender = opponent(ctx.G, ctx.playerIndex).active;
  if (!defender) return;
  const moved = donor.damage;
  donor.damage = 0;
  defender.damage += moved;
  const hp = parseInt(defender.cardData.hp || '0', 10);
  if (hp > 0 && defender.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, defender.id);
}

export const attackEffects: Record<string, EffectHandler> = {
  '振翼髮::蠱惑挪移': beguilingShift,
  '多龍巴魯托ex::幻影奇襲': phantomDive,
  '超級蒂安希ex::花冠射線': floralRay,
  '火箭隊的袋獸ex::惡棍衝擊': villainousShock,
  '太陽伊布ex::阿賽斯特萊石': alolanVulpixStone,
};

/** Both halves normalized — a scraped name can carry a zero-width prefix, and a raw-name key
 * would then silently miss its registered handler, which is invisible in testing because the
 * offending character doesn't print (see CLAUDE.md, "Recurring pitfalls"). */
export function attackEffectKey(pokemonName: string, attackName: string): string {
  return `${normalizeCardName(pokemonName)}::${normalizeCardName(attackName)}`;
}

export function hasAttackEffect(pokemonName: string, attackName: string): boolean {
  return attackEffectKey(pokemonName, attackName) in attackEffects;
}

export function startAttackEffect(pokemonName: string, attackName: string, ctx: EffectContext): EffectStep {
  return attackEffects[attackEffectKey(pokemonName, attackName)].start(ctx);
}

export function resumeAttackEffect(pokemonName: string, attackName: string, ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  return attackEffects[attackEffectKey(pokemonName, attackName)].resume(ctx, context, selection);
}
