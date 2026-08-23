import { describe, it, expect, vi, afterEach } from 'vitest';
import { moves } from '../src/game/moves';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, attack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Card } from '@ptcg/shared';

/**
 * `applyAttackOutcome` resolves choice-shaped effects itself, which is right for 「隨機」 texts and
 * wrong for 「選擇」 ones — the gap `auto-pick-audit.ts` measures. These are the conversions: the
 * engine asks, and the old automatic resolution stays only as the fallback for when there is
 * nothing to decide.
 *
 * Each spec drives the real attack text through `moves.attack`, because the point is the whole
 * path — text → outcome → raised choice → resolveChoice — not any one piece of it.
 */

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });

const energy = (id: string) => ({ id, type: 'Grass', cardData: BASIC_ENERGY });

const attacker = (name: string, text: string, damage = '0'): Card => makeCard({
  name, hp: '150', types: ['Colorless'], attacks: [attack('招式', [], damage, text)],
});

function board(mon: Card, over: { energy?: number; deck?: number; oppBench?: number } = {}): PtcgGameState {
  const me = makeGameCard(mon, 0, {
    attachedEnergy: Array.from({ length: over.energy ?? 0 }, (_, i) => energy(`e${i}`)),
  });
  return makeState({
    turn: 3, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({
        active: me,
        deck: Array.from({ length: over.deck ?? 0 }, (_, i) => makeGameCard(makeCard({ name: `牌${i}` }), 0)),
        // handleKo only counts a prize when there is one to take.
        prizes: [makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0)],
      }),
      makePlayer({
        active: makeGameCard(BASIC_MON, 1),
        bench: Array.from({ length: 5 }, (_, i) => (i < (over.oppBench ?? 0) ? makeGameCard(BASIC_MON, 1) : null)),
        prizes: [makeGameCard(BASIC_MON, 1)],
      }),
    ],
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('選擇 texts the engine used to answer for you', () => {
  it('滑燒火焰: the coins decide how many Energy go, the player decides which', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // every flip tails
    const G = board(attacker('熔蟻獸似', '擲3次硬幣，選擇與反面出現的次數相同數量的這隻寶可夢身上附加的能量，將其丟棄。'), { energy: 4 });
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.context?.kind).toBe('self_energy_discard');
    expect(G.pendingChoice?.count).toBe(3);

    const keep = 'e0';
    moves.resolveChoice({ G, ctx }, ['e1', 'e2', 'e3']);
    expect(G.players[0].active!.attachedEnergy.map(e => e.id)).toEqual([keep]);
  });

  it('時間掌控: the picked cards go on top of the deck, in the order they were picked', () => {
    const G = board(attacker('帝牙盧卡似', '從自己的牌庫任意選擇2張卡。重洗剩餘牌庫，將所選的卡以任意順序排列，放回牌庫上方。'), { deck: 6 });
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.context?.kind).toBe('deck_to_top');
    const [wantFirst, wantSecond] = [G.players[0].deck[1].id, G.players[0].deck[4].id];

    moves.resolveChoice({ G, ctx }, [wantFirst, wantSecond]);
    const deck = G.players[0].deck;
    // drawCards pops from the end, so the last element is the next card drawn.
    expect(deck[deck.length - 1].id).toBe(wantFirst);
    expect(deck[deck.length - 2].id).toBe(wantSecond);
    expect(deck).toHaveLength(6);
  });

  it('破壞潮旋: the attacker chooses which of the defender’s Energy to discard', () => {
    // Two heads then a tail — `for (…; Math.random() < 0.5; …)`.
    const flips = [0.1, 0.1, 0.9];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => flips[i++] ?? 0.9);
    const G = board(attacker('洛奇亞似', '擲硬幣直到出現反面，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。'));
    G.players[1].active!.attachedEnergy = [energy('o0'), energy('o1'), energy('o2')];
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.context?.kind).toBe('opponent_energy_discard');
    expect(G.pendingChoice?.player).toBe(0); // the ATTACKER picks, though the Energy is not theirs
    expect(G.pendingChoice?.count).toBe(2);

    moves.resolveChoice({ G, ctx }, ['o0', 'o2']);
    expect(G.players[1].active!.attachedEnergy.map(e => e.id)).toEqual(['o1']);
  });

  it('嗡嗡榍石: on tails the attacker chooses which Benched Basic is Knocked Out', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99); // tails
    const G = board(attacker('椰蛋樹似', '擲1次硬幣若為正面，則將對手的戰鬥場的【基礎】寶可夢【昏厥】。若為反面，則選擇1隻對手的備戰區的【基礎】寶可夢，將其【昏厥】。'), { oppBench: 3 });
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.context?.kind).toBe('ko_target');

    const target = G.players[1].bench[1]!.id;
    moves.resolveChoice({ G, ctx }, [target]);
    expect(G.players[1].bench.some(c => c?.id === target)).toBe(false);
    expect(G.players[1].discardPile.some(c => c.id === target)).toBe(true);
  });

  describe('激流水泵 — 「若希望」 means the player may also decline', () => {
    const TEXT = '若希望，選擇3個這隻寶可夢身上附加的能量，放回牌庫並重洗。這個情況下，對手的1隻備戰寶可夢也受到120點傷害。[在備戰區不計算弱點・抵抗力。]';

    it('sends the chosen Energy to the deck and damages a Benched Pokémon', () => {
      const G = board(attacker('厄鬼椪似', TEXT), { energy: 4, oppBench: 1 });
      const ctx = ctxFor(G);

      moves.attack({ G, ctx }, 0);
      expect(G.pendingChoice?.context?.kind).toBe('self_energy_to_deck');
      expect(G.pendingChoice?.minCount).toBe(0); // 「若希望」

      moves.resolveChoice({ G, ctx }, ['e0', 'e1', 'e2']);
      expect(G.players[0].active!.attachedEnergy.map(e => e.id)).toEqual(['e3']);
      expect(G.players[0].deck).toHaveLength(3);
      // 120 onto a 60 HP Benched Pokémon: it is gone, and the attacker took the prize for it.
      expect(G.players[1].bench[0]).toBeNull();
      expect(G.players[0].takenPrizes).toBe(1);
    });

    it('does nothing at all when the player declines', () => {
      const G = board(attacker('厄鬼椪似', TEXT), { energy: 4, oppBench: 1 });
      const ctx = ctxFor(G);

      moves.attack({ G, ctx }, 0);
      moves.resolveChoice({ G, ctx }, []);
      expect(G.players[0].active!.attachedEnergy).toHaveLength(4);
      expect(G.players[0].deck).toHaveLength(0);
      expect(G.players[1].bench[0]!.damage).toBe(0);
    });
  });
});

/**
 * Two attacks ask TWO questions in a printed order. `raiseAttackPick` refuses while a choice is
 * pending — correctly, one at a time — so the second rides along on the first (`queueAttackPick`)
 * and `resolveChoice` raises it on the way out.
 */
describe('attacks that ask two questions in a printed order', () => {
  it('駭客攻擊: the opponent picks from their hand first, then the attacker from theirs', () => {
    const G = board(attacker('多邊獸似', '選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。'));
    G.players[0].hand = [makeGameCard(makeCard({ name: '我的甲' }), 0), makeGameCard(makeCard({ name: '我的乙' }), 0)];
    G.players[1].hand = [makeGameCard(makeCard({ name: '敵的甲' }), 1), makeGameCard(makeCard({ name: '敵的乙' }), 1)];
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    // 「對手選擇對手自己的1張手牌」 — the defender answers first, on the attacker's turn.
    expect(G.pendingChoice?.player).toBe(1);
    const oppCard = G.players[1].hand[0].id;
    moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [oppCard]);

    // …and the attacker's own discard is the queued follow-up, not a random pick.
    expect(G.pendingChoice?.player).toBe(0);
    expect(G.pendingChoice?.context?.kind).toBe('self_hand_discard');
    const myCard = G.players[0].hand[1].id;
    moves.resolveChoice({ G, ctx }, [myCard]);

    expect(G.players[1].discardPile.some(c => c.id === oppCard)).toBe(true);
    expect(G.players[0].discardPile.some(c => c.id === myCard)).toBe(true);
    expect(G.players[0].hand).toHaveLength(1);
  });

  it('幸福禮物: both players choose, and 「對手先選擇」 is honoured', () => {
    const G = board(attacker('信使鳥似', '雙方玩家若希望，各自從自己的手牌選擇最多3張基本能量卡，以任意方式附於自己的寶可夢身上。（對手先選擇。）'));
    const basic = (owner: 0 | 1, n: string) => makeGameCard(makeCard({ name: n, supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Grass'] }), owner);
    G.players[0].hand = [basic(0, '我的能量')];
    G.players[1].hand = [basic(1, '敵的能量')];
    const ctx = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.player).toBe(1);       // 對手先選擇
    moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [G.players[1].hand[0].id]);
    // Single card, single target — the follow-up target question resolves without another prompt.
    while (G.pendingChoice?.player === 1) {
      moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [G.pendingChoice.options![0].id]);
    }

    expect(G.pendingChoice?.player).toBe(0);       // then the attacker
    moves.resolveChoice({ G, ctx }, [G.players[0].hand[0].id]);
    while (G.pendingChoice) {
      moves.resolveChoice({ G, ctx }, [G.pendingChoice.options![0].id]);
    }

    expect(G.players[1].active!.attachedEnergy).toHaveLength(1);
    expect(G.players[0].active!.attachedEnergy).toHaveLength(1);
  });
});

/**
 * 「將…任意數量的X丟棄，造成其張數×N點傷害」 — how much you spend IS the decision, and the answer
 * is what the damage is computed from, so the question has to be asked BEFORE the breakdown runs
 * and the resolution re-entered once it is answered. Reported from a real game: 超級噴火龍Xex's
 * 烈獄狂火X was discarding every Fire Energy on the board.
 */
describe('spending 「任意數量」 for damage is the player\'s call', () => {
  const fire = (id: string) => ({ id, type: 'Fire', cardData: makeCard({ name: '基本【火】能量', supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Fire'] }) });

  function charizardBoard() {
    const zard = makeCard({
      name: '超級噴火龍Xex', hp: '360', types: ['Fire'], subtypes: ['Stage 2', 'ex'],
      attacks: [attack('烈獄狂火X', [], '90×', '將自己的場上寶可夢身上附加的任意數量的【火】能量卡丟棄，造成其張數×90點傷害。')],
    });
    const benched = makeCard({ name: '幫手', hp: '90', types: ['Fire'] });
    const G = makeState({
      turn: 6, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(zard, 0, { attachedEnergy: [fire('a1'), fire('a2'), fire('a3')] }),
          bench: [makeGameCard(benched, 0, { attachedEnergy: [fire('b1')] }), null, null, null, null],
          prizes: [makeGameCard(BASIC_MON, 0), makeGameCard(BASIC_MON, 0)],
        }),
        makePlayer({ active: makeGameCard(makeCard({ name: '對手', hp: '340', types: ['Colorless'] }), 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    return G;
  }

  it('asks which Energy to spend instead of taking every one on the board', () => {
    const G = charizardBoard();
    const ctx = ctxFor(G);
    moves.attack({ G, ctx }, 0);

    expect(G.pendingChoice?.context?.kind).toBe('spend_for_damage');
    expect(G.pendingChoice?.minCount).toBe(0);        // 「任意數量」 includes none
    expect(G.pendingChoice?.maxCount).toBe(4);        // 3 on the Active + 1 on the Bench
    // Nothing has been spent and no damage dealt while the question stands.
    expect(G.players[0].active!.attachedEnergy).toHaveLength(3);
    expect(G.players[1].active!.damage).toBe(0);
  });

  it('spends exactly what was picked, and scales the damage to it', () => {
    const G = charizardBoard();
    const ctx = ctxFor(G);
    moves.attack({ G, ctx }, 0);
    moves.resolveChoice({ G, ctx }, ['a1', 'b1']);

    // Two cards spent — one off the Active, one off the Bench — so 2 x 90.
    expect(G.players[0].active!.attachedEnergy.map(e => e.id)).toEqual(['a2', 'a3']);
    expect(G.players[0].bench[0]!.attachedEnergy).toHaveLength(0);
    expect(G.players[1].active!.damage).toBe(180);
  });

  it('honours spending none — no Energy gone, no damage', () => {
    const G = charizardBoard();
    const ctx = ctxFor(G);
    moves.attack({ G, ctx }, 0);
    moves.resolveChoice({ G, ctx }, []);

    expect(G.players[0].active!.attachedEnergy).toHaveLength(3);
    expect(G.players[0].bench[0]!.attachedEnergy).toHaveLength(1);
    expect(G.players[1].active!.damage).toBe(0);
  });

  it('the same question for an attack that spends only its own Energy', () => {
    const beast = makeCard({
      name: '電擊魔獸似', hp: '120', types: ['Lightning'],
      attacks: [attack('電壓錘', [], '60×', '將這隻寶可夢身上附加的任意數量的基本能量卡丟棄，造成其張數×60點傷害。')],
    });
    const G = makeState({
      turn: 6, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active: makeGameCard(beast, 0, { attachedEnergy: [fire('x1'), fire('x2')] }),
          bench: [makeGameCard(BASIC_MON, 0, { attachedEnergy: [fire('y1')] }), null, null, null, null],
          prizes: [makeGameCard(BASIC_MON, 0)],
        }),
        makePlayer({ active: makeGameCard(makeCard({ name: '對手', hp: '200', types: ['Colorless'] }), 1), prizes: [makeGameCard(BASIC_MON, 1)] }),
      ],
    });
    const ctx = ctxFor(G);
    moves.attack({ G, ctx }, 0);
    // Only the attacker's own Energy is on offer — the Bench's is not this attack's to spend.
    expect(G.pendingChoice?.options?.map(o => o.id)).toEqual(['x1', 'x2']);
    moves.resolveChoice({ G, ctx }, ['x1']);
    expect(G.players[1].active!.damage).toBe(60);
    expect(G.players[0].bench[0]!.attachedEnergy).toHaveLength(1);
  });
});
