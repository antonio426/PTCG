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

/**
 * Attacks whose text says the PLAYER chooses used to have applyAttackOutcome pick at random. The
 * three biggest families (by print count, per data-scraped/auto-pick-audit.md) now raise a real
 * choice — including one the OPPONENT answers, which is what the owner/player split enables.
 */
describe('attack picks go back to the player who owns the decision', () => {
  const mon = (name: string, hp: string, attacks: any[] = [], seat: 0 | 1 = 0) =>
    makeGameCard(makeCard({ name, hp, subtypes: ['Basic'] as Subtype[], attacks }), seat);
  const energy = (id: string, type = 'Colorless') => ({ id, type } as any);

  it('lets the attacker choose which Basics come out of the deck', () => {
    const atk = mon('聒噪鳥', '90', [{ name: '無伴奏合唱', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '從自己的牌庫選擇最多3張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。' }]);
    atk.attachedEnergy = [energy('e1')];
    const a = mon('可可多拉', '70'), b = mon('波加曼', '60'), c = mon('皮丘', '40');
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: atk, deck: [a, b, c] }), makePlayer({ active: mon('沙包鼠', '150', [], 1) })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.player).toBe(0);
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([a.id, b.id, c.id].sort());
    // The turn is held open while the choice stands — otherwise the pick would be unanswerable.
    expect(G.phase).not.toBe('end');

    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [a.id, c.id]);
    expect(G.players[0].bench.filter(Boolean).map(x => x!.id)).toEqual([a.id, c.id]);
    expect(G.players[0].deck.map(x => x.id)).toEqual([b.id]);
    expect(G.phase).toBe('end');
  });

  it('lets the DEFENDER choose who they promote, per the printed reminder', () => {
    const atk = mon('蜻蜻蜓', '90', [{ name: '吹飛', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '將對手的戰鬥寶可夢與備戰寶可夢互換。[由對手選擇放置於戰鬥場的寶可夢。]' }]);
    atk.attachedEnergy = [energy('e1')];
    const theirActive = mon('主戰', '150', [], 1);
    const benchA = mon('備戰A', '90', [], 1), benchB = mon('備戰B', '90', [], 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: atk }),
        makePlayer({ active: theirActive, bench: [benchA, benchB, null, null, null] }),
      ],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.player).toBe(1);       // the opponent answers
    expect(getLegalMoves(G, 1).some(m => m.type === 'resolve_choice')).toBe(true);
    expect(getLegalMoves(G, 0).some(m => m.type === 'resolve_choice')).toBe(false);

    moves.resolveChoice({ G, ctx: ctxFor(1, 0) } as any, [benchB.id]);
    expect(G.players[1].active!.id).toBe(benchB.id);
    expect(G.players[1].bench.filter(Boolean).map(c => c!.id).sort()).toEqual([benchA.id, theirActive.id].sort());
    // The attacker's turn still ends, even though the defender was the one answering.
    expect(G.phase).toBe('end');
  });
});

describe('attack picks: deck attach and deck evolve', () => {
  const mon = (name: string, hp: string, attacks: any[] = [], seat: 0 | 1 = 0, subtypes: Subtype[] = ['Basic']) =>
    makeGameCard(makeCard({ name, hp, subtypes, attacks }), seat);
  const energyCard = (id: string, type: string) => makeGameCard(makeCard({
    id, name: `基本${type}能量`, supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: [type as never],
  }), 0);

  it('lets the player choose which Energy comes out of the deck onto the attacker', () => {
    const atk = mon('夠讚狗ex', '260', [{ name: '猛毒筋力', cost: ['Darkness'], convertedEnergyCost: 1, damage: '', text: '從自己的牌庫選擇最多2張「基本【惡】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。' }]);
    atk.attachedEnergy = [{ id: 'e0', type: 'Darkness' } as any];
    const d1 = energyCard('D1', 'Darkness'), d2 = energyCard('D2', 'Darkness'), d3 = energyCard('D3', 'Darkness');
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: atk, deck: [d1, d2, d3] }), makePlayer({ active: mon('沙包鼠', '150', [], 1) })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([d1.id, d2.id, d3.id].sort());
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [d2.id]);
    expect(atk.attachedEnergy.map(e => e.id)).toEqual(['e0', d2.id]);
    expect(G.players[0].deck).toHaveLength(2);
  });

  it('asks which evolution to become only when the deck holds more than one', () => {
    const text = '從自己的牌庫選擇1張從這隻寶可夢進化而來的卡，放置於這隻寶可夢身上完成進化。並且重洗牌庫。';
    const base = () => {
      const c = mon('石居蟹', '70', [{ name: '覺醒', cost: ['Water'], convertedEnergyCost: 1, damage: '', text }]);
      c.attachedEnergy = [{ id: 'w1', type: 'Water' } as any];
      return c;
    };
    const evoA = makeGameCard(makeCard({ id: 'EVO-A', name: '鋼砲臂蝦', hp: '120', subtypes: ['Stage 1'] as Subtype[], evolvesFrom: '石居蟹' }), 0);
    const evoB = makeGameCard(makeCard({ id: 'EVO-B', name: '鋼砲臂蝦ex', hp: '260', subtypes: ['Stage 1', 'ex'] as Subtype[], evolvesFrom: '石居蟹' }), 0);

    const two = base();
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: two, deck: [evoA, evoB] }), makePlayer({ active: mon('沙包鼠', '150', [], 1) })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([evoA.id, evoB.id].sort());
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [evoB.id]);
    expect(G.players[0].active!.id).toBe(evoB.id);
    expect(G.players[0].active!.attachedEnergy.map(e => e.id)).toEqual(['w1']);
    expect(G.players[0].active!.preEvolutions?.map(c => c.id)).toEqual([two.id]);

    // With one candidate there is nothing to decide, and it resolves without a prompt.
    const one = base();
    const only = makeGameCard(makeCard({ id: 'EVO-C', name: '鋼砲臂蝦', hp: '120', subtypes: ['Stage 1'] as Subtype[], evolvesFrom: '石居蟹' }), 0);
    const G2 = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: one, deck: [only] }), makePlayer({ active: mon('沙包鼠', '150', [], 1) })],
    });
    moves.attack({ G: G2, ctx: ctxFor(0) } as any, 0);
    expect(G2.pendingChoice).toBeNull();
    expect(G2.players[0].active!.id).toBe(only.id);
  });
});

describe('attack picks: 「以任意方式」 attaches ask per card', () => {
  it('walks one destination choice per chosen Energy, then ends the turn', () => {
    const atk = makeGameCard(makeCard({
      name: '風妖精ex', hp: '260', subtypes: ['Basic'] as Subtype[],
      attacks: [{ name: '能量之禮', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '從自己的牌庫選擇最多3張基本能量卡，以任意方式附於自己的寶可夢身上。並且重洗牌庫。' }],
    }), 0);
    atk.attachedEnergy = [{ id: 'e0', type: 'Colorless' } as any];
    const benched = makeGameCard(makeCard({ name: '備戰', hp: '90', subtypes: ['Basic'] as Subtype[] }), 0);
    const en = (id: string) => makeGameCard(makeCard({ id, name: '基本草能量', supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: ['Grass'] }), 0);
    const g1 = en('G1'), g2 = en('G2');
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: atk, bench: [benched, null, null, null, null], deck: [g1, g2] }),
        makePlayer({ active: makeGameCard(makeCard({ name: '沙包鼠', hp: '150', subtypes: ['Basic'] as Subtype[] }), 1) }),
      ],
    });

    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.context.phase).toBe('cards');
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [g1.id, g2.id]);

    // First destination question, for the first chosen card.
    expect(G.pendingChoice!.context.phase).toBe('target');
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([atk.id, benched.id].sort());
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [benched.id]);

    // Second card, second question — the turn is still open.
    expect(G.pendingChoice!.context.phase).toBe('target');
    expect(G.phase).not.toBe('end');
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [atk.id]);

    expect(benched.attachedEnergy.map(e => e.id)).toEqual([g1.id]);
    expect(atk.attachedEnergy.map(e => e.id)).toEqual(['e0', g2.id]);
    expect(G.players[0].deck).toHaveLength(0);
    expect(G.pendingChoice).toBeNull();
    expect(G.phase).toBe('end');
  });
});

describe('attack picks: moving Energy already in play', () => {
  it('asks which Energy, then which Bench Pokémon receives it', () => {
    const atk = makeGameCard(makeCard({
      name: '能量搬運工', hp: '120', subtypes: ['Basic'] as Subtype[],
      attacks: [{ name: '轉移', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。' }],
    }), 0);
    atk.attachedEnergy = [{ id: 'fire1', type: 'Fire' } as any, { id: 'water1', type: 'Water' } as any];
    const b1 = makeGameCard(makeCard({ name: '備戰1', hp: '90', subtypes: ['Basic'] as Subtype[] }), 0);
    const b2 = makeGameCard(makeCard({ name: '備戰2', hp: '90', subtypes: ['Basic'] as Subtype[] }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active: atk, bench: [b1, b2, null, null, null] }),
        makePlayer({ active: makeGameCard(makeCard({ name: '沙包鼠', hp: '150', subtypes: ['Basic'] as Subtype[] }), 1) }),
      ],
    });

    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.options!.map(o => o.id)).toEqual(['fire1', 'water1']);
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, ['water1']);

    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([b1.id, b2.id].sort());
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [b2.id]);

    expect(atk.attachedEnergy.map(e => e.id)).toEqual(['fire1']);
    expect(b2.attachedEnergy.map(e => e.id)).toEqual(['water1']);
    expect(G.phase).toBe('end');
  });
});

describe('attack picks: opponent hand and target selection', () => {
  const mon = (name: string, hp: string, attacks: any[] = [], seat: 0 | 1 = 0) =>
    makeGameCard(makeCard({ name, hp, subtypes: ['Basic'] as Subtype[], attacks }), seat);
  const handCard = (id: string, name: string, seat: 0 | 1) =>
    makeGameCard(makeCard({ id, name, supertype: 'Trainer', subtypes: ['Item'] as Subtype[] }), seat);

  it('「查看對手的手牌」 lets the attacker pick, and says the hand is revealed', () => {
    const atk = mon('偷窺者', '110', [{ name: '窺視', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '查看對手的手牌，從其中選擇1張卡，將其丟棄。' }]);
    atk.attachedEnergy = [{ id: 'e1', type: 'Colorless' } as any];
    const a = handCard('OH-1', '高級球', 1), b = handCard('OH-2', '寶可平板', 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: atk }), makePlayer({ active: mon('沙包鼠', '150', [], 1), hand: [a, b] })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.player).toBe(0);
    expect(G.pendingChoice!.revealsOpponentHand).toBe(true);
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [b.id]);
    expect(G.players[1].hand.map(c => c.id)).toEqual([a.id]);
    expect(G.players[1].discardPile.map(c => c.id)).toEqual([b.id]);
  });

  it('「對手選擇對手自己的1張手牌」 is answered by the opponent, unrevealed', () => {
    const atk = mon('逼迫者', '110', [{ name: '逼棄', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '對手選擇1張對手自己的手牌，將其丟棄。' }]);
    atk.attachedEnergy = [{ id: 'e1', type: 'Colorless' } as any];
    const a = handCard('OH-3', '高級球', 1), b = handCard('OH-4', '寶可平板', 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: atk }), makePlayer({ active: mon('沙包鼠', '150', [], 1), hand: [a, b] })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.player).toBe(1);
    expect(G.pendingChoice!.revealsOpponentHand).toBeFalsy();
    moves.resolveChoice({ G, ctx: ctxFor(1, 0) } as any, [a.id]);
    expect(G.players[1].hand.map(c => c.id)).toEqual([b.id]);
    expect(G.phase).toBe('end');
  });

  it('lets the attacker choose the target of a multi-pick damage attack', () => {
    const atk = mon('奧利瓦ex', '260', [{ name: '油之機關槍', cost: ['Colorless'], convertedEnergyCost: 1, damage: '', text: '選擇6次對手的寶可夢，對所選的所有寶可夢不計算弱點・抵抗力，造成其選擇次數×20點傷害。（1隻可選擇2次以上。）' }]);
    atk.attachedEnergy = [{ id: 'e1', type: 'Colorless' } as any];
    const active = mon('主戰', '330', [], 1), bench = mon('備戰', '330', [], 1);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [makePlayer({ active: atk }), makePlayer({ active, bench: [bench, null, null, null, null] })],
    });
    moves.attack({ G, ctx: ctxFor(0) } as any, 0);
    expect(G.pendingChoice!.options!.map(o => o.id).sort()).toEqual([active.id, bench.id].sort());
    // The template collapses 「選擇6次…×20點」 into one 120-damage pick (a documented
    // simplification — see genericAttacks.ts); what changed here is WHO picks the target.
    moves.resolveChoice({ G, ctx: ctxFor(0) } as any, [bench.id]);
    expect(bench.damage).toBe(120);
    expect(active.damage).toBe(0);
  });
});
