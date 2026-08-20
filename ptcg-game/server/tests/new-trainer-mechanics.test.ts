import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_MON, BASIC_ENERGY, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The two Standard trainers that each needed a brand-new mechanism:
 * - 火箭隊的妨礙機器人: face-up prize tracking (GameCard.revealedPrize) + a blind hand pick.
 * - 變化之書: a "2 copies play as one" cost, then a discard-pile Basic swapped into an in-play
 *   Basic's exact spot with every attachment/damage/condition kept.
 */

const ctx0 = { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } };

const board = (over: { myHand?: any[]; myDiscard?: any[]; myActive?: any; myBench?: any[]; theirHand?: any[]; theirPrizes?: any[] } = {}) => makeState({
  turn: 3, currentPlayer: 0, phase: 'main',
  players: [
    makePlayer({
      active: over.myActive ?? makeGameCard(BASIC_MON, 0),
      bench: [...(over.myBench ?? []), null, null, null, null, null].slice(0, 5),
      hand: over.myHand ?? [],
      discardPile: over.myDiscard ?? [],
    }),
    makePlayer({
      active: makeGameCard(BASIC_MON, 1),
      hand: over.theirHand ?? [],
      prizes: over.theirPrizes ?? [],
    }),
  ],
});

const offered = (G: PtcgGameState, id: string) =>
  getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && (m.payload as any)?.cardId === id);

describe('火箭隊的妨礙機器人: prize/hand swap with permanent face-up prize', () => {
  const bot = () => makeGameCard(makeCard({ name: '火箭隊的妨礙機器人', supertype: 'Trainer', subtypes: ['Item'] as Subtype[] }), 0);

  it('swap: the hand card enters the prize slot face-up, the old prize joins the hand', () => {
    const prizeA = makeGameCard(makeCard({ name: '獎賞A', hp: '60', subtypes: ['Basic'] as Subtype[] }), 1);
    const prizeB = makeGameCard(makeCard({ name: '獎賞B', hp: '60', subtypes: ['Basic'] as Subtype[] }), 1);
    const handCard = makeGameCard(makeCard({ name: '手牌卡', hp: '60', subtypes: ['Basic'] as Subtype[] }), 1);
    const item = bot();
    const G = board({ myHand: [item], theirHand: [handCard], theirPrizes: [prizeA, prizeB] });
    moves.playTrainer({ G, ctx: ctx0 } as any, item.id);
    // Blind labels — no card name leaks before the pick.
    expect(G.pendingChoice!.options!.every(o => o.label.startsWith('獎賞卡'))).toBe(true);
    moves.resolveChoice({ G, ctx: ctx0 } as any, [prizeA.id]);
    expect(G.pendingChoice!.prompt).toContain('獎賞A');
    expect(G.pendingChoice!.prompt).toContain('手牌卡');
    moves.resolveChoice({ G, ctx: ctx0 } as any, ['swap']);
    const opp = G.players[1];
    expect(opp.prizes.map(p => p.id)).toContain(handCard.id);
    expect(opp.prizes.find(p => p.id === handCard.id)!.revealedPrize).toBe(true);
    expect(opp.hand.map(c => c.id)).toContain(prizeA.id);
    expect(opp.hand.find(c => c.id === prizeA.id)!.revealedPrize).toBe(false);
    expect(opp.prizes).toHaveLength(2);
    expect(opp.hand).toHaveLength(1);
  });

  it('keep: the chosen prize stays where it is, face-up; already-revealed prizes are not re-targetable', () => {
    const prize = makeGameCard(makeCard({ name: '獎賞A', hp: '60', subtypes: ['Basic'] as Subtype[] }), 1);
    const item = bot();
    const G = board({ myHand: [item], theirHand: [makeGameCard(BASIC_MON, 1)], theirPrizes: [prize] });
    moves.playTrainer({ G, ctx: ctx0 } as any, item.id);
    moves.resolveChoice({ G, ctx: ctx0 } as any, [prize.id]);
    moves.resolveChoice({ G, ctx: ctx0 } as any, ['keep']);
    expect(G.players[1].prizes[0].id).toBe(prize.id);
    expect(G.players[1].prizes[0].revealedPrize).toBe(true);
    // With every prize already face-up, the card has no legal target and is gated off.
    const item2 = bot();
    G.players[0].hand = [item2];
    expect(offered(G, item2.id)).toBe(false);
    moves.playTrainer({ G, ctx: ctx0 } as any, item2.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(item2.id); // refunded
  });
});

describe('變化之書: two copies play as one, discard-pile Basic takes over an in-play spot', () => {
  const book = () => makeGameCard(makeCard({ name: '變化之書', supertype: 'Trainer', subtypes: ['Item'] as Subtype[] }), 0);

  it('a single copy is neither offered nor consumable', () => {
    const only = book();
    const G = board({
      myHand: [only],
      myDiscard: [makeGameCard(makeCard({ name: '棄牌基礎', hp: '70', subtypes: ['Basic'] as Subtype[] }), 0)],
    });
    expect(offered(G, only.id)).toBe(false);
    moves.playTrainer({ G, ctx: ctx0 } as any, only.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(only.id);
  });

  it('the pair swaps a discard Basic into the field spot, keeping damage/energy/status', () => {
    const copy1 = book();
    const copy2 = book();
    const fromDiscard = makeGameCard(makeCard({ name: '棄牌基礎', hp: '70', subtypes: ['Basic'] as Subtype[] }), 0);
    const fieldMon = makeGameCard(makeCard({ name: '場上基礎', hp: '80', subtypes: ['Basic'] as Subtype[] }), 0, {
      damage: 20,
      statusConditions: ['Poisoned'],
      attachedEnergy: [{ id: 'bk-e1', type: 'Colorless', cardData: BASIC_ENERGY }],
    });
    const G = board({ myHand: [copy1, copy2], myDiscard: [fromDiscard], myActive: fieldMon });
    moves.playTrainer({ G, ctx: ctx0 } as any, copy1.id);
    // The second copy was consumed with the play.
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].discardPile.filter(c => c.cardData.name === '變化之書')).toHaveLength(2);
    moves.resolveChoice({ G, ctx: ctx0 } as any, [fromDiscard.id]);
    moves.resolveChoice({ G, ctx: ctx0 } as any, [fieldMon.id]);
    const active = G.players[0].active!;
    expect(active.id).toBe(fromDiscard.id);
    expect(active.damage).toBe(20);
    expect(active.statusConditions).toEqual(['Poisoned']);
    expect(active.attachedEnergy.map(e => e.id)).toEqual(['bk-e1']);
    // The replaced Pokémon is discarded bare — its attachments stayed on the newcomer.
    const dumped = G.players[0].discardPile.find(c => c.id === fieldMon.id);
    expect(dumped).toBeDefined();
    expect(dumped!.attachedEnergy).toHaveLength(0);
  });
});
