import { GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, opponent, player } from './types';
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

export const attackEffects: Record<string, EffectHandler> = {
  '多龍巴魯托ex::幻影奇襲': phantomDive,
  '超級蒂安希ex::花冠射線': floralRay,
};

export function attackEffectKey(pokemonName: string, attackName: string): string {
  return `${pokemonName}::${attackName}`;
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
