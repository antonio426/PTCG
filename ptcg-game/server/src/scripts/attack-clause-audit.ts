/**
 * The attack-side counterpart to effect-trigger-audit.ts.
 *
 * Attack logic is text-driven (genericAttacks.ts resolves printed text through ~212 regex
 * branches), so coverage-report.ts calls an attack "covered" as soon as ANY branch matches. That
 * says nothing about whether the branch encoded everything the text asks for. Every branch is
 * fully anchored (^…$), so a regex can't match half a text and drop the rest — but a branch with
 * an optional (?:…)? group or a .+? wildcard CAN match the whole text while quietly ignoring a
 * clause inside it, and that failure is invisible from the outside.
 *
 * So this compares, per attack: how many clauses the printed text contains vs how many distinct
 * effect signals the resolved GenericAttackOutcome actually encodes, and whether every number in
 * the text shows up somewhere in the outcome.
 *
 * Run with: npx tsx src/scripts/attack-clause-audit.ts [--scope standard|preset]
 *
 * Scope defaults to `standard`: every Standard-legal attack, not just the ones a preset deck can
 * reach. The preset scope is what this started as, and it is the wrong default now — the templates
 * written for custom decks (the bulk of them) live on cards no preset list contains, so a
 * preset-scoped run reported "0 gaps" while never looking at them once.
 * Output: data-scraped/attack-clause-audit.md (stdout is counts only).
 *
 * A flag is a lead, not a verdict — several are deliberate documented simplifications.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';
import { resolveGenericAttackEffect, parseBaseNumber, NEUTRAL_BOARD } from '../game/effects/genericAttacks';
import type { GenericAttackOutcome } from '../game/effects/genericAttacks';
import { attackEffects } from '../game/effects/attacks';
import { normalizeCardName } from '../game/effects/types';

const DATA = path.resolve(__dirname, '../../data');
const cards = (JSON.parse(fs.readFileSync(path.join(DATA, 'cards.json'), 'utf-8')).data as MapCard[])
  .filter(c => c.legalities?.standard === 'Legal');
const decks = JSON.parse(fs.readFileSync(path.join(DATA, 'preset-decks.json'), 'utf-8')) as
  { entries: { cardId: string }[] }[];
const reachable = new Set(decks.flatMap(d => d.entries.map(e => e.cardId)));
const scope = process.argv.includes('--scope') ? process.argv[process.argv.indexOf('--scope') + 1] : 'standard';
if (scope !== 'standard' && scope !== 'preset') throw new Error('--scope must be standard or preset');

/** Clauses that describe no effect of their own, or that another outcome key already stands for. */
const IGNORABLE = [
  /不計算弱點/, /^這個情況下$/, /^這個回合$/, /^並且重洗牌庫$/, /^重洗牌庫$/,
  /^無論有多少隻.*也不會重複$/, /^在給對手看過後加入手牌$/, /^若希望$/, /^$/,
  // A damage-boost condition is encoded as a different baseDamage, which the number check below
  // already verifies — counting it as its own signal would flag every tiered coin attack.
  /^若.*則增加\d+點傷害$/,
  // Pure bookkeeping around an effect the outcome already carries: putting revealed cards back,
  // reordering what was looked at. Neither is observable without a card-ordering model, and both
  // ride along with the clause that did the revealing.
  /^然後，將(?:給對手看過的|翻到正面的).*(?:放回|回復)/, /^將(?:給對手看過的|翻到正面的).*(?:放回|回復)/,
  /以任意順序排列/,
];

const splitClauses = (t: string) => t
  .replace(/\[[^\]]*\]/g, '')            // bracketed rule reminders aren't effects
  .replace(/（[^）]*）/g, '')             // ...nor parenthesised ones ("（1隻可選擇2次以上。）")
  .split(/。|並且|然後|之後，|，接著/)
  .map(s => s.trim())
  .filter(s => s && !IGNORABLE.some(r => r.test(s)));

/** Every conditional bonus in the resolver reads the board, and against an all-zero board those
 * conditions are all false — so a text like 「若這隻寶可夢身上附有【雷】能量卡，則增加80點傷害」
 * legitimately encodes nothing and its 80 looks unaccounted for. Resolving against a maximal board
 * as well makes those branches fire, so only genuinely unencoded numbers survive. */
const MAXIMAL_BOARD = Object.fromEntries(
  Object.entries(NEUTRAL_BOARD).map(([k, v]) => {
    if (typeof v === 'number') return [k, 7];
    if (typeof v === 'boolean') return [k, true];
    // Subtype/type lists need plausible members, not just non-emptiness: branches gated on
    // "the defender is an evolution" read defenderSubtypes for 'Stage 1'/'Stage 2', and a list of
    // placeholder strings makes them look unimplemented (厄鬼椪's 極限火焰 was a false positive
    // for exactly this reason).
    if (k.endsWith('Subtypes')) return [k, ['Stage 2', 'ex', 'Basic']];
    // Energy-keyed Records CAN be populated plausibly (unlike name-keyed ones, see BOARD_DEPENDENT
    // below): every branch reading them looks up one of these eleven types.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return [k, Object.fromEntries(['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'].map(ty => [ty, 7]))];
    }
    // Non-empty matters more than plausible: several branches only emit their effect key when a
    // list has entries at all (e.g. defenderAttackNames for the "lock one of the defender's
    // attacks" template), and an empty one makes them look unimplemented.
    if (Array.isArray(v)) return [k, ['Water', 'X']];
    return [k, v];
  })
) as typeof NEUTRAL_BOARD;

/** Board-dependent texts whose numbers can't be checked this way at all. Roughly half of
 * AttackBoardContext is Record/array-shaped (attackerEnergyCounts, ownDiscardEnergyCounts,
 * ownBenchNames…), keyed by energy type or card name — a maximal board can bump the plain numeric
 * fields but has no way to invent plausible keys for those, so their branches never fire and every
 * number in the text looks unencoded. Checking these needs a real game state, not a shape-only
 * board; flagging them here would be 13 guaranteed false positives per run. */
const BOARD_DEPENDENT = /若|×|的數量|的張數|每/;

/** Recursively collect every integer appearing anywhere in the outcome object. */
function outcomeNumbers(o: unknown, acc = new Set<number>()): Set<number> {
  if (typeof o === 'number') acc.add(o);
  else if (Array.isArray(o)) for (const v of o) outcomeNumbers(v, acc);
  else if (o && typeof o === 'object') for (const v of Object.values(o)) outcomeNumbers(v, acc);
  return acc;
}

/** Resolve under both coin outcomes and union the result — branches call Math.random() inline, so
 * a single pass would make coin-gated fields look unencoded half the time. */
function resolveBothCoins(text: string, damage: string) {
  const real = Math.random;
  const runs: GenericAttackOutcome[] = [];
  // Not constant stubs: 「擲硬幣直到出現反面為止」 resolves as `while (Math.random() < 0.5)`, which
  // never terminates against an all-heads constant. Each stub yields a bounded run of one face
  // and then flips to the other, which exercises both branches and always terminates.
  const seq = (first: number, other: number, n = 8) => {
    let i = 0;
    return () => (i++ < n ? first : other);
  };
  for (const stub of [seq(0.99, 0), seq(0, 0.99)]) {
    for (const board of [NEUTRAL_BOARD, MAXIMAL_BOARD]) {
      Math.random = stub as typeof Math.random;
      try {
        const o = resolveGenericAttackEffect(text, damage, board);
        if (o) runs.push(o);
      } catch { /* a throwing branch still means the text WAS recognized */ }
    }
  }
  Math.random = real;
  if (runs.length === 0) return null;
  const keys = new Set<string>();
  const nums = new Set<number>();
  for (const o of runs) {
    for (const k of Object.keys(o)) keys.add(k);
    outcomeNumbers(o, nums);
  }
  return { keys, nums, runs };
}

interface Flag { kind: string; key: string; id: string; text: string; why: string }
const flags: Flag[] = [];

let checked = 0;
/** Prints of one card share its text, and several cards share a text outright — the audit is about
 * texts, so each is checked once and the report carries the print count instead of N duplicates. */
const seenText = new Map<string, number>();
for (const c of cards) {
  if (scope === 'preset' && !reachable.has(c.id)) continue;
  for (const a of c.attacks || []) {
    const text = a.text?.trim();
    if (!text || normalizeCardName(a.name) === '太晶') continue;
    const key = `${normalizeCardName(c.name)}::${normalizeCardName(a.name)}`;
    if (key in attackEffects) continue;  // hand-written handler, not template-driven
    const dedupeKey = `${key}|${text}|${a.damage || '0'}`;
    if (seenText.has(dedupeKey)) { seenText.set(dedupeKey, seenText.get(dedupeKey)! + 1); continue; }
    seenText.set(dedupeKey, 1);

    const res = resolveBothCoins(text, a.damage || '0');
    if (!res) continue;                  // uncovered entirely — that's coverage-report.ts's job
    checked++;

    const base = parseBaseNumber(a.damage || '0');
    const signals = [...res.keys].filter(k => k !== 'coinFlipNote').length
      + (res.runs.some(o => o.baseDamage !== undefined && o.baseDamage !== base) ? 1 : 0);
    const clauses = splitClauses(text);

    // 「若…，則這個招式失敗」 texts legitimately resolve to nothing when the board doesn't meet
    // their condition, and the shape-only board usually doesn't (a required card name in hand,
    // a Supporter played this turn). Resolving to exactly "no damage, no effects" IS the encoding.
    const resolvedAsFailure = /則這個招式失敗/.test(text)
      && res.runs.every(o => o.baseDamage === 0 && Object.keys(o).filter(k => k !== 'baseDamage' && k !== 'coinFlipNote').length === 0);
    if (resolvedAsFailure) continue;

    if (clauses.length > signals) {
      flags.push({ kind: 'clause-gap', key, id: c.id, text,
        why: `${clauses.length} clauses but only ${signals} outcome signal(s) [${[...res.keys].join(', ') || 'none'}]` });
    }

    // Numbers in the text that appear nowhere in the outcome, allowing for a damage delta.
    // Counted over the clauses that survived IGNORABLE, not the raw text: a number inside a clause
    // the audit already accepts as unmodellable (「以任意順序排列」) has nothing to be encoded in.
    const textNums = [...new Set((clauses.join('。').match(/\d+/g) || []).map(Number))].filter(n => n >= 2);
    const missing = textNums.filter(n => {
      // Signed: a "+50 damage taken next turn" is stored as damageReduction -50, and the printed
      // number is still fully encoded.
      if (res.nums.has(n) || res.nums.has(-n) || res.nums.has(n * 10) || res.nums.has(-n * 10)) return false;
      return !res.runs.some(o => o.baseDamage !== undefined && (o.baseDamage - base === n || (n !== 0 && (o.baseDamage - base) % n === 0 && o.baseDamage !== base)));
    });
    if (missing.length && !BOARD_DEPENDENT.test(text)) {
      flags.push({ kind: 'number-gap', key, id: c.id, text, why: `printed ${textNums.join('/')}, unaccounted for: ${missing.join('/')}` });
    }
  }
}

const lines = [`# Attack clause audit (${scope === 'standard' ? 'Standard-legal, whole format' : 'preset-deck-reachable'})`, '',
  'Compares each printed attack text against the effect signals its resolved outcome encodes.',
  'A flag is a lead, not a verdict — some are deliberate documented simplifications.', ''];
for (const kind of ['clause-gap', 'number-gap']) {
  const g = flags.filter(f => f.kind === kind);
  lines.push('', `## ${kind} (${g.length})`, '');
  for (const f of g) {
    lines.push(`- \`${f.key}\` (${f.id}) — ${f.why}`);
    lines.push(`  > ${f.text.replace(/\n/g, ' ')}`);
  }
}
fs.writeFileSync(path.resolve(__dirname, '../../../data-scraped/attack-clause-audit.md'), lines.join('\n'), 'utf-8');

console.log(`${scope} template-driven attack texts checked: ${checked}`);
for (const kind of ['clause-gap', 'number-gap']) console.log(`  ${kind}: ${flags.filter(f => f.kind === kind).length}`);
console.log(`\ntotal ${flags.length} -> data-scraped/attack-clause-audit.md`);
