import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { trainerEffects, canPlayTrainer } from '../src/game/effects/trainers';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_MON, SUPPORTER, EXEMPT_SUPPORTER, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });
const play = (G: PtcgGameState, cardId: string) => moves.playTrainer({ G, ctx: ctxFor(G) } as any, cardId);

/** An otherwise-empty mid-game board: nothing in discard, nothing on the Bench. */
function emptyBoard(hand: ReturnType<typeof makeGameCard>[] = []) {
  return makeState({
    turn: 3,
    currentPlayer: 0,
    phase: 'main',
    players: [
      makePlayer({ active: makeGameCard(BASIC_MON, 0), hand }),
      makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
    ],
  });
}

describe('playTrainer', () => {
  it('discards the card and counts it as played', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    play(G, card.id);
    expect(G.players[0].discardPile.map(c => c.id)).toContain(card.id);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].cardsPlayedThisTurn).toBe(1);
  });

  it('spends the one Supporter slot for the turn', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    play(G, card.id);
    expect(G.players[0].supporterPlayedThisTurn).toBe(true);
    expect(G.players[0].supporterNamesPlayedThisTurn).toContain(SUPPORTER.name);
  });

  it('refunds a second Supporter in the same turn', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    G.players[0].supporterPlayedThisTurn = true;
    play(G, card.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(card.id);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('refunds a Supporter on the first turn of the game', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    G.turn = 1;
    play(G, card.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(card.id);
  });

  it('allows a printed first-turn exception through', () => {
    const card = makeGameCard(EXEMPT_SUPPORTER, 0);
    const G = emptyBoard([card]);
    G.turn = 1;
    play(G, card.id);
    expect(G.players[0].discardPile.map(c => c.id)).toContain(card.id);
  });

  it('refuses a non-Trainer card without consuming it', () => {
    const notTrainer = makeGameCard(BASIC_MON, 0);
    const G = emptyBoard([notTrainer]);
    play(G, notTrainer.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(notTrainer.id);
    expect(G.players[0].discardPile).toHaveLength(0);
  });

  it('refuses while a choice is still pending', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    G.pendingChoice = { player: 0, effectKey: 'x', prompt: '', choiceType: 'select_pokemon', count: 1, options: [], context: {} } as any;
    play(G, card.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(card.id);
  });

  it('refuses outside the main phase', () => {
    const card = makeGameCard(SUPPORTER, 0);
    const G = emptyBoard([card]);
    G.phase = 'draw';
    play(G, card.id);
    expect(G.players[0].hand.map(c => c.id)).toContain(card.id);
  });
});

/**
 * The canPlay contract (CLAUDE.md, "Two conventions inside that logic worth knowing"): a Trainer
 * whose effect could do nothing right now must be neither offered by getLegalMoves nor consumed
 * by a forced playTrainer, or it is discarded for zero effect. No refund-style EffectStep exists
 * on purpose — gating is what avoids the documented AI infinite-reoffer loop, so both halves of
 * the gate have to hold for every gated card, not just the ones anyone thought to check.
 */
describe('canPlay gating holds for every gated Trainer in the registry', () => {
  const GATED = Object.keys(trainerEffects).filter(name => !!trainerEffects[name].canPlay);

  it('the registry actually has gated cards to check', () => {
    expect(GATED.length).toBeGreaterThan(0);
  });

  it.each(GATED)('%s', name => {
    // Shaped as an Item so the Supporter-slot rules above can never be what refunds it.
    const card = makeGameCard(makeCard({ name, supertype: 'Trainer', subtypes: ['Item'] }), 0);
    const G = emptyBoard([card]);
    const playable = canPlayTrainer(name, { G, playerIndex: 0, sourceCardId: card.id } as any);
    if (playable) return; // this card's requirements happen to be met on a bare board

    expect(
      getLegalMoves(G, 0).some(m => m.type === 'play_trainer' && m.payload?.cardId === card.id),
      `${name} was offered by getLegalMoves despite canPlay being false`,
    ).toBe(false);

    play(G, card.id);
    expect(G.players[0].hand.map(c => c.id), `${name} was consumed by a forced play`).toContain(card.id);
    expect(G.players[0].discardPile, `${name} was discarded for zero effect`).toHaveLength(0);
    expect(G.players[0].cardsPlayedThisTurn, `${name} counted as a card played`).toBe(0);
  });
});
