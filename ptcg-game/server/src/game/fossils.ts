/**
 * "陳舊的○○化石" (Old ○○ Fossil) — real-rules Item cards that can be played as if they were a
 * Basic Pokémon instead of being played for an effect. Printed rules text (verbatim on every
 * Standard-legal fossil, e.g. SV7-090): "這張卡可作為HP60的【無】屬性的【基礎】寶可夢放置於場上。
 * 這張卡不會陷入特殊狀態，無法撤退。若在自己的回合中，則可將場上的這張卡丟棄。" — i.e. HP60
 * Colorless Basic, immune to all Special Conditions, cannot retreat, has no attacks, and its
 * owner may discard it from play (voluntarily, no cost) on their own turn.
 *
 * Modeled as a data transform rather than a new card category: `isFossilCard` recognizes the
 * pattern from the rules text itself (not a hardcoded name list, so any future fossil reprint or
 * new fossil name is picked up automatically), and `fossilAsPokemon` produces a Pokémon-shaped
 * view of the card used ONLY for the in-play `GameCard.cardData` — the copy sitting in hand/
 * deck/discard stays the genuine Trainer/Item card untouched (so e.g. a deck search for "Item
 * cards" still finds it before it's played).
 */
import { Card, EnergyType } from '@ptcg/shared';

const ZH_TYPE_TO_ENERGY: Record<string, EnergyType> = {
  無: 'Colorless', 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic',
  鬥: 'Fighting', 惡: 'Darkness', 鋼: 'Metal', 妖: 'Fairy', 龍: 'Dragon',
};

const FOSSIL_RULE = /這張卡可作為HP(\d+)的【(.+?)】屬性的【基礎】寶可夢放置於場上/;

export function isFossilCard(card: Card): boolean {
  return card.supertype === 'Trainer' && !!card.subtypes?.includes('Item')
    && !!card.rules?.some(r => FOSSIL_RULE.test(r));
}

/** Produces the Pokémon-shaped `cardData` used while this fossil is in play. Caller is
 * responsible for placing the resulting `GameCard` on the board — this is a pure transform. */
export function fossilAsPokemon(card: Card): Card {
  const rule = card.rules!.find(r => FOSSIL_RULE.test(r))!;
  const m = rule.match(FOSSIL_RULE)!;
  const hp = m[1];
  const type = ZH_TYPE_TO_ENERGY[m[2]] ?? 'Colorless';
  return {
    ...card,
    supertype: 'Pokémon',
    subtypes: ['Basic'],
    hp,
    types: [type],
    attacks: [],
    weaknesses: [],
    resistances: [],
    retreatCost: [],
    convertedRetreatCost: 0,
    isFossil: true,
  };
}
