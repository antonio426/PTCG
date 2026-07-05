export const MAX_HAND_SIZE = 7;
export const MAX_BENCH_SIZE = 5;
export const MAX_PRIZES = 6;
export const MAX_DECK_SIZE = 60;
export const MIN_DECK_SIZE = 60;
export const MAX_COPIES_PER_CARD = 4;
export const MAX_ENERGY_PER_TURN = 1;
export const MAX_TRAINER_PER_TURN = 1;
export const MAX_SUPPORTER_PER_TURN = 1;
export const MAX_POKEMON_PER_TURN = 1;

export const ENERGY_TYPES = [
  'Grass', 'Fire', 'Water', 'Lightning', 'Psychic',
  'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'
] as const;

export const ENERGY_TYPE_MAP_ZH: Record<string, string> = {
  Grass: '草',
  Fire: '火',
  Water: '水',
  Lightning: '雷',
  Psychic: '超',
  Fighting: '鬥',
  Darkness: '惡',
  Metal: '鋼',
  Fairy: '妖',
  Dragon: '龍',
  Colorless: '無',
};
