import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { PtcgGameState, PendingChoice } from '../src/game/GameState';
import { BASIC_MON, BASIC_ENERGY, SUPPORTER, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });

/**
 * 高級球 / 海岱 pay a COST out of hand ("discard 2" / "return 2"). Their start() bailed out when
 * the hand was too small, but neither had the matching canPlay gate the convention requires, so
 * the card was still offered and then thrown away for nothing.
 *
 * The gate has to exclude the card being played: getLegalMoves asks while the card is still in
 * hand, playTrainer asks after splicing it out, so a bare hand.length check is off by one in one
 * of them.
 */
describe.each([
  ['高級球', 'Item' as const],
  ['海岱', 'Supporter' as const],
])('%s hand-cost gate', (name, subtype) => {
  function board(spareCards: number) {
    const card = makeGameCard(makeCard({ name, supertype: 'Trainer', subtypes: [subtype] }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          hand: [card, ...Array.from({ length: spareCards }, () => makeGameCard(BASIC_ENERGY, 0))],
          deck: [makeGameCard(BASIC_MON, 0), makeGameCard(SUPPORTER, 0)],
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, card };
  }

  const offered = (G: PtcgGameState, id: string) =>
    getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && m.payload?.cardId === id);

  it.each([0, 1])('is not offered with only %i other cards in hand', spare => {
    const { G, card } = board(spare);
    expect(offered(G, card.id)).toBe(false);
  });

  it('is offered once two other cards are in hand', () => {
    const { G, card } = board(2);
    expect(offered(G, card.id)).toBe(true);
  });

  it.each([0, 1])('refunds a forced play with only %i other cards in hand', spare => {
    const { G, card } = board(spare);
    moves.playTrainer({ G, ctx: ctxFor(G) } as any, card.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(card.id);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('raises its cost prompt when it can be paid', () => {
    const { G, card } = board(2);
    moves.playTrainer({ G, ctx: ctxFor(G) } as any, card.id);
    expect(G.pendingChoice?.count).toBe(2);
    expect(getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice').length).toBeGreaterThan(0);
  });
});

describe('高級球 with no Pokémon left in the deck', () => {
  // Deliberately NOT gated: paying 2 cards purely to thin the deck and fill the discard pile is
  // a real play, and real rules allow a deck search that finds nothing.
  function board() {
    const card = makeGameCard(makeCard({ name: '高級球', supertype: 'Trainer', subtypes: ['Item'] }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          hand: [card, makeGameCard(BASIC_ENERGY, 0), makeGameCard(BASIC_ENERGY, 0)],
          deck: [makeGameCard(SUPPORTER, 0), makeGameCard(BASIC_ENERGY, 0)],
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, card };
  }

  it('is still offered', () => {
    const { G, card } = board();
    expect(getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && m.payload?.cardId === card.id)).toBe(true);
  });

  it('still discards the two cards and ends cleanly, with no search prompt left standing', () => {
    const { G, card } = board();
    const ctx = ctxFor(G);
    moves.playTrainer({ G, ctx } as any, card.id);
    const pick = getLegalMoves(G, 0).find(m => m.type === 'resolve_choice')!;
    moves.resolveChoice({ G, ctx } as any, pick.payload!.selection as string[]);

    expect(G.pendingChoice).toBeNull();
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].discardPile).toHaveLength(3); // 2 paid + 高級球 itself
  });
});

describe('a pending choice always has at least one legal resolution', () => {
  // Guards the soft-lock: combinations(pool, n) is empty for n > pool.length, so an unclamped
  // fixed count left a standing pendingChoice with no move able to clear it — the client renders
  // that as a modal reading 沒有可行的選項…… with nothing to click.
  function withChoice(choice: Partial<PendingChoice>, handSize: number) {
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          hand: Array.from({ length: handSize }, () => makeGameCard(BASIC_ENERGY, 0)),
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    G.pendingChoice = { player: 0, effectKey: 'test', prompt: 'x', context: {}, ...choice } as PendingChoice;
    return G;
  }

  it.each([
    ['count 2, hand of 1', { choiceType: 'select_hand_cards', count: 2 }, 1],
    ['count 2, empty hand', { choiceType: 'select_hand_cards', count: 2 }, 0],
    ['count 3, hand of 1', { choiceType: 'select_hand_cards', count: 3 }, 1],
  ])('%s still offers a resolution', (_label, choice, handSize) => {
    const G = withChoice(choice as Partial<PendingChoice>, handSize);
    expect(getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice').length).toBeGreaterThan(0);
  });

  it('an empty option list degrades to a single "select nothing" resolution', () => {
    const G = withChoice({ choiceType: 'select_from_list', count: 2, options: [] }, 0);
    const resolutions = getLegalMoves(G, 0).filter(m => m.type === 'resolve_choice');
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].payload!.selection).toEqual([]);
  });
});
