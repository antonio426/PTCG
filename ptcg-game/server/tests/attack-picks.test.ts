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
