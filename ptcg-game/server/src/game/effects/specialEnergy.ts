import { GameCard } from '@ptcg/shared';

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
