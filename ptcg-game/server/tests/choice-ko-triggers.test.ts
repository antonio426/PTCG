import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { handleKo } from '../src/game/damage';
import { PtcgGameState } from '../src/game/GameState';
import { attack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Card } from '@ptcg/shared';

/**
 * `handleKo`'s 4th argument is the signal "this KO came from the opponent's attack", and the
 * defender-side KO triggers (潛者捕捉 / 光子纜線 / 最後鎖鏈) only fire when it's there. The KOs
 * dealt through a player-answered damage pick weren't passing it, so an attack that asks
 * 「選擇對手的N隻寶可夢」 quietly skipped every one of those abilities while the exact same
 * damage dealt without a question triggered them. Same for the leftover-damage KO on a
 * de-evolved Pokémon.
 */

const WATER_ENERGY: Card = makeCard({
  name: '基礎水能量', supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Water'],
});

/** 「這隻寶可夢受到對手招式的傷害而昏厥時，將其身上附加的基礎水能量卡全部回到手牌。」 */
const DIVER: Card = makeCard({
  name: '獵斑魚', hp: '60', types: ['Water'],
  abilities: [{ name: '潛者捕捉', type: 'Ability', text: '潛者捕捉' }],
});

/** 「對手的2隻寶可夢各受到120點傷害。」 — raises a damage_targets pick for the ATTACKER. */
const SPREADER: Card = makeCard({
  name: '散射鼠', hp: '120', types: ['Colorless'],
  attacks: [attack('散射', [], '0', '對手的2隻寶可夢各受到120點傷害。')],
});

function board(): PtcgGameState {
  const victim = makeGameCard(DIVER, 1, {
    attachedEnergy: [{ id: 'w1', type: 'Water', cardData: WATER_ENERGY }],
  });
  return makeState({
    turn: 3, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({ active: makeGameCard(SPREADER, 0) }),
      makePlayer({
        active: victim,
        // Two candidates so the pick is a real decision (raiseAttackPick declines 1-of-1),
        // and so the KO'd Active has somewhere to be replaced from.
        bench: [makeGameCard(DIVER, 1), makeGameCard(DIVER, 1), null, null, null],
        prizes: [makeGameCard(DIVER, 1), makeGameCard(DIVER, 1)],
      }),
    ],
  });
}

const ctxFor = (G: PtcgGameState) => ({ currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => {} } });

describe('a KO dealt through a player-answered damage pick is still an attack KO', () => {
  it('fires 潛者捕捉 on the Pokémon the attacker picked', () => {
    const G = board();
    const ctx = ctxFor(G);
    const victimId = G.players[1].active!.id;

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice?.context?.kind).toBe('damage_targets');

    moves.resolveChoice({ G, ctx }, [victimId, victimId]);

    // 120 damage on a 60 HP Pokémon — it's gone, and the Water Energy went to hand rather than
    // to the discard pile, which only happens when handleKo was told an attacker did it.
    expect(G.players[1].discardPile.some(c => c.id === victimId)).toBe(true);
    expect(G.players[1].hand.some(c => c.cardData.name === '基礎水能量')).toBe(true);
    expect(G.players[1].discardPile.some(c => c.cardData.name === '基礎水能量')).toBe(false);
  });

  it('an ability/Item KO still is NOT one — the trigger stays attack-only', () => {
    const G = board();
    const victim = G.players[1].active!;
    // Same KO, no attacker: handleKo's contract says the trigger must not fire.
    handleKo(G, 1, victim.id);
    expect(G.players[1].hand.some(c => c.cardData.name === '基礎水能量')).toBe(false);
  });
});
