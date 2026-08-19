import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from '../src/game/setup';
import { basicOnlyDeckIds, testCardData } from './fixtures';

const GAME_DIR = join(__dirname, '..', 'src', 'game');

/**
 * The turn-begin block is hand-copied into three engines (see CLAUDE.md, "Two parallel battle
 * engines"). Extract it from each so they can be compared as text — the documented failure mode
 * here is one copy silently getting a rule right that the others get wrong.
 */
function turnBeginBlock(file: string): string {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf('activeIdAtTurnStart = ');
  expect(start, `no turn-begin block found in ${file}`).toBeGreaterThan(-1);
  const endMarker = 'stadiumActionUsedThisTurn = false;';
  const end = src.indexOf(endMarker, start);
  expect(end, `turn-begin block in ${file} has no stadiumActionUsedThisTurn reset`).toBeGreaterThan(-1);
  return src.slice(start, end + endMarker.length);
}

/** Comments and indentation differ freely between the copies; the statements must not. */
function normalizeBlock(block: string): string {
  return block
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const COPIES = {
  'battleRunner.ts': join(GAME_DIR, '..', 'ai', 'battleRunner.ts'),
  'humanBattle.ts': join(GAME_DIR, '..', 'routes', 'humanBattle.ts'),
  'PtcgGame.ts': join(GAME_DIR, 'PtcgGame.ts'),
};

describe('turn-begin lifecycle is identical across all three engines', () => {
  it('resets the same per-turn state in the same way', () => {
    const [reference, ...rest] = Object.entries(COPIES).map(
      ([name, file]) => [name, normalizeBlock(turnBeginBlock(file))] as const,
    );
    for (const [name, block] of rest) {
      expect(block, `${name} drifted from ${reference[0]}`).toBe(reference[1]);
    }
  });

  it.each(Object.entries(COPIES))(
    '%s sets phase to draw unconditionally (never `turn === 1 ? main : draw`)',
    (_name, file) => {
      const block = normalizeBlock(turnBeginBlock(file));
      expect(block).toContain("phase = 'draw'");
      // The exact shape of the shipped bug: a ternary that clobbered setup()'s own 'draw',
      // so the player going first never drew. Guard the shape, not just the string.
      expect(block).not.toMatch(/turn === 1 \?/);
    },
  );

  it.each(Object.entries(COPIES))(
    '%s only runs between-turn effects from turn 2 onward',
    (_name, file) => {
      expect(normalizeBlock(turnBeginBlock(file))).toContain('if (G.turn > 1) processBetweenTurns(G)');
    },
  );
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
