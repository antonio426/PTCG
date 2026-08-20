import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { specialEnergyBlocksStatus } from './specialEnergy';

/** The default Bench size; 零之大空洞 is the only thing that changes it (see benchLimit). */
export const DEFAULT_BENCH_SIZE = 5;

/** 太晶 (Terastallization): every Tera print in this dataset carries the same fixed rules text
 * bundled into one of its attacks rather than as a separate ability. Lives here rather than in
 * passiveAbilities.ts because that module already imports this one — keeping the predicate on
 * this side is what stops 零之大空洞's bench-limit query from creating an import cycle. */
export function isTeraPokemon(card: GameCard): boolean {
  return !!card.cardData.attacks?.some(a => a.text?.trim() === '只要這隻寶可夢在備戰區，不會受到招式的傷害。');
}

/**
 * Like Tool cards, Stadiums are persistent field effects queried on demand
 * rather than resolved once through a PendingChoice. Only one Stadium is ever
 * in play (see GameState.activeStadium); entering/leaving play is handled
 * generically in moves.ts, same pattern as Tool attachment.
 */
export function isStadiumActive(G: PtcgGameState, name: string): boolean {
  return G.activeStadium?.cardData.name === name;
}

/** 阻礙之塔 Blocking Tower: cancels every Pokémon Tool's effect while it's in play. */
export function toolsAreDisabled(G: PtcgGameState): boolean {
  return isStadiumActive(G, '阻礙之塔');
}

/** 對戰圓形競技場 Battle VS Arena: while in play, Benched Pokémon on both sides can't have
 * damage counters placed on them by the OPPONENT's attack-effect or ability-effect ("spread")
 * damage — printed text explicitly carves out direct attack damage ("[會受到招式的傷害。]"), but
 * this codebase's attack model always resolves an attack's own damage against the defending
 * Active (see moves.ts's `attack`), never the bench directly — every existing bench-damage code
 * path already IS one of the "effect" kinds this card blocks, so gating all of them is a complete
 * and correct implementation, not an approximation. */
export function benchDamageFromEffectsBlocked(G: PtcgGameState): boolean {
  return isStadiumActive(G, '對戰圓形競技場');
}

/** 祭典會場 Festival Plaza: 「雙方的所有身上附有能量卡的寶可夢不會陷入特殊狀態，並將受到的特殊
 * 狀態全部恢復。」 — a Pokémon on EITHER side with at least one Energy attached is immune to
 * Special Conditions. */
export function immuneToStatusByStadium(G: PtcgGameState, card: { attachedEnergy: unknown[] }): boolean {
  return isStadiumActive(G, '祭典會場') && card.attachedEnergy.length > 0;
}

/**
 * The "並將受到的特殊狀態全部恢復" half: clear Special Conditions off every energy-bearing Pokémon
 * on both sides. `immuneToStatusByStadium` stops new ones landing, so this only has to cover the
 * two ways an already-Conditioned Pokémon can come to satisfy the card's requirement — the
 * Stadium entering play, and Energy being attached to an already-afflicted Pokémon. Call it at
 * both, plus once per turn transition as a backstop.
 */
/**
 * 零之大空洞 Area Zero Underdepths: 「自己的場上有「太晶」寶可夢的玩家的可放置於備戰區的寶可夢
 * 數量改為8隻。」 — the larger Bench is per player and conditional on that player having a Tera
 * Pokémon in play, so both sides can have different limits at the same time.
 */
export function benchLimit(G: PtcgGameState, playerIndex: 0 | 1): number {
  if (!isStadiumActive(G, '零之大空洞')) return DEFAULT_BENCH_SIZE;
  const p = G.players[playerIndex];
  const hasTera = [p.active, ...p.bench].some(c => c !== null && isTeraPokemon(c));
  return hasTera ? 8 : DEFAULT_BENCH_SIZE;
}

/**
 * The bracketed half of 零之大空洞: 「這張卡被丟棄時，或自己的場上沒有了「太晶」寶可夢時，將備戰區
 * 的寶可夢丟棄直到變為5隻為止。」 — so the limit has to be re-enforced whenever the Stadium leaves
 * or a player's last Tera Pokémon does, not just checked when playing a Pokémon.
 *
 * Simplification: the printed text lets the player choose which to discard (and fixes the order
 * when both must). This discards from the highest Bench slot down, i.e. most-recently-placed
 * first, which is deterministic and needs no prompt. The whole stack goes, as with any Pokémon
 * permanently leaving play.
 */
export function enforceBenchLimit(G: PtcgGameState, flushPreEvolutions: (card: GameCard, zone: GameCard[]) => void): void {
  for (let idx = 0 as 0 | 1; idx <= 1; idx = (idx + 1) as 0 | 1) {
    const p = G.players[idx];
    const limit = benchLimit(G, idx);
    for (let i = p.bench.length - 1; i >= 0 && p.bench.filter(c => c !== null).length > limit; i--) {
      const card = p.bench[i];
      if (!card) continue;
      flushPreEvolutions(card, p.discardPile);
      if (card.attachedTool) p.discardPile.push(card.attachedTool);
      for (const energy of card.attachedEnergy.splice(0)) {
        if (energy.cardData) {
          p.discardPile.push({ id: energy.id, cardData: energy.cardData, owner: idx, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
      }
      card.attachedTool = null;
      card.damage = 0;
      card.statusConditions = [];
      p.discardPile.push(card);
      p.bench[i] = null;
    }
    // Shrink the array back once the extra slots aren't granted any more, so nothing downstream
    // sees a Bench longer than the current limit.
    if (p.bench.length > limit) p.bench.length = Math.max(limit, p.bench.filter(c => c !== null).length);
  }
}

export function sweepStadiumStatusCures(G: PtcgGameState): void {
  const plazaOut = isStadiumActive(G, '祭典會場');
  for (const p of G.players) {
    for (const card of [p.active, ...p.bench]) {
      if (!card || card.statusConditions.length === 0) continue;
      // 祭典會場 cures anything holding Energy; 泡沫【水】能量 cures the Water Pokémon carrying it
      // (「並將受到的特殊狀態全部恢復」). Identical shape, so one sweep covers both.
      if ((plazaOut && card.attachedEnergy.length > 0) || specialEnergyBlocksStatus(card)) {
        card.statusConditions = [];
      }
    }
  }
}
