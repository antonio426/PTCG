import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { toolsAreDisabled } from './stadiums';
import { normalizeCardName } from './types';

/** Non-rule-box Pokémon: no ex/V/VMAX/VSTAR/GX/Radiant/Mega subtype or name prefix. Duplicated
 * from primitives.ts's identical helper to avoid a tools.ts -> primitives.ts -> damage.ts ->
 * tools.ts import cycle (damage.ts needs getToolDamageBonus from this file). */
function hasNoRuleBox(card: GameCard): boolean {
  const subs = card.cardData.subtypes || [];
  const ruleBoxSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'Radiant', 'TAG TEAM'];
  if (subs.some(s => ruleBoxSubtypes.includes(s))) return false;
  if (card.cardData.name.startsWith('超級')) return false;
  return true;
}

/**
 * Pokémon Tool cards are persistent: once attached they stay on the Pokémon and
 * are queried by other systems (retreat cost, attack cost) rather than firing a
 * one-shot effect like Items/Supporters do. Unlike trainers.ts/abilities.ts this
 * registry is computed on demand, not resolved through a PendingChoice.
 */
export interface ToolEffect {
  /** Flat reduction to retreat cost (in energy count). */
  retreatCostReduction?(card: GameCard): number;
  /** If true, retreat cost is waived entirely this check. */
  retreatCostWaived?(card: GameCard): boolean;
  /** Flat reduction to a Colorless attack-cost requirement, given the owner's player index. */
  colorlessCostReduction?(card: GameCard, G: PtcgGameState, ownerIdx: 0 | 1): number;
  /** Extra max HP granted while attached. */
  hpBonus?: number;
  /** Extra damage `card` (the Tool's holder) deals when attacking `defender`. */
  damageBonus?(card: GameCard, defender: GameCard): number;
  /** Damage counters placed on the attacker when `card` (the Tool's holder) takes attack damage. */
  retaliationDamage?(card: GameCard): number;
}

const toolEffects: Record<string, ToolEffect> = {
  '氣球': { retreatCostReduction: () => 2 },
  '英雄斗篷': { hpBonus: 100 },
  '緊急滑板': {
    retreatCostReduction: () => 1,
    retreatCostWaived: (card) => {
      const hp = parseInt(card.cardData.hp || '0', 10);
      const remaining = hp - card.damage;
      return hp > 0 && remaining <= 30;
    },
  },
  '反擊增幅器': {
    colorlessCostReduction: (_card, G, ownerIdx) => {
      const own = G.players[ownerIdx].prizes.length;
      const opp = G.players[(1 - ownerIdx) as 0 | 1].prizes.length;
      return own > opp ? 1 : 0; // behind on prizes (more remaining) = discount, a comeback mechanic
    },
  },
  '猛攻手鐲': {
    // "附有這張卡的寶可夢（『擁有規則的寶可夢』除外）...+30" — only benefits a non-rule-box holder.
    damageBonus: (card, defender) => (hasNoRuleBox(card) && !hasNoRuleBox(defender) ? 30 : 0),
  },
  '電氣球': {
    damageBonus: (card, defender) => (card.cardData.name === '皮卡丘ex' && !hasNoRuleBox(defender) ? 50 : 0),
  },
  '龐克頭盔': {
    retaliationDamage: (card) => ((card.cardData.types || []).includes('Darkness') ? 4 : 0),
  },
};

export function hasToolEffect(name: string): boolean {
  return normalizeCardName(name) in toolEffects;
}

export function getRetreatCostReduction(G: PtcgGameState, card: GameCard): { reduction: number; waived: boolean } {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return { reduction: 0, waived: false };
  const effect = toolEffects[normalizeCardName(tool.cardData.name)];
  if (!effect) return { reduction: 0, waived: false };
  return {
    reduction: effect.retreatCostReduction?.(card) ?? 0,
    waived: effect.retreatCostWaived?.(card) ?? false,
  };
}

export function getColorlessCostReduction(G: PtcgGameState, card: GameCard, ownerIdx: 0 | 1): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  const effect = toolEffects[normalizeCardName(tool.cardData.name)];
  return effect?.colorlessCostReduction?.(card, G, ownerIdx) ?? 0;
}

export function getToolHpBonus(G: PtcgGameState, card: GameCard): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  return toolEffects[normalizeCardName(tool.cardData.name)]?.hpBonus ?? 0;
}

export function getToolDamageBonus(G: PtcgGameState, card: GameCard, defender: GameCard): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  return toolEffects[normalizeCardName(tool.cardData.name)]?.damageBonus?.(card, defender) ?? 0;
}

export function getToolRetaliationDamage(G: PtcgGameState, card: GameCard): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  return toolEffects[tool.cardData.name]?.retaliationDamage?.(card) ?? 0;
}
