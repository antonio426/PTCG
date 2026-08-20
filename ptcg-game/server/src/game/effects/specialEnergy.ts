import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';

/**
 * What a piece of attached Energy actually pays for.
 *
 * A basic Energy is one unit of its own type, which is what `AttachedEnergy.type` has always
 * modelled. Special Energy doesn't fit that: 火箭隊能量 provides TWO units that each count as
 * either 【超】 or 【惡】, 古舊能量 provides one unit of every type at once, and 稜鏡能量 /
 * 新衝天能量 / 燃火能量 change what they provide depending on the Pokémon holding them. Reading a
 * single `type` string meant every one of those was silently just one Colorless.
 *
 * Driven off the card's printed text rather than a per-card registry, so a new Special Energy
 * printed in the same wording works without a code change. The texts themselves were missing from
 * both data sources until backfill-special-energy-text.ts pulled them off the official page.
 */

export const ALL_ENERGY_TYPES = [
  'Grass', 'Fire', 'Water', 'Lightning', 'Psychic',
  'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless',
] as const;

const ZH_TO_TYPE: Record<string, string> = {
  無: 'Colorless', 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning',
  超: 'Psychic', 鬥: 'Fighting', 惡: 'Darkness', 鋼: 'Metal', 妖: 'Fairy', 龍: 'Dragon',
};

/** One energy's worth of payment, and which cost symbols it can be spent on. */
export interface EnergyUnit {
  /** Types this unit satisfies. A unit covering every type is a wildcard (古舊能量, 稜鏡能量 …). */
  types: string[];
}

const wildcard = (): EnergyUnit => ({ types: [...ALL_ENERGY_TYPES] });

/** 「視為提供N個…」 clauses, in the two shapes the current pool prints. */
function parseProvision(clause: string): EnergyUnit[] | null {
  // 「視為提供1個所有屬性的能量」 / 「視為提供2個所有屬性的能量」
  let m = clause.match(/視為提供(\d+)個所有屬性的能量/);
  if (m) return Array.from({ length: parseInt(m[1], 10) }, wildcard);

  // 「視為提供2個【超】【惡】2種屬性的能量」 — N units, each payable as any of the listed types.
  m = clause.match(/視為提供(\d+)個((?:【.】)+)\d+種屬性的能量/);
  if (m) {
    const types = [...m[2].matchAll(/【(.)】/g)].map(x => ZH_TO_TYPE[x[1]]).filter(Boolean);
    if (types.length) return Array.from({ length: parseInt(m[1], 10) }, () => ({ types }));
  }

  // 「視為提供1個【無】能量」 / 「視為提供3個【無】能量」
  m = clause.match(/視為提供(\d+)個【(.)】能量/);
  if (m) {
    const type = ZH_TO_TYPE[m[2]];
    if (type) return Array.from({ length: parseInt(m[1], 10) }, () => ({ types: [type] }));
  }
  return null;
}

/** Whether the 「若附於X寶可夢身上」 condition in a clause holds for the Pokémon carrying the card. */
function conditionHolds(clause: string, holder: GameCard): boolean {
  const subs = holder.cardData.subtypes ?? [];
  if (/若附於【2階進化】寶可夢身上/.test(clause)) return subs.includes('Stage 2');
  if (/若附於【基礎】寶可夢身上/.test(clause)) return subs.includes('Basic');
  if (/若附於進化寶可夢身上/.test(clause)) return subs.includes('Stage 1') || subs.includes('Stage 2');
  return false;
}

/**
 * The units `energy` pays for while attached to `holder`.
 *
 * Falls back to the flat `AttachedEnergy.type` whenever the card has no parseable provision text,
 * which covers every basic Energy and any Special Energy whose text hasn't been backfilled — the
 * previous behaviour, so nothing regresses when the data is incomplete.
 */
export function energyUnitsProvided(
  energy: { type: string; cardData?: GameCard['cardData'] },
  holder: GameCard,
): EnergyUnit[] {
  const rules = energy.cardData?.rules ?? [];
  if (energy.cardData?.subtypes?.includes('Special Energy') && rules.length) {
    const text = rules.join('');
    // A conditional clause REPLACES the base one when it applies ("若附於…則視為提供…"), so check
    // it first and only fall back to the unconditional reading.
    for (const clause of text.split('。')) {
      if (!/若附於/.test(clause)) continue;
      if (!conditionHolds(clause, holder)) continue;
      const units = parseProvision(clause);
      if (units) return units;
    }
    for (const clause of text.split('。')) {
      if (/若附於/.test(clause)) continue;
      const units = parseProvision(clause);
      if (units) return units;
    }
  }
  return [{ types: [energy.type] }];
}

/** Every unit on a Pokémon, flattened — what an attack cost is actually paid from. */
export function energyUnitsOn(holder: GameCard): EnergyUnit[] {
  return holder.attachedEnergy.flatMap(e => energyUnitsProvided(e, holder));
}

/** Does `holder` carry a Special Energy printed with this exact name? */
export function hasSpecialEnergy(holder: GameCard, name: string): boolean {
  return holder.attachedEnergy.some(e =>
    e.cardData?.subtypes?.includes('Special Energy')
    && String(e.cardData.name).replace(/^[‌​\s]+/, '').trim() === name);
}

const holderTypes = (holder: GameCard) => holder.cardData.types ?? [];

/** 增強【草】能量: 「附有這張卡的【草】寶可夢的最大HP「+20」」 */
export function specialEnergyMaxHpBonus(holder: GameCard): number {
  return hasSpecialEnergy(holder, '增強【草】能量') && holderTypes(holder).includes('Grass') ? 20 : 0;
}

/** 磁鐵【鋼】能量: 「附有這張卡的【鋼】寶可夢【撤退】所需的能量全部消除」 */
export function specialEnergyWaivesRetreat(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '磁鐵【鋼】能量') && holderTypes(holder).includes('Metal');
}

/** 伏特【雷】能量: 「附有這張卡的【雷】寶可夢使用的招式…傷害「+20」點」 */
export function specialEnergyDamageBonus(attacker: GameCard): number {
  return hasSpecialEnergy(attacker, '伏特【雷】能量') && holderTypes(attacker).includes('Lightning') ? 20 : 0;
}

/** 暗影【惡】能量: 「只要附有這張卡的【惡】寶可夢在備戰區，不會受到對手的招式的傷害」 */
export function specialEnergyBlocksBenchedDamage(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '暗影【惡】能量') && holderTypes(holder).includes('Darkness');
}

/** 泡沫【水】能量: 「附有這張卡的【水】寶可夢不會陷入特殊狀態，並將受到的特殊狀態全部恢復」 */
export function specialEnergyBlocksStatus(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '泡沫【水】能量') && holderTypes(holder).includes('Water');
}

/**
 * 扣殺能量: 「附有這張卡的寶可夢在戰鬥場受到對手的寶可夢招式的傷害時，在使用招式的寶可夢身上放置
 * 2個傷害指示物」 — damage counters, so 20 damage, dealt back to the attacker.
 */
export function specialEnergyRetaliation(defender: GameCard): number {
  return hasSpecialEnergy(defender, '扣殺能量') ? 20 : 0;
}

/**
 * 薄霧能量 / 硬岩【鬥】能量: 「不會受到對手的寶可夢使用招式的效果的影響」. 硬岩 additionally
 * requires the holder to be a 【鬥】 Pokémon; 薄霧 applies to whatever carries it.
 */
export function specialEnergyBlocksAttackEffects(holder: GameCard): boolean {
  if (hasSpecialEnergy(holder, '薄霧能量')) return true;
  return hasSpecialEnergy(holder, '硬岩【鬥】能量') && holderTypes(holder).includes('Fighting');
}

/**
 * 古舊能量: 「受到對手的寶可夢招式的傷害而【昏厥】時，被獲得的獎賞卡減少1張。對戰中，自己的
 * 「古舊能量」的這個效果只生效1次。」 — the once-per-GAME limit is tracked on the player, not the
 * card, since the text scopes it to 自己的「古舊能量」 as a whole rather than to one copy.
 */
export function specialEnergyPrizeReduction(koCard: GameCard): number {
  return hasSpecialEnergy(koCard, '古舊能量') ? 1 : 0;
}

/**
 * 燃火能量: 「將附於寶可夢身上的這張卡，在自己的回合結束時丟棄」 — discards itself off every
 * Pokémon that player controls at the end of their own turn. The card goes to the discard pile
 * rather than vanishing, same as any other energy leaving a Pokémon.
 */
export function discardBurnoutEnergy(G: PtcgGameState, playerIdx: 0 | 1): void {
  const p = G.players[playerIdx];
  for (const card of [p.active, ...p.bench]) {
    if (!card) continue;
    for (let i = card.attachedEnergy.length - 1; i >= 0; i--) {
      const e = card.attachedEnergy[i];
      if (!hasSpecialEnergyName(e, '燃火能量')) continue;
      card.attachedEnergy.splice(i, 1);
      if (e.cardData) {
        p.discardPile.push({
          id: e.id, cardData: e.cardData, owner: playerIdx,
          damage: 0, statusConditions: [], attachedEnergy: [],
        });
      }
    }
  }
}

/** Named-card check on a raw attachment (no holding Pokémon needed). */
function hasSpecialEnergyName(energy: { cardData?: GameCard['cardData'] }, name: string): boolean {
  return !!energy.cardData?.subtypes?.includes('Special Energy')
    && String(energy.cardData.name).replace(/^[‌​\s]+/, '').trim() === name;
}
