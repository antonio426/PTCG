import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { handleKo } from '../damage';
import { player, opponent, allPokemon, shuffleDeck } from './types';

/** Draw up to `count` cards; returns how many were actually drawn (deck may run out). */
export function drawCards(G: PtcgGameState, idx: 0 | 1, count: number): number {
  const p = player(G, idx);
  let drawn = 0;
  for (let i = 0; i < count && p.deck.length > 0; i++) { p.hand.push(p.deck.pop()!); drawn++; }
  return drawn;
}

/** Draw back up to `target` total hand size (no-op if already there or above). */
export function drawUpTo(G: PtcgGameState, idx: 0 | 1, target: number): void {
  const p = player(G, idx);
  while (p.hand.length < target && p.deck.length > 0) p.hand.push(p.deck.pop()!);
}

export function discardFromHand(G: PtcgGameState, idx: 0 | 1, cardIds: string[]): GameCard[] {
  const p = player(G, idx);
  const discarded: GameCard[] = [];
  for (const id of cardIds) {
    const i = p.hand.findIndex(c => c.id === id);
    if (i >= 0) discarded.push(p.hand.splice(i, 1)[0]);
  }
  p.discardPile.push(...discarded);
  return discarded;
}

/** Shuffle the whole hand back into the deck (leaves hand empty). */
export function shuffleHandIntoDeck(G: PtcgGameState, idx: 0 | 1): void {
  const p = player(G, idx);
  p.deck.push(...p.hand);
  p.hand = [];
  shuffleDeck(p.deck);
}

/** Heal `amount` HP (in raw damage points, e.g. 30 = 3 counters) off a card, floored at 0. */
export function healDamage(card: GameCard, amount: number): void {
  card.damage = Math.max(0, card.damage - amount);
}

/**
 * Place `counters` damage counters (10 HP each) on `target`, KO'ing and awarding prizes if lethal.
 * `attackerIdx` is whoever benefits from the KO (gets the prize).
 */
export function placeDamageCounters(G: PtcgGameState, attackerIdx: 0 | 1, target: GameCard, counters: number): void {
  target.damage += counters * 10;
  const hp = parseInt(target.cardData.hp || '0', 10);
  if (target.damage >= hp && hp > 0) {
    const targetOwnerIdx = player(G, 0).active?.id === target.id || player(G, 0).bench.some(c => c?.id === target.id) ? 0 : 1;
    handleKo(G, targetOwnerIdx as 0 | 1, target.id);
  }
}

/** Non-mutating: which cards in `idx`'s deck match `filter`, as {id,label} options for a PendingChoice. */
export function deckSearchOptions(G: PtcgGameState, idx: 0 | 1, filter: (c: GameCard) => boolean): { id: string; label: string }[] {
  return player(G, idx).deck.filter(filter).map(c => ({ id: c.id, label: c.cardData.name }));
}

export function moveDeckCardToHand(G: PtcgGameState, idx: 0 | 1, cardId: string, reshuffleAfter = true): GameCard | null {
  const p = player(G, idx);
  const i = p.deck.findIndex(c => c.id === cardId);
  if (i === -1) return null;
  const [card] = p.deck.splice(i, 1);
  p.hand.push(card);
  if (reshuffleAfter) shuffleDeck(p.deck);
  return card;
}

export function moveDeckCardToBench(G: PtcgGameState, idx: 0 | 1, cardId: string): boolean {
  const p = player(G, idx);
  const slot = p.bench.findIndex(s => s === null);
  if (slot === -1) return false;
  const i = p.deck.findIndex(c => c.id === cardId);
  if (i === -1) return false;
  p.bench[slot] = p.deck.splice(i, 1)[0];
  return true;
}

export function moveDiscardCardToHand(G: PtcgGameState, idx: 0 | 1, cardId: string): GameCard | null {
  const p = player(G, idx);
  const i = p.discardPile.findIndex(c => c.id === cardId);
  if (i === -1) return null;
  const [card] = p.discardPile.splice(i, 1);
  p.hand.push(card);
  return card;
}

export function flipCoin(): boolean {
  return Math.random() < 0.5;
}

export function flipCoins(n: number): boolean[] {
  return Array.from({ length: n }, () => flipCoin());
}

export function applyStatusCondition(card: GameCard, condition: 'Asleep' | 'Burned' | 'Confused' | 'Paralyzed' | 'Poisoned'): void {
  // 不眠: this Pokémon can never be made Asleep, from any source.
  if (condition === 'Asleep' && card.cardData.abilities?.some(a => a.text && a.name.replace(/^[‌​\s]+/, '').replace(/^\[特性\]\s*/, '').trim() === '不眠')) return;
  // Asleep/Paralyzed/Confused are mutually exclusive with each other (but stack with Burned/Poisoned).
  if (['Asleep', 'Paralyzed', 'Confused'].includes(condition)) {
    card.statusConditions = card.statusConditions.filter(c => !['Asleep', 'Paralyzed', 'Confused'].includes(c));
  } else {
    card.statusConditions = card.statusConditions.filter(c => c !== condition);
  }
  card.statusConditions.push(condition);
}

/** All Pokémon (active+bench) on the board for both players. */
export function everyPokemonInPlay(G: PtcgGameState): GameCard[] {
  return [...allPokemon(G, 0), ...allPokemon(G, 1)];
}

/** Non-rule-box Pokémon: no ex/V/VMAX/VSTAR/GX/Radiant/Mega subtype or name prefix. */
export function hasNoRuleBox(card: GameCard): boolean {
  const subs = card.cardData.subtypes || [];
  const ruleBoxSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'Radiant', 'TAG TEAM'];
  if (subs.some(s => ruleBoxSubtypes.includes(s))) return false;
  if (card.cardData.name.startsWith('超級')) return false;
  return true;
}

/** True if `card` is a "big" Pokémon that awards extra prizes when KO'd (ex/V/VMAX/VSTAR/GX/Mega/TAG TEAM). */
export function isBigPokemon(card: GameCard): boolean {
  return !hasNoRuleBox(card);
}

export { player, opponent, allPokemon, shuffleDeck } from './types';
