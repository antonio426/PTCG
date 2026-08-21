/**
 * Measures how well HeuristicAI plays, as a single number that can be compared across changes.
 *
 * This exists because the attack "choose" conversions moved a pile of decisions out of Math.random
 * and into `HeuristicAI.scoreResolveChoice` — a keyword heuristic that had never decided a deck
 * search or an attach target before. "Did that help or hurt?" needs a measurement, not an opinion.
 *
 * Heuristic vs Random over the same preset decks and the same seeds: a strong player should win
 * clearly, and any regression in choice-making shows up as that gap closing.
 *
 *   npx tsx src/scripts/ai-strength.ts [--games 40] [--decks 8] [--seed 1000] [--covered] [--vs random|heuristic]
 *
 * Measured so far (deterministic, same seeds both sides):
 *   preset decks  — HeuristicAI 84% vs RandomAI
 *   --covered     — 80-90% depending on the pool
 * A kind-aware rewrite of scoreResolveChoice (prefer the target you can KO, borrow the biggest
 * attack, keep the opponent's weakest Bench, take Pokémon with attacks out of the deck) measured
 * IDENTICALLY to the plain keyword heuristic on both pools — those choices are too rare in a real
 * game to move the result — so it was not kept. Re-run the A/B before adding heuristics here; the
 * first attempt "showed" a 23-point regression that was entirely an unseeded deck build.
 */
import * as fs from 'fs';
import * as path from 'path';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { applyTurnBegin, advanceTurn, checkEndCondition, executeMove } from '../ai/battleRunner';
import { HeuristicAI } from '../ai/heuristicAI';
import { RandomAI } from '../ai/aiPlayer';
import type { IAIPlayer } from '../ai/aiPlayer';
import type { PtcgGameState } from '../game/GameState';
import { buildCoveredDecks } from './coveredDecks';

const dataDir = path.resolve(__dirname, '../../data');
const arg = (flag: string, fallback: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : fallback;
};

/**
 * A seeded Math.random for the duration of the measurement.
 *
 * Without it this tool cannot answer the question it exists for: HeuristicAI and every coin flip
 * read Math.random, so two runs of the SAME code over the same seeds differ by several games, and
 * three variants measured at 84%/80%/73% turn out to be one number plus noise. Seeding per game
 * makes an A/B comparison exact — the same games get played, and only the decisions differ.
 */
function installSeededRandom(seed: number): () => void {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => { Math.random = original; };
}

async function main() {
  const games = arg('--games', 40);
  const deckCount = arg('--decks', 8);
  const baseSeed = arg('--seed', 1000);
  const vs = process.argv.includes('--vs') ? process.argv[process.argv.indexOf('--vs') + 1] : 'random';

  const cards = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8')).data as any[];
  const cardData: Record<string, any> = {};
  for (const c of cards) cardData[c.id] = c;
  const presets = JSON.parse(fs.readFileSync(path.join(dataDir, 'preset-decks.json'), 'utf-8')) as any[];
  const expand = (d: any) => d.entries.flatMap((e: any) => Array(e.count).fill(e.cardId));
  // --covered: decks built from cards the engine actually implements. Preset decks contain almost
  // none of the cards whose "choose" effects were converted, so an A/B on them measures nothing —
  // the first attempt at this comparison produced byte-identical runs for both variants.
  // Seeded around the deck build as well: buildCoveredDecks resolves attack texts to decide what
  // counts as "implemented", and coin-flip texts call Math.random while doing it — so an unseeded
  // build hands each run a different deck pool, which is what made two identical code states
  // measure 90% and 85%.
  const restorePool = installSeededRandom(baseSeed);
  const pool = process.argv.includes('--covered')
    ? buildCoveredDecks(cards, Math.max(2, deckCount), baseSeed)
    : presets.slice(0, deckCount);
  restorePool();

  let heuristicWins = 0, other = 0, draws = 0, totalTurns = 0, choicesMade = 0;

  for (let g = 0; g < games; g++) {
    const a = pool[g % pool.length], b = pool[(g + 1) % pool.length];
    // Alternate seats so neither AI keeps the first-player advantage.
    const heuristicSeat: 0 | 1 = (g % 2) as 0 | 1;
    const players: [IAIPlayer, IAIPlayer] = heuristicSeat === 0
      ? [new HeuristicAI(), vs === 'heuristic' ? new HeuristicAI() : new RandomAI()]
      : [vs === 'heuristic' ? new HeuristicAI() : new RandomAI(), new HeuristicAI()];

    const restoreRandom = installSeededRandom(baseSeed + g);
    const G: PtcgGameState = setup({ decks: [expand(a), expand(b)], cardData, seed: baseSeed + g });
    applyTurnBegin(G);
    let safety = 0;
    while (G.winner === null && safety < 2000) {
      safety++;
      const seat = (G.pendingChoice?.player ?? G.currentPlayer) as 0 | 1;
      const legal = getLegalMoves(G, seat);
      if (legal.length === 0) { G.winner = (1 - seat) as 0 | 1; G.winReason = 'no legal moves'; break; }
      const { action } = await players[seat].decide(G, seat, legal);
      if (action.type === 'resolve_choice') choicesMade++;
      const turnEnded = executeMove(G, action, seat);
      checkEndCondition(G);
      if (G.winner !== null) break;
      if (turnEnded) { advanceTurn(G); applyTurnBegin(G); }
    }
    restoreRandom();
    totalTurns += G.turn;
    if (G.winner === null) draws++;
    else if (G.winner === heuristicSeat) heuristicWins++;
    else other++;
    if ((g + 1) % 10 === 0) console.log(`  ${g + 1}/${games} games…`);
  }

  const rate = (heuristicWins / Math.max(1, games)) * 100;
  console.log(`\nHeuristicAI vs ${vs}: ${heuristicWins}W ${other}L ${draws}D over ${games} games`);
  console.log(`win rate: ${rate.toFixed(1)}%  |  avg turns: ${(totalTurns / games).toFixed(1)}  |  choices resolved: ${choicesMade}`);
}

main();
