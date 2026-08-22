import { describe, it, expect } from 'vitest';
import { moves } from '../src/game/moves';
import { getLegalMoves } from '../src/game/validation';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, attack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';
import type { Card } from '@ptcg/shared';

/**
 * An attack can finish in four different places — `moves.attack` itself, and three branches of
 * `moves.resolveChoice` (`attack_pick`, `attack_self_return_promotion`, and the generic
 * `kind === 'attack'` tail). Only the first consulted 祭典樂舞 before `finishAttack` existed; the
 * other three ended the turn unconditionally, so ANY attack that asked a question swallowed the
 * second attack 祭典會場 grants. Dozens of attacks raise choices now, so this is the regression
 * that guards the shared finish path.
 *
 * The chosen attack text is deliberately one the OPPONENT answers — the bonus attack belongs to
 * the attacker, not to whoever pressed the button.
 */

// 「將對手的戰鬥寶可夢與備戰寶可夢互換。[由對手選擇放置於戰鬥場的寶可夢。]」 raises a
// pendingChoice whose `player` is the defender (see attackResolution's forceOpponentSwitch...).
const SWITCH_TEXT = '將對手的戰鬥寶可夢與備戰寶可夢互換。[由對手選擇放置於戰鬥場的寶可夢。]';

const attacker = (withDance: boolean): Card => makeCard({
  name: withDance ? '祭典舞者' : '普通舞者',
  hp: '120', types: ['Colorless'],
  attacks: [attack('推擠', ['Colorless'], '10', SWITCH_TEXT)],
  ...(withDance ? {
    abilities: [{
      name: '祭典樂舞', type: 'Ability',
      text: '只要自己的場上有「祭典會場」，這隻寶可夢每回合可使用2次招式。',
    }],
  } : {}),
});

function boardWith(withDance: boolean, stadium: string | null): PtcgGameState {
  const me = makeGameCard(attacker(withDance), 0, {
    attachedEnergy: [{ id: 'e1', type: 'Grass', cardData: BASIC_ENERGY }],
  });
  const G = makeState({
    turn: 3, currentPlayer: 0, phase: 'main',
    players: [
      makePlayer({ active: me }),
      makePlayer({
        active: makeGameCard(BASIC_MON, 1),
        // TWO candidates: raiseAttackPick declines a "pick 1 of 1" — that is not a decision.
        bench: [makeGameCard(BASIC_MON, 1), makeGameCard(BASIC_MON, 1), null, null, null],
      }),
    ],
  });
  if (stadium) {
    G.activeStadium = makeGameCard(
      makeCard({ name: stadium, supertype: 'Trainer', subtypes: ['Stadium'] }), 0,
    );
  }
  return G;
}

/** Ends the turn the way the real engines do, and records that it happened. */
function ctxFor(G: PtcgGameState) {
  const state = { ended: false };
  return { ctx: { currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn: () => { state.ended = true; } } }, state };
}

describe('finishAttack — an attack that raised a choice still finishes like a normal one', () => {
  it('祭典樂舞 + 祭典會場 still grants the second attack after the choice is answered', () => {
    const G = boardWith(true, '祭典會場');
    const { ctx, state } = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    // The defender has to answer before anything else can happen.
    expect(G.pendingChoice?.player).toBe(1);
    expect(G.phase).not.toBe('end');

    const pick = G.players[1].bench.find(c => c !== null)!.id;
    moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [pick]);

    expect(G.pendingChoice).toBeNull();
    expect(G.phase).not.toBe('end');
    expect(state.ended).toBe(false);
    expect(G.players[0].usedBonusAttackThisTurn).toBe(true);
    expect(getLegalMoves(G, 0).some(m => m.type === 'attack')).toBe(true);
  });

  it('without the ability the same attack ends the turn once the choice is answered', () => {
    const G = boardWith(false, '祭典會場');
    const { ctx, state } = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    const pick = G.players[1].bench.find(c => c !== null)!.id;
    moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [pick]);

    expect(G.phase).toBe('end');
    expect(state.ended).toBe(true);
  });

  it('the ability without its Stadium ends the turn too', () => {
    const G = boardWith(true, null);
    const { ctx, state } = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    const pick = G.players[1].bench.find(c => c !== null)!.id;
    moves.resolveChoice({ G, ctx: { ...ctx, playerID: '1' } }, [pick]);

    expect(G.phase).toBe('end');
    expect(state.ended).toBe(true);
  });

  it('an attack that raises no choice keeps working exactly as before', () => {
    const G = boardWith(true, '祭典會場');
    G.players[1].bench = [null, null, null, null, null]; // nothing to switch to, nothing to ask
    const { ctx, state } = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    expect(G.pendingChoice).toBeNull();
    expect(G.phase).not.toBe('end');
    expect(state.ended).toBe(false);
    expect(G.players[0].usedBonusAttackThisTurn).toBe(true);
  });

  it('only ONE bonus attack — the second attack ends the turn', () => {
    const G = boardWith(true, '祭典會場');
    G.players[1].bench = [null, null, null, null, null];
    const { ctx, state } = ctxFor(G);

    moves.attack({ G, ctx }, 0);
    moves.attack({ G, ctx }, 0);

    expect(G.phase).toBe('end');
    expect(state.ended).toBe(true);
  });
});
