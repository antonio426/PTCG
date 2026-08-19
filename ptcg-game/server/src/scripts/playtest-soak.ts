/**
 * Plays full games with the real move loop and checks the invariants in `game/invariants.ts`
 * after EVERY move, reporting the seed and move sequence needed to reproduce any violation.
 *
 * Why this exists: the coverage/clause/trigger audits all ask "does a handler exist?", and every
 * bug reported from actual play was a different kind — a handler that exists but corrupts state,
 * or one offered when it can do nothing. This is the tool that looks for those without a human
 * having to hit them first.
 *
 * Reuses battleRunner's own exported loop pieces (applyTurnBegin/executeMove/advanceTurn) rather
 * than copying them: a fourth copy of the turn lifecycle is exactly what CLAUDE.md warns about,
 * and the drift guard in tests/turn-lifecycle.test.ts only covers the three that exist.
 *
 *   npx tsx src/scripts/playtest-soak.ts [--games N] [--decks N] [--seed N] [--verbose]
 */
import * as fs from 'fs';
import * as path from 'path';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { applyTurnBegin, advanceTurn, checkEndCondition, executeMove } from '../ai/battleRunner';
import { HeuristicAI } from '../ai/heuristicAI';
import { boardFingerprint, checkAllInvariants, checkMoveHadEffect, Violation } from '../game/invariants';
import type { PtcgGameState } from '../game/GameState';

const dataDir = path.resolve(__dirname, '../../data');
const OUT = path.resolve(__dirname, '../../../data-scraped/playtest-soak.json');

const arg = (flag: string, fallback: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : fallback;
};

interface Finding {
  rule: string;
  detail: string;
  seed: number;
  deckA: string;
  deckB: string;
  turn: number;
  moveIndex: number;
  move: string;
  recentMoves: string[];
}

async function main() {
  const gamesPerPair = arg('--games', 4);
  const deckCount = arg('--decks', 12);
  const baseSeed = arg('--seed', 1000);
  const verbose = process.argv.includes('--verbose');

  const cards = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8')).data as any[];
  const cardData: Record<string, any> = {};
  for (const c of cards) cardData[c.id] = c;
  const presets = JSON.parse(fs.readFileSync(path.join(dataDir, 'preset-decks.json'), 'utf-8')) as any[];
  const expand = (d: any) => d.entries.flatMap((e: any) => Array(e.count).fill(e.cardId));

  const pool = presets.slice(0, deckCount);
  const findings: Finding[] = [];
  const byCulprit = new Map<string, number>();
  const nameOf = (instanceId: string) => cardData[instanceId.replace(/_\d+$/, '')]?.name ?? instanceId;
  const seenRules = new Map<string, number>();
  let games = 0, movesChecked = 0;

  for (let i = 0; i + 1 < pool.length; i += 2) {
    const a = pool[i], b = pool[i + 1];
    const deckA = expand(a), deckB = expand(b);
    const expectedTotal = deckA.length + deckB.length;

    for (let g = 0; g < gamesPerPair; g++) {
      const seed = baseSeed + i * 1000 + g;
      const G: PtcgGameState = setup({ decks: [deckA, deckB], cardData, seed });
      const ai = new HeuristicAI();
      const recent: string[] = [];
      let lastCulprit = '(setup)';

      const record = (v: Violation, moveIndex: number, move: string) => {
        seenRules.set(v.rule, (seenRules.get(v.rule) ?? 0) + 1);
        // Games are NOT reproducible from the seed alone — HeuristicAI and every coin flip use
        // Math.random() — so a single example is thin evidence. Tally by rule + move + card so
        // the report shows whether a rule fires on one card or right across the pool.
        byCulprit.set(`${v.rule} | ${lastCulprit}`, (byCulprit.get(`${v.rule} | ${lastCulprit}`) ?? 0) + 1);
        // One example per rule per deck pair keeps the report readable; the counts above carry
        // the real frequency.
        if (findings.some(f => f.rule === v.rule && f.deckA === a.name && f.deckB === b.name)) return;
        findings.push({
          rule: v.rule, detail: v.detail, seed, deckA: a.name, deckB: b.name,
          turn: G.turn, moveIndex, move, recentMoves: [...recent].slice(-8),
        });
      };

      applyTurnBegin(G);
      for (const v of checkAllInvariants(G, expectedTotal)) record(v, 0, '(setup)');

      let moveIndex = 0;
      while (G.winner === null && moveIndex < 2000) {
        moveIndex++;
        const playerIdx = G.currentPlayer;
        const legalMoves = getLegalMoves(G, playerIdx);
        if (legalMoves.length === 0) break;

        const { action } = await ai.decide(G, playerIdx, legalMoves);
        const label = `${action.type}${action.payload ? ' ' + JSON.stringify(action.payload) : ''}`;
        recent.push(label);

        const cid = (action.payload as any)?.cardId;
        // For a resolve_choice the interesting name is the effect being resolved, not the move
        // type — read it before executeMove clears the pending choice.
        lastCulprit = action.type === 'resolve_choice'
          ? `resolve_choice / ${G.pendingChoice?.effectKey ?? '?'}`
          : `${action.type}${cid ? ' / ' + nameOf(cid) : ''}`;
        const before = boardFingerprint(G);
        const logLenBefore = G.turnLog.length;
        const turnEnded = executeMove(G, action);
        const after = boardFingerprint(G);
        movesChecked++;

        for (const v of checkMoveHadEffect(action.type, before, after, G.turnLog.length > logLenBefore)) {
          record(v, moveIndex, label);
        }
        for (const v of checkAllInvariants(G, expectedTotal)) record(v, moveIndex, label);

        checkEndCondition(G);
        if (G.winner !== null) break;
        if (turnEnded) { advanceTurn(G); applyTurnBegin(G); }
      }
      games++;
      if (verbose) process.stdout.write(`\r  ${games} games, ${movesChecked} moves, ${findings.length} distinct findings   `);
    }
  }
  if (verbose) process.stdout.write('\r');

  console.log(`games: ${games}  moves checked: ${movesChecked}`);
  console.log(`violations by rule:`);
  if (seenRules.size === 0) console.log('  (none)');
  for (const [rule, n] of [...seenRules].sort((x, y) => y[1] - x[1])) console.log(`  ${rule.padEnd(28)} ${n}`);

  if (byCulprit.size > 0) {
    console.log('\nby rule + card (top 20):');
    for (const [k, n] of [...byCulprit].sort((x, y) => y[1] - x[1]).slice(0, 20)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  }

  if (findings.length > 0) {
    console.log('\nexamples (one per rule per deck pair):');
    for (const f of findings.slice(0, 25)) {
      console.log(`  [${f.rule}] ${f.detail}`);
      console.log(`     seed=${f.seed} ${f.deckA} vs ${f.deckB} turn=${f.turn} move#${f.moveIndex} ${f.move}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ games, movesChecked, byRule: Object.fromEntries(seenRules), byCulprit: Object.fromEntries(byCulprit), findings }, null, 2), 'utf-8');
  console.log(`\nReport -> data-scraped/playtest-soak.json`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}

main();
