import { describe, it, expect } from 'vitest';
import type { Subtype } from '@ptcg/shared';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { checkPendingChoiceResolvable } from '../src/game/invariants';
import { BASIC_MON, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * "The opponent chooses" used to be unimplementable: moves.resolveChoice rejected anything whose
 * pendingChoice.player wasn't G.currentPlayer, and the headless loops only ever polled
 * currentPlayer — so a choice raised against the other seat left NOBODY with a legal move, which
 * battleRunner scored as a "no legal moves" loss for the wrong player. Effects that needed it
 * auto-resolved instead of asking. These cover the plumbing and the two cards that use it.
 */

const ctxFor = (seat: 0 | 1, turnPlayer: 0 | 1 = 0) =>
  ({ currentPlayer: String(turnPlayer), playerID: String(seat), turn: 3, events: { endTurn: () => {} } }) as any;

const timCard = () => makeGameCard(makeCard({ name: '泰姆', supertype: 'Trainer', subtypes: ['Supporter'] as Subtype[] }), 0);
const monInHand = (name: string, hp: string) => makeGameCard(makeCard({ name, hp, supertype: 'Pokémon', subtypes: ['Basic'] as Subtype[] }), 0);

const timBoard = (handMon = monInHand('小火龍', '70')) => {
  const tim = timCard();
  const G = makeState({
    turn: 3, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({ active: makeGameCard(BASIC_MON, 0), hand: [tim, handMon], deck: Array.from({ length: 10 }, (_, i) => makeGameCard(BASIC_MON, 0, `d0-${i}`)) }),
      makePlayer({ active: makeGameCard(BASIC_MON, 1), deck: Array.from({ length: 10 }, (_, i) => makeGameCard(BASIC_MON, 1, `d1-${i}`)) }),
    ],
  });
  return { G, tim, handMon };
};

describe('泰姆: the opponent answers, the user owns the effect', () => {
  it('hands the second choice to the other seat while keeping the effect on the user', () => {
    const { G, tim, handMon } = timBoard();
    moves.playTrainer({ G, ctx: ctxFor(0) } as any, tim.id);
    expect(G.pendingChoice!.player).toBe(0);

    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [handMon.id]);
    expect(G.pendingChoice!.player).toBe(1);   // the opponent answers
    expect(G.pendingChoice!.owner).toBe(0);    // ...but it is still the user's card
    expect(G.pendingChoice!.options!.some(o => o.id === '70')).toBe(true);
    // The choice is resolvable by the seat it names even though it is not their turn.
    expect(checkPendingChoiceResolvable(G)).toEqual([]);
    expect(getLegalMoves(G, 1).some(m => m.type === 'resolve_choice')).toBe(true);
    expect(getLegalMoves(G, 0).some(m => m.type === 'resolve_choice')).toBe(false);
  });

  it('rejects the wrong seat answering, then pays out by whether the answer was right', () => {
    const { G, tim, handMon } = timBoard();
    moves.playTrainer({ G, ctx: ctxFor(0) } as any, tim.id);
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [handMon.id]);

    // Seat 0 cannot answer for seat 1.
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, ['70']);
    expect(G.pendingChoice).not.toBeNull();

    const beforeMe = G.players[0].hand.length;
    const beforeThem = G.players[1].hand.length;
    moves.resolveChoice({ G, ctx: ctxFor(1) } as any, ['70']); // correct HP
    expect(G.pendingChoice).toBeNull();
    expect(G.players[1].hand.length - beforeThem).toBe(4);
    expect(G.players[0].hand.length).toBe(beforeMe);
  });

  it('draws for the user when the opponent answers wrong', () => {
    const { G, tim, handMon } = timBoard();
    moves.playTrainer({ G, ctx: ctxFor(0) } as any, tim.id);
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [handMon.id]);
    const wrong = G.pendingChoice!.options!.map(o => o.id).find(id => id !== '70')!;
    const beforeMe = G.players[0].hand.length;
    moves.resolveChoice({ G, ctx: ctxFor(1) } as any, [wrong]);
    expect(G.players[0].hand.length - beforeMe).toBe(4);
    expect(G.players[1].hand).toHaveLength(0);
  });
});

describe('邀請眨眼: the user picks from the opponent’s hand', () => {
  it('benches only what was selected, and marks the choice as revealing that hand', () => {
    const wink = makeGameCard(makeCard({
      name: '邀請眨眼寶可夢', hp: '90', subtypes: ['Stage 1'] as Subtype[],
      abilities: [{ name: '邀請眨眼', text: '查看對手的手牌，從其中選擇任意數量的【基礎】寶可夢卡，放置於對手的備戰區。', type: 'Ability' }],
    }), 0);
    const a = monInHand('可可多拉', '70'), b = monInHand('波加曼', '60');
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: wink }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1), hand: [a, b] }),
      ],
    });
    G.players[0].pokemonPlayedThisTurn = [wink.id];

    moves.useAbility({ G, ctx: ctxFor(0) } as any, wink.id);
    expect(G.pendingChoice!.player).toBe(0);
    expect(G.pendingChoice!.revealsOpponentHand).toBe(true);
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([a.id, b.id].sort());

    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [a.id]);
    expect(G.players[1].bench.filter(Boolean).map(c => c!.id)).toEqual([a.id]);
    expect(G.players[1].hand.map(c => c.id)).toEqual([b.id]);
  });
});
