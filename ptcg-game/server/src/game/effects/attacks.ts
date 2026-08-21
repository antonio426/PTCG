import { GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, normalizeCardName, opponent, player, shuffleDeck } from './types';
import { calculateDamageBreakdown, handleKo } from '../damage';
import { discardAttachedEnergy, hasNoRuleBox } from './primitives';
import { applyAttackOutcome, buildAttackBoard } from '../attackResolution';
import { benchDamageFromEffectsBlocked, isTeraPokemon } from './stadiums';
import { isImmuneToOpponentAttackEffects } from './passiveAbilities';
import { hasTrainerEffect, startTrainerEffect, resumeTrainerEffect } from './trainers';

/**
 * Damage from a registered handler, through the SAME path the generic templates use. It used to
 * call applyWeaknessResistance directly, which skipped everything else calculateDamageBreakdown
 * knows: damage immunity (「不會受到招式的傷害」, Tera bench protection), Tool and passive damage
 * bonuses, timed outgoing nerfs. A 幻影奇襲 through a damage-immune Active still landed 200.
 */
function damageDefenderActive(ctx: EffectContext, baseDamage: number): void {
  const attacker = player(ctx.G, ctx.playerIndex).active;
  const defender = opponent(ctx.G, ctx.playerIndex).active;
  if (!attacker || !defender) return;
  // A handler that resolved to "no damage" means it: bonuses apply to an attack's damage, not to
  // the absence of one (花冠射線 with nothing to discard).
  if (baseDamage <= 0) return;
  const attack = { name: '', cost: [], convertedEnergyCost: 0, damage: String(baseDamage), text: '' };
  const dmg = calculateDamageBreakdown(ctx.G, ctx.playerIndex, attacker, attack, defender).finalDamage;
  defender.damage += dmg;
  if (dmg > 0) defender.damageTakenThisTurn = (defender.damageTakenThisTurn ?? 0) + dmg;
  const hp = parseInt(defender.cardData.hp || '0', 10);
  if (hp > 0 && defender.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, defender.id, attacker);
}

/** 幻影奇襲 (Dragapult ex-style): 200 to the Active, then freely distribute 6 damage counters across the opponent's bench. */
const phantomDive: EffectHandler = {
  start(ctx) {
    damageDefenderActive(ctx, 200);
    return placeNextBenchCounter(ctx, 6);
  },
  resume(ctx, context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const attacker = player(ctx.G, ctx.playerIndex).active;
    const target = opp.bench.find(c => c?.id === selection[0]);
    if (target && !(attacker && isImmuneToOpponentAttackEffects(ctx.G, target, attacker))) {
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
  const attacker = player(ctx.G, ctx.playerIndex).active;
  // Placing damage counters is an attack EFFECT, not attack damage, so the same two protections
  // the generic path honours apply: a Stadium that stops bench damage from effects, and a Pokémon
  // that ignores opponents' attack effects entirely (薄霧能量, 純樸, …).
  if (benchDamageFromEffectsBlocked(ctx.G)) return 'done';
  const targets = opp.bench.filter((c): c is GameCard => c !== null
    && !(attacker && isImmuneToOpponentAttackEffects(ctx.G, c, attacker)));
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
    const attacker = player(ctx.G, ctx.playerIndex).active;
    for (const { card, place } of inPlay) {
      const stack = card.preEvolutions;
      if (!stack || stack.length === 0) continue; // never evolved — nothing to remove
      // 「不會受到對手的寶可夢使用招式的效果的影響」 — de-evolving is an effect, so a protected
      // Pokémon keeps its stage.
      if (attacker && isImmuneToOpponentAttackEffects(ctx.G, card, attacker)) continue;

      const newTop = stack[stack.length - 1];
      newTop.preEvolutions = stack.slice(0, -1);
      newTop.attachedEnergy = card.attachedEnergy;
      newTop.attachedTool = card.attachedTool ?? null;
      newTop.attachedTool2 = card.attachedTool2 ?? null;
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
  const attacker = player(ctx.G, ctx.playerIndex).active;
  if (!defender) return;
  // Relocating damage counters is an attack EFFECT — a protected defender takes none of them,
  // and the donor keeps its own (nothing moved).
  if (attacker && isImmuneToOpponentAttackEffects(ctx.G, defender, attacker)) return;
  const moved = donor.damage;
  donor.damage = 0;
  defender.damage += moved;
  const hp = parseInt(defender.cardData.hp || '0', 10);
  if (hp > 0 && defender.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, defender.id);
}


/**
 * 「選擇1個…持有的招式，作為這個招式使用」 — resolve another Pokémon's attack as if this one had
 * used it. Shared by 呆呆王's 耀閃挑戰, N的索羅亞克ex's 暗黑底牌 and 火箭隊的謎擬Q's 扮晶晶酒.
 *
 * The copied attack is resolved against the CURRENT board with THIS Pokémon as the attacker, so
 * weakness, the defender and every board-scaled template read the real situation. Its energy cost
 * is deliberately not checked: the printed text grants the use outright, the cost was already
 * paid for the attack that copied it.
 */
function useCopiedAttack(ctx: EffectContext, source: GameCard, attackIndex: number): void {
  const attack = source.cardData.attacks?.[attackIndex];
  if (!attack) return;
  const p = player(ctx.G, ctx.playerIndex);
  const opp = opponent(ctx.G, ctx.playerIndex);
  if (!p.active || !opp.active) return;
  const board = buildAttackBoard(ctx.G, p, opp, p.active, opp.active, attack);
  applyAttackOutcome(ctx.G, p, opp, p.active, opp.active, attack, board);
}

/** Attacks a copy effect may offer: anything the donor actually prints. */
function copyableAttackOptions(donor: GameCard): { id: string; label: string }[] {
  return (donor.cardData.attacks ?? []).map((a, i) => ({
    id: String(i),
    label: `${donor.cardData.name}：${a.name}${a.damage ? `（${a.damage}）` : ''}`,
  }));
}

/** 耀閃挑戰 (呆呆王): discard the top deck card; if it's a Pokémon without a rule box, use one of its attacks. */
const dazzlingChallenge: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.pop();
    if (!top) return 'done';
    p.discardPile.push(top);
    if (top.cardData.supertype !== 'Pokémon' || !hasNoRuleBox(top)) return 'done';
    const options = copyableAttackOptions(top);
    if (options.length === 0) return 'done';
    if (options.length === 1) { useCopiedAttack(ctx, top, 0); return 'done'; }
    return {
      prompt: `耀閃挑戰：選擇要使用的「${top.cardData.name}」招式`,
      choiceType: 'select_from_list',
      count: 1,
      options,
      context: { donorId: top.id },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const donor = p.discardPile.find(c => c.id === context.donorId);
    if (donor) useCopiedAttack(ctx, donor, parseInt(selection[0], 10));
    return 'done';
  },
};

/** Shared shape for "pick a Pokémon from a set, then use one of its attacks". */
function copyFromPokemon(
  promptLabel: string,
  donors: (ctx: EffectContext) => GameCard[],
): EffectHandler {
  const findDonor = (ctx: EffectContext, id: string) => donors(ctx).find(c => c.id === id);
  return {
    start(ctx) {
      const list = donors(ctx).filter(c => (c.cardData.attacks?.length ?? 0) > 0);
      if (list.length === 0) return 'done';
      if (list.length === 1) {
        const options = copyableAttackOptions(list[0]);
        if (options.length === 1) { useCopiedAttack(ctx, list[0], 0); return 'done'; }
        return {
          prompt: `${promptLabel}：選擇要使用的招式`,
          choiceType: 'select_from_list',
          count: 1,
          options,
          context: { donorId: list[0].id },
        };
      }
      return {
        prompt: `${promptLabel}：選擇要借用招式的寶可夢`,
        choiceType: 'select_pokemon',
        count: 1,
        options: list.map(c => ({ id: c.id, label: c.cardData.name })),
        context: { step: 'pick_donor' },
      };
    },
    resume(ctx, context, selection) {
      if (context.step === 'pick_donor') {
        const donor = findDonor(ctx, selection[0]);
        if (!donor) return 'done';
        const options = copyableAttackOptions(donor);
        if (options.length === 1) { useCopiedAttack(ctx, donor, 0); return 'done'; }
        return {
          prompt: `${promptLabel}：選擇要使用的招式`,
          choiceType: 'select_from_list',
          count: 1,
          options,
          context: { donorId: donor.id },
        };
      }
      const donor = findDonor(ctx, context.donorId as string);
      if (donor) useCopiedAttack(ctx, donor, parseInt(selection[0], 10));
      return 'done';
    },
  };
}

/**
 * 「將那個效果作為這個招式的效果使用」 — run a Supporter's own registered effect from inside an
 * attack. The Supporter may itself need choices, and those must come back to IT rather than to the
 * attack that borrowed it, so the delegation is recorded in the choice's context and every resume
 * is forwarded on. Both cards below are the effect ONLY: no card is played, so nothing is
 * discarded and supporterPlayedThisTurn is untouched.
 */
function useSupporterEffect(ctx: EffectContext, supporterName: string): EffectStep {
  if (!hasTrainerEffect(supporterName)) return 'done';
  const step = startTrainerEffect(supporterName, ctx);
  return step === 'done' ? 'done' : { ...step, context: { delegate: supporterName, inner: step.context } };
}

function resumeDelegated(ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  const name = context.delegate as string;
  const step = resumeTrainerEffect(name, ctx, (context.inner as Record<string, unknown>) || {}, selection);
  return step === 'done' ? 'done' : { ...step, context: { delegate: name, inner: step.context } };
}

/**
 * 相仿秀 (魔牆人偶): 「查看對手的手牌。若希望，選擇1張其中的支援者卡，將那個效果作為這個招式的效果
 * 使用。」 The options are cards in the opponent's HAND, which this text explicitly reveals — the
 * one situation revealsOpponentHand exists for.
 */
const copycatShow: EffectHandler = {
  start(ctx) {
    const supporters = opponent(ctx.G, ctx.playerIndex).hand.filter(c =>
      c.cardData.supertype === 'Trainer' && c.cardData.subtypes.includes('Supporter')
      && hasTrainerEffect(normalizeCardName(c.cardData.name)));
    if (supporters.length === 0) return 'done';
    return {
      prompt: '相仿秀：選擇1張對手手牌中的支援者卡，使用其效果（可不選）',
      choiceType: 'select_from_list',
      minCount: 0,
      maxCount: 1,
      options: supporters.map(c => ({ id: c.id, label: c.cardData.name })),
      revealsOpponentHand: true,
      context: { step: 'pick' },
    };
  },
  resume(ctx, context, selection) {
    if (context.delegate) return resumeDelegated(ctx, context, selection);
    const picked = opponent(ctx.G, ctx.playerIndex).hand.find(c => c.id === selection[0]);
    if (!picked) return 'done';
    return useSupporterEffect(ctx, normalizeCardName(picked.cardData.name));
  },
};

/**
 * 靈怪變化 (九尾): 「將自己的牌庫上方1張卡丟棄，若那張卡為支援者卡，則將那個效果作為這個招式的效果
 * 使用。」 The 60 damage is printed on the attack and lands either way.
 */
const spookyShift: EffectHandler = {
  start(ctx) {
    damageDefenderActive(ctx, 60);
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.pop();
    if (!top) return 'done';
    p.discardPile.push(top);
    if (top.cardData.supertype !== 'Trainer' || !top.cardData.subtypes.includes('Supporter')) return 'done';
    return useSupporterEffect(ctx, normalizeCardName(top.cardData.name));
  },
  resume(ctx, context, selection) {
    return context.delegate ? resumeDelegated(ctx, context, selection) : 'done';
  },
};

/**
 * 技能大盜 (狐大盜): 「若自己1張手牌都沒有，則選擇1個對手的場上寶可夢持有的招式，作為這個招式使用。」
 * 「作為這個招式使用」 replaces this attack, so the borrowed attack's own damage is what lands —
 * the printed 80 is what happens when the hand ISN'T empty, the same way 耀閃挑戰/扮晶晶酒 treat a
 * copy as a substitution rather than an addition.
 */
const skillThief: EffectHandler = {
  start(ctx) {
    if (player(ctx.G, ctx.playerIndex).hand.length > 0) { damageDefenderActive(ctx, 80); return 'done'; }
    return stealFromOpponentField.start(ctx);
  },
  resume(ctx, context, selection) {
    return stealFromOpponentField.resume(ctx, context, selection);
  },
};

/** 暗黑底牌 (N的索羅亞克ex): use an attack from one of your Benched 「N的」 Pokémon. */
const darkTrumpCard = copyFromPokemon('暗黑底牌', ctx =>
  player(ctx.G, ctx.playerIndex).bench.filter(
    (c): c is GameCard => c !== null && c.cardData.name.includes('N的'),
  ));

/** 扮晶晶酒 (火箭隊的謎擬Q): use an attack from the opponent's Active, if it's a 太晶 Pokémon. */
const teraMimicry = copyFromPokemon('扮晶晶酒', ctx => {
  const oppActive = opponent(ctx.G, ctx.playerIndex).active;
  return oppActive && isTeraPokemon(oppActive) ? [oppActive] : [];
});

/**
 * Attacks whose text does something beyond flat weakness/resistance damage
 * (bench damage distribution, discard-for-damage, self-damage, etc.) are
 * keyed by "寶可夢名稱::招式名稱" since the same attack name can appear on
 * different Pokémon with different costs. Only attacks with non-empty
 * `attack.text` need an entry here — plain flat-damage attacks (the vast
 * majority) are handled by the existing calculateDamage() path untouched.
 */
/** The donor pool for 技能大盜: everything the opponent has in play. */
const stealFromOpponentField = copyFromPokemon('技能大盜', ctx => {
  const opp = opponent(ctx.G, ctx.playerIndex);
  return [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
});

export const attackEffects: Record<string, EffectHandler> = {
  '振翼髮::蠱惑挪移': beguilingShift,
  '呆呆王::耀閃挑戰': dazzlingChallenge,
  'N的索羅亞克ex::暗黑底牌': darkTrumpCard,
  '火箭隊的謎擬Q::扮晶晶酒': teraMimicry,
  '多龍巴魯托ex::幻影奇襲': phantomDive,
  '超級蒂安希ex::花冠射線': floralRay,
  '火箭隊的袋獸ex::惡棍衝擊': villainousShock,
  '太陽伊布ex::阿賽斯特萊石': alolanVulpixStone,
  '魔牆人偶::相仿秀': copycatShow,
  '九尾::靈怪變化': spookyShift,
  '狐大盜::技能大盜': skillThief,
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
