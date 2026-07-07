export type EnergyType = 'Grass' | 'Fire' | 'Water' | 'Lightning' | 'Psychic'
  | 'Fighting' | 'Darkness' | 'Metal' | 'Fairy' | 'Dragon' | 'Colorless';

export type Supertype = 'Pokémon' | 'Trainer' | 'Energy';

export type Subtype = 'Basic' | 'Stage 1' | 'Stage 2' | 'V' | 'VMAX' | 'VSTAR'
  | 'GX' | 'EX' | 'ex' | 'Mega' | 'Radiant' | 'TAG TEAM'
  | 'Item' | 'Supporter' | 'Stadium' | 'Pokémon Tool' | 'Pokémon Tool F'
  | 'Special Energy' | 'Basic Energy'
  | 'Ancient' | 'Future' | 'Rapid Strike' | 'Single Strike' | 'Fusion Strike'
  | 'Level-Up' | 'BREAK' | 'Baby' | 'RESTORED' | 'LEGEND' | 'Pokémon SP';

export interface Attack {
  name: string;
  cost: EnergyType[];
  convertedEnergyCost: number;
  damage: string;
  text: string;
}

export interface Ability {
  name: string;
  text: string;
  type: 'Ability' | 'Pokémon-Power' | 'Poké-Body' | 'Poké-Power';
}

export interface WeaknessResistance {
  type: EnergyType;
  value: string;
}

export interface CardSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
}

export interface CardImages {
  small: string;
  large: string;
}

export interface MapCard {
  id: string;
  name: string;
  supertype: Supertype;
  subtypes: Subtype[];
  /** @internal Set to true after enrichment fetches detail data from TCGdex API */
  _enriched?: boolean;
  hp?: string;
  types?: EnergyType[];
  evolvesFrom?: string;
  evolvesTo?: string[];
  rules?: string[];
  abilities?: Ability[];
  attacks?: Attack[];
  weaknesses?: WeaknessResistance[];
  resistances?: WeaknessResistance[];
  retreatCost?: EnergyType[];
  convertedRetreatCost?: number;
  set: CardSet;
  number: string;
  artist?: string;
  rarity?: string;
  flavorText?: string;
  nationalPokedexNumbers?: number[];
  legalities: { standard?: 'Legal' | 'Banned'; expanded?: 'Legal' | 'Banned'; unlimited?: 'Legal' | 'Banned' };
  regulationMark?: string;
  images: CardImages;
  localId?: string;
  count?: number;
  quantity?: number;
}

export interface SetData {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  symbol?: string;
  logo?: string;
  legal?: { standard: boolean; expanded: boolean };
}

export interface TcgdexCardSummary {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

export interface TcgdexCardDetail {
  id: string;
  localId: string;
  name: string;
  image?: string;
  category?: string;
  illustrator?: string;
  rarity?: string;
  set?: { id: string; name: string; cardCount: { total: number; official: number } };
  dexId?: number[];
  hp?: number;
  types?: string[];
  description?: string;
  stage?: string;
  suffix?: string;
  evolveFrom?: string;
  evolveTo?: string[];
  abilities?: { name: string; effect: string; type: string }[];
  attacks?: { name: string; cost: string[]; damage: number | string; effect: string }[];
  weaknesses?: { type: string; value: string }[];
  resistances?: { type: string; value: string }[];
  retreat?: number;
  trainerType?: string;
  energyType?: string;
  regulationMark?: string;
  legal?: { standard?: boolean; expanded?: boolean };
  variants?: Record<string, boolean>;
  updated?: string;
}

export interface TcgdexSet {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount: { total: number; official: number };
  releaseDate?: string;
  series?: string;
  serie?: { id: string; name: string };
  legal?: { standard: boolean; expanded: boolean };
}

export interface CacheData<T> {
  timestamp: number;
  data: T;
}
