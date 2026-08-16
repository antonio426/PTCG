export type EnergyType = 'Grass' | 'Fire' | 'Water' | 'Lightning' | 'Psychic'
  | 'Fighting' | 'Darkness' | 'Metal' | 'Fairy' | 'Dragon' | 'Colorless';

export type Supertype = 'Pokémon' | 'Trainer' | 'Energy';

export type Subtype = 'Basic' | 'Stage 1' | 'Stage 2' | 'V' | 'VMAX' | 'VSTAR'
  | 'GX' | 'EX' | 'ex' | 'Mega' | 'Radiant' | 'TAG TEAM'
  | 'Item' | 'Supporter' | 'Stadium' | 'Pokémon Tool' | 'Pokémon Tool F'
  | 'Special Energy' | 'Basic Energy'
  | 'Ancient' | 'Future' | 'Rapid Strike' | 'Single Strike' | 'Fusion Strike';

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

export interface Card {
  id: string;
  name: string;
  supertype: Supertype;
  subtypes: Subtype[];
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
  legalities: {
    standard?: 'Legal' | 'Banned';
    expanded?: 'Legal' | 'Banned';
    unlimited?: 'Legal' | 'Banned';
  };
  regulationMark?: string;
  images: CardImages;
  count?: number;
  quantity?: number;
  /** Set only on the synthesized Pokémon-shaped view of a "陳舊的○○化石" Item card once it's in
   * play (see server/src/game/fossils.ts) — real rules: immune to all Special Conditions and
   * cannot retreat, regardless of the 0 retreat cost that view is given. The original card in
   * hand/deck/discard is an ordinary Trainer/Item and never carries this flag. */
  isFossil?: boolean;
}

export interface EnergyCard extends Card {
  supertype: 'Energy';
  subtypes: Subtype[];
}

export interface PokemonCard extends Card {
  supertype: 'Pokémon';
  subtypes: Subtype[];
  hp: string;
  types: EnergyType[];
  attacks: Attack[];
  weaknesses: WeaknessResistance[];
  resistances?: WeaknessResistance[];
  retreatCost: EnergyType[];
  convertedRetreatCost: number;
}

export interface TrainerCard extends Card {
  supertype: 'Trainer';
  subtypes: Subtype[];
  rules: string[];
}
