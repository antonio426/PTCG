import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { processBetweenTurns } from '../src/game/statusConditions';
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

describe('納莉: the drawback half of its draw 4', () => {
  const nariCard = () => makeGameCard(makeCard({ name: '納莉', supertype: 'Trainer', subtypes: ['Supporter'] }), 0);
  const boardWith = (handExtras: number) => {
    const nari = nariCard();
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(BASIC_MON, 0),
          hand: [nari, ...Array.from({ length: handExtras }, (_, i) => makeGameCard(BASIC_MON, 0, `h${i}`))],
          deck: Array.from({ length: 10 }, (_, i) => makeGameCard(BASIC_MON, 0, `d${i}`)),
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    return { G, nari };
  };

  it('discards the whole hand at the end of the turn it was played on', () => {
    const { G, nari } = boardWith(2);
    play(G, nari.id);
    expect(G.players[0].hand.length).toBe(6); // 2 kept + 4 drawn
    // The turn transition is where end-of-turn effects fire; currentPlayer has flipped by then.
    G.currentPlayer = 1;
    processBetweenTurns(G);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].discardPile.filter(c => c.cardData.name !== '納莉')).toHaveLength(6);
  });

  it('leaves a hand under 5 alone, and never fires twice', () => {
    const { G, nari } = boardWith(0);
    play(G, nari.id);
    G.players[0].hand = G.players[0].hand.slice(0, 4);
    G.currentPlayer = 1;
    processBetweenTurns(G);
    expect(G.players[0].hand).toHaveLength(4);
    // Next turn's transition must not re-apply it, however big the hand grows.
    G.players[0].hand.push(makeGameCard(BASIC_MON, 0, 'later'));
    G.currentPlayer = 1;
    processBetweenTurns(G);
    expect(G.players[0].hand).toHaveLength(5);
  });
});


/* ------------------------------------------------------------------ */
/*  「最多各 1 張 A／B／C」 — several limits sharing one maxCount        */
/* ------------------------------------------------------------------ */

import { startTrainerEffect } from '../src/game/effects/trainers';
import { getLegalMoves as legalMoves } from '../src/game/validation';

/**
 * 小光 reads 「從牌庫選最多各 1 張基礎／1階／2階寶可夢卡加入手牌」 — three limits of one, not one
 * limit of three. Reported from a real game: it was letting three Basics through, because the
 * choice only carried a total. The stage is the bucket; PendingChoice.maxPerGroup enforces it,
 * and the move generator prunes during enumeration rather than filtering afterwards (with 小光
 * listing every Basic before the first Stage 1, post-filtering could burn the whole 40-combo cap
 * on selections the card forbids and offer none that it allows).
 */
describe('小光 — at most one of EACH stage', () => {
  const poke = (name: string, stage: 'Basic' | 'Stage 1' | 'Stage 2') =>
    makeCard({ name, hp: '80', types: ['Colorless'], subtypes: [stage] as never });

  function boardWithDeck() {
    const G = makeState({ turn: 3, currentPlayer: 0, phase: 'main' });
    G.players[0].deck = [
      makeGameCard(poke('基礎甲', 'Basic'), 0),
      makeGameCard(poke('基礎乙', 'Basic'), 0),
      makeGameCard(poke('基礎丙', 'Basic'), 0),
      makeGameCard(poke('一階甲', 'Stage 1'), 0),
      makeGameCard(poke('二階甲', 'Stage 2'), 0),
    ];
    return G;
  }

  it('groups every option by its stage and caps each at one', () => {
    const G = boardWithDeck();
    const step = startTrainerEffect('小光', { G, playerIndex: 0, sourceCardId: 'src' });
    expect(step).not.toBe('done');
    const choice = step as Exclude<typeof step, 'done'>;
    expect(choice.maxPerGroup).toBe(1);
    expect(choice.maxCount).toBe(3);
    const groups = (choice.options ?? []).map(o => (o as { group?: string }).group);
    expect(groups.filter(g => g === 'Basic')).toHaveLength(3);
    expect(groups.filter(g => g === 'Stage 1')).toHaveLength(1);
    expect(groups.filter(g => g === 'Stage 2')).toHaveLength(1);
  });

  it('never offers two cards of the same stage as a legal selection', () => {
    const G = boardWithDeck();
    const step = startTrainerEffect('小光', { G, playerIndex: 0, sourceCardId: 'src' });
    G.pendingChoice = { player: 0, owner: 0, effectKey: 'trainer:小光', sourceCardId: 'src', ...(step as object) } as never;

    const byId = new Map(G.players[0].deck.map(c => [c.id, c.cardData.subtypes[0]]));
    const selections = legalMoves(G, 0)
      .filter(m => m.type === 'resolve_choice')
      .map(m => (m.payload?.selection as string[]) ?? []);
    expect(selections.length).toBeGreaterThan(0);
    for (const sel of selections) {
      const stages = sel.map(id => byId.get(id));
      expect(new Set(stages).size, `offered ${stages.join('+')}`).toBe(stages.length);
    }
    // And the full one-of-each pick is still on the table.
    expect(selections.some(s => s.length === 3)).toBe(true);
  });
});
