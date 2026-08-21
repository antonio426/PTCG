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
 *   npx tsx src/scripts/playtest-soak.ts [--games N] [--decks N] [--seed N] [--filter 卡名] [--verbose]
 *   ... [--synthetic] [--covered]
 */
import * as fs from 'fs';
import * as path from 'path';
import { setup } from '../game/setup';
import { getLegalMoves } from '../game/validation';
import { applyTurnBegin, advanceTurn, checkEndCondition, executeMove } from '../ai/battleRunner';
import { HeuristicAI } from '../ai/heuristicAI';
import { RandomAI } from '../ai/aiPlayer';
import { boardFingerprint, checkAllInvariants, checkMoveHadEffect, Violation } from '../game/invariants';
import { inferEvolvesFromSpecies, extractSpeciesName } from '../game/evolutionChains';
import { buildCoveredDecks } from './coveredDecks';
import { resolveGenericAttackEffect, NEUTRAL_BOARD } from '../game/effects/genericAttacks';
import { abilityEffects } from '../game/effects/abilities';
import { PASSIVE_ABILITY_NAMES } from '../game/effects/passiveAbilities';
import { attackEffects, attackEffectKey } from '../game/effects/attacks';
import { normalizeAbilityName } from '../game/effects/types';
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
  const aiKind = process.argv.includes('--ai') ? process.argv[process.argv.indexOf('--ai') + 1] : 'heuristic';

  const cards = JSON.parse(fs.readFileSync(path.join(dataDir, 'cards.json'), 'utf-8')).data as any[];
  const cardData: Record<string, any> = {};
  for (const c of cards) cardData[c.id] = c;
  const presets = JSON.parse(fs.readFileSync(path.join(dataDir, 'preset-decks.json'), 'utf-8')) as any[];
  const expand = (d: any) => d.entries.flatMap((e: any) => Array(e.count).fill(e.cardId));

  // Preset decks are all well-built and similar in shape, so they exercise a narrow slice of the
  // engine. `--synthetic` swaps in deliberately lopsided decks that a player could legally build:
  // barely any Basics, nothing but Tools, deep evolution lines, a pile of Stadiums. Those are the
  // boards where "every Pokémon already has a Tool" or "nothing left to evolve into" actually
  // happen, which is where the last few bugs were hiding.
  const synthetic = process.argv.includes('--synthetic');
  // --covered: decks made of cards whose effects the engine implements. The preset and adversarial
  // pools contain almost none of them, so everything written for custom decks had never actually
  // been played — see buildCoveredDecks.
  const covered = process.argv.includes('--covered');
  // --filter <substring>: soak only the preset decks whose lists contain a card whose name
  // includes the substring. This is how "scale the batch to the change's blast radius" is done in
  // practice — after touching one card's effect, soak exactly the decks that can reach it.
  const filter = process.argv.includes('--filter') ? process.argv[process.argv.indexOf('--filter') + 1] : null;
  const pool = covered
    ? buildCoveredDecks(cards, deckCount, baseSeed)
    : synthetic
    ? buildAdversarialDecks(cards)
    : filter
      ? presets.filter(d => expand(d).some((id: string) => cardData[id]?.name?.includes(filter)))
      : presets.slice(0, deckCount);
  // Adjacent pairing needs two decks; a filter matching exactly one preset still deserves games,
  // so mirror-match it against itself.
  if (filter && pool.length === 1) pool.push(pool[0]);
  const findings: Finding[] = [];
  const byCulprit = new Map<string, number>();
  const nameOf = (instanceId: string) => cardData[instanceId.replace(/_\d+$/, '')]?.name ?? instanceId;
  const seenRules = new Map<string, number>();
  let games = 0, movesChecked = 0;

  // Adjacent pairing (0v1, 2v3, …) only ever tests each deck against one opponent. With the
  // small adversarial pool a full round robin is cheap and puts every lopsided deck against every
  // other — Tool overload vs Stadium churn is exactly the sort of interaction worth reaching.
  const pairs: [number, number][] = [];
  if (synthetic) {
    for (let x = 0; x < pool.length; x++) for (let y = x + 1; y < pool.length; y++) pairs.push([x, y]);
  } else {
    for (let x = 0; x + 1 < pool.length; x += 2) pairs.push([x, x + 1]);
  }

  for (const [i, j] of pairs) {
    const a = pool[i], b = pool[j];
    const deckA = expand(a), deckB = expand(b);
    const expectedTotal = deckA.length + deckB.length;

    for (let g = 0; g < gamesPerPair; g++) {
      const seed = baseSeed + i * 1000 + g;
      const G: PtcgGameState = setup({ decks: [deckA, deckB], cardData, seed });
      // RandomAI explores states a heuristic never walks into — the point of a soak is odd
      // boards, not good play. HeuristicAI stays available for realistic-line coverage.
      const ai = aiKind === 'random' ? new RandomAI() : new HeuristicAI();
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

  console.log(`decks: ${pool.length} (${pool.map(d => d.name).join(' | ').slice(0, 160)}…)`);
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

/**
 * Legal but deliberately lopsided decks, built from real Standard cards. Each targets a board
 * state the preset decks rarely reach.
 */
function buildAdversarialDecks(cards: any[]): { name: string; entries: { cardId: string; count: number }[] }[] {
  const std = cards.filter(c => c.legalities?.standard === 'Legal');
  // Dedupe by printed name: several prints share a name (three 高級球, two 寶可夢交替), and four
  // copies of each would put twelve of one name in a deck.
  const take = (pred: (c: any) => boolean, n: number) => {
    const seen = new Set<string>();
    return std.filter(pred).filter(c => !seen.has(c.name) && seen.add(c.name)).slice(0, n).map(c => c.id);
  };

  const basicEnergy = take(c => c.supertype === 'Energy' && c.subtypes?.includes('Basic Energy'), 1)[0];
  const basics = take(c => c.supertype === 'Pokémon' && c.subtypes?.includes('Basic') && (c.attacks?.length ?? 0) > 0, 8);
  const tools = take(c => c.subtypes?.includes('Pokémon Tool'), 6);
  const stadiums = take(c => c.subtypes?.includes('Stadium'), 6);
  const items = take(c => c.subtypes?.includes('Item') && !c.subtypes?.includes('Pokémon Tool'), 8);
  // A real evolution family. TCGdex's zh-tw locale never populates evolvesFrom (every Stage 1/2
  // card in the dataset is missing it), so this has to go through the same species-chain fallback
  // the engine itself uses — reading the field directly found no families at all and quietly
  // dropped this deck from the pool.
  const stage1 = std.filter(c => c.subtypes?.includes('Stage 1'));
  const family: string[] = [];
  for (const s1 of stage1) {
    const from = s1.evolvesFrom || inferEvolvesFromSpecies(s1.name);
    if (!from) continue;
    const base = std.find(c => c.subtypes?.includes('Basic') && extractSpeciesName(c.name) === from);
    if (base) { family.push(base.id, s1.id); if (family.length >= 4) break; }
  }

  /** Pads to exactly 60 with basic energy, which has no 4-copy limit. */
  const deck = (name: string, parts: { cardId: string; count: number }[]) => {
    const used = parts.reduce((n, p) => n + p.count, 0);
    return { name, entries: [...parts, { cardId: basicEnergy, count: Math.max(0, 60 - used) }] };
  };

  const out: { name: string; entries: { cardId: string; count: number }[] }[] = [];
  if (basics.length) out.push(deck('adversarial: one Basic, all energy', [{ cardId: basics[0], count: 1 }]));
  if (basics.length && tools.length) {
    out.push(deck('adversarial: Tool overload', [
      { cardId: basics[0], count: 4 },
      ...tools.map(t => ({ cardId: t, count: 4 })),
    ]));
  }
  if (basics.length && stadiums.length) {
    out.push(deck('adversarial: Stadium churn', [
      { cardId: basics[0], count: 4 },
      ...stadiums.map(s => ({ cardId: s, count: 4 })),
    ]));
  }
  if (family.length >= 4) {
    out.push(deck('adversarial: evolution lines', [
      { cardId: family[0], count: 4 }, { cardId: family[1], count: 4 },
      { cardId: family[2], count: 4 }, { cardId: family[3], count: 4 },
    ]));
  }
  if (basics.length >= 8) {
    out.push(deck('adversarial: all Basics, no energy', basics.map(b => ({ cardId: b, count: 4 }))));
  }
  if (basics.length && items.length) {
    out.push(deck('adversarial: Item pile', [
      { cardId: basics[0], count: 4 },
      ...items.map(t => ({ cardId: t, count: 4 })),
    ]));
  }
  return out;
}
