import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from '../src/game/setup';
import { beginNextTurn } from '../src/game/turnLifecycle';
import { BASIC_MON, basicOnlyDeckIds, makeGameCard, makeState, testCardData } from './fixtures';

const SRC = join(__dirname, '..', 'src');
const SHARED = join(SRC, 'game', 'turnLifecycle.ts');

/**
 * The turn-begin block used to be hand-copied into every engine (see CLAUDE.md, "Two parallel
 * battle engines") and drifted twice. The last time, routes/battles.ts kept the pre-fix
 * `turn === 1 ? 'main' : 'draw'` (its first player never drew) plus four per-turn resets it had
 * never learned about — while the three copies the previous version of this guard listed were all
 * correct and agreed with each other. Guarding "the copies match" can never catch a copy the guard
 * doesn't know about, so the rule is now the stronger one: there is exactly ONE implementation,
 * and every engine calls it.
 */
const ENGINES = {
  'battleRunner.ts': join(SRC, 'ai', 'battleRunner.ts'),
  'humanBattle.ts': join(SRC, 'routes', 'humanBattle.ts'),
  'PtcgGame.ts': join(SRC, 'game', 'PtcgGame.ts'),
  'battles.ts': join(SRC, 'routes', 'battles.ts'),
};

/** Per-turn work that only the shared implementation may do. */
const RESET_MARKERS = [
  'activeIdAtTurnStart =',
  'energyAttachedThisTurn = 0',
  'supporterNamesPlayedThisTurn = []',
  'stadiumActionUsedThisTurn = false',
  'processBetweenTurns(',
];

const stripComments = (src: string) =>
  src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('turn-begin lifecycle has exactly one implementation', () => {
  it.each(Object.entries(ENGINES))('%s calls into the shared lifecycle', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/(applyTurnBegin|beginNextTurn)\(G\)/);
    expect(src).toContain("turnLifecycle'");
  });

  // Advancing the turn is three lines — flip the seat, count it, run turn-begin — and every engine
  // wrote its own, none of which re-checked the win afterwards except humanBattle. Since handleKo
  // never sets G.winner, a between-turns Poison/Burn KO could take the sixth prize and the
  // already-defeated player would still get one more action. beginNextTurn does all four steps.
  // PtcgGame is exempt: boardgame.io owns seat order (TurnOrder) and re-evaluates endIf itself.
  it.each(Object.entries(ENGINES).filter(([name]) => name !== 'PtcgGame.ts'))(
    '%s does not advance the turn by hand', (_name, file) => {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(src, 'seat flipping belongs in beginNextTurn').not.toMatch(/currentPlayer\s*=\s*\(?\s*1\s*-/);
      expect(src, 'turn counting belongs in beginNextTurn').not.toMatch(/G\.turn\+\+/);
    });

  it.each(Object.entries(ENGINES))('%s does not re-implement the per-turn reset', (_name, file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const marker of RESET_MARKERS) {
      expect(src, `${marker} belongs in turnLifecycle.ts, not in this engine`).not.toContain(marker);
    }
  });

  it('draws every turn, including the first player’s first one', () => {
    const shared = stripComments(readFileSync(SHARED, 'utf8'));
    expect(shared).toContain("G.phase = 'draw'");
    // The exact shape of the shipped bug: a ternary that clobbered setup()'s own 'draw'.
    expect(shared).not.toMatch(/turn === 1 \?/);
  });

  it('only runs between-turn effects from turn 2 onward', () => {
    expect(readFileSync(SHARED, 'utf8')).toContain('if (G.turn > 1) processBetweenTurns(G)');
  });
});

describe('setup()', () => {
  const base = { decks: [basicOnlyDeckIds(), basicOnlyDeckIds()], cardData: testCardData(), seed: 12345 };

  it('starts a headless game on turn 1 in the draw phase — the first player draws too', () => {
    const G = setup(base);
    expect(G.turn).toBe(1);
    expect(G.phase).toBe('draw');
  });

  it('deals 7 cards, 6 prizes, and an Active to both non-interactive players', () => {
    const G = setup(base);
    for (const p of G.players) {
      expect(p.prizes).toHaveLength(6);
      expect(p.active).not.toBeNull();
      // 7 drawn, minus the one placed as Active and any further Basics auto-benched.
      expect(p.hand.length + 1 + p.bench.filter(Boolean).length).toBe(7);
      expect(p.deck).toHaveLength(60 - 7 - 6);
    }
  });

  it('never loses a card during setup, even from an all-Basic opening hand', () => {
    // Regression: placeBasics used to splice each extra Basic out of hand before looking for a
    // free bench slot, so a 7-Basic opening hand (1 Active + 5 benched + 1 over) silently
    // destroyed the leftover — that player started the game with 59 cards.
    for (let seed = 1; seed <= 25; seed++) {
      const G = setup({ ...base, seed });
      for (const [i, p] of G.players.entries()) {
        const total =
          p.deck.length + p.hand.length + p.prizes.length + p.discardPile.length +
          p.exileZone.length + (p.active ? 1 : 0) + p.bench.filter(Boolean).length;
        expect(total, `player ${i} lost a card at seed ${seed}`).toBe(60);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = setup(base);
    const b = setup(base);
    expect(a.players[0].hand.map(c => c.cardData.id)).toEqual(b.players[0].hand.map(c => c.cardData.id));
    expect(a.coinWinner).toBe(b.coinWinner);
  });

  it('routes an interactive seat through choose_active instead of auto-placing its Active', () => {
    const G = setup({ ...base, interactivePlayer: 0 });
    expect(['choose_first', 'choose_active']).toContain(G.phase);
    expect(G.players[0].active).toBeNull();
    expect(G.players[1].active).not.toBeNull();
  });

  it('throws rather than looping forever on a deck with no Basic Pokémon', () => {
    const energyOnly = Array.from({ length: 60 }, () => 'TEST-003');
    expect(() => setup({ ...base, decks: [energyOnly, basicOnlyDeckIds()] })).toThrow(/no Basic Pok/i);
  });
});

describe('beginNextTurn', () => {
  /** Player 1's Active dies to its own Poison during the turn transition, handing player 0 their
   * sixth prize. `handleKo` never writes `G.winner`, so before beginNextTurn owned this step only
   * humanBattle noticed — battleRunner and battles.ts let the defeated player take one more
   * action, which also put their reported turn counts out by one. */
  function poisonedIntoLastPrize() {
    const G = makeState({ turn: 4, currentPlayer: 0, phase: 'end' });
    G.players[0].takenPrizes = 5;
    G.players[0].prizes = [makeGameCard(BASIC_MON, 0)];
    const dying = makeGameCard(BASIC_MON, 1, { damage: 50, statusConditions: ['Poisoned'] });
    G.players[1].active = dying;
    G.players[1].bench = [makeGameCard(BASIC_MON, 1), null, null, null, null];
    return G;
  }

  it('ends the game when the between-turns tick takes the last prize', () => {
    const G = poisonedIntoLastPrize();
    expect(beginNextTurn(G)).toBe(true);
    expect(G.winner).toBe(0);
    expect(G.winReason).toBe('took all prizes');
  });

  it('otherwise hands the turn over and reports the game is still on', () => {
    const G = makeState({ turn: 4, currentPlayer: 0, phase: 'end' });
    // Fixture decks are empty, and beginNextTurn moves to the draw phase — which is itself a
    // loss condition. Give the incoming player something to draw.
    G.players[1].deck = [makeGameCard(BASIC_MON, 1)];
    expect(beginNextTurn(G)).toBe(false);
    expect(G.currentPlayer).toBe(1);
    expect(G.turn).toBe(5);
    expect(G.phase).toBe('draw');
  });
});
