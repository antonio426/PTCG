import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { toolsAreDisabled } from './stadiums';

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
}

const toolEffects: Record<string, ToolEffect> = {
  '氣球': { retreatCostReduction: () => 2 },
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
};

export function hasToolEffect(name: string): boolean {
  return name in toolEffects;
}

export function getRetreatCostReduction(G: PtcgGameState, card: GameCard): { reduction: number; waived: boolean } {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return { reduction: 0, waived: false };
  const effect = toolEffects[tool.cardData.name];
  if (!effect) return { reduction: 0, waived: false };
  return {
    reduction: effect.retreatCostReduction?.(card) ?? 0,
    waived: effect.retreatCostWaived?.(card) ?? false,
  };
}

export function getColorlessCostReduction(G: PtcgGameState, card: GameCard, ownerIdx: 0 | 1): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  const effect = toolEffects[tool.cardData.name];
  return effect?.colorlessCostReduction?.(card, G, ownerIdx) ?? 0;
}

export function getToolHpBonus(G: PtcgGameState, card: GameCard): number {
  const tool = card.attachedTool;
  if (!tool || toolsAreDisabled(G)) return 0;
  return toolEffects[tool.cardData.name]?.hpBonus ?? 0;
}
