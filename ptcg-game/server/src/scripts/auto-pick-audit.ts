/**
 * Finds attacks whose printed text says the player CHOOSES, while the engine picks for them.
 *
 * applyAttackOutcome resolves choice-shaped effects by picking at random (see the comment at its
 * "Choice-requiring generic effects" block) — which is right for 「隨機」 texts and wrong for 「選擇」
 * ones, where the whole point of the card is the decision. Nothing measured the split.
 *
 * The auto-picking outcome fields are derived, not listed: for every `if (genericOutcome.X)` block
 * in attackResolution.ts, X counts as auto-picking when its body calls Math.random. That way a new
 * effect added with a random pick shows up here without anyone remembering to register it.
 *
 * Run: npx tsx src/scripts/auto-pick-audit.ts
 * Output: data-scraped/auto-pick-audit.md
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';
import { resolveGenericAttackEffect, NEUTRAL_BOARD } from '../game/effects/genericAttacks';
import { attackEffects } from '../game/effects/attacks';
import { normalizeCardName } from '../game/effects/types';

const DATA = path.resolve(__dirname, '../../data');
const cards = (JSON.parse(fs.readFileSync(path.join(DATA, 'cards.json'), 'utf-8')).data as MapCard[])
  .filter(c => c.legalities?.standard === 'Legal');

/** Outcome fields whose apply block picks at random. */
function autoPickFields(): Set<string> {
  const src = fs.readFileSync(path.resolve(__dirname, '../game/attackResolution.ts'), 'utf-8');
  const found = new Set<string>();
  const re = /if \(genericOutcome[?.]*\.([A-Za-z0-9_]+)[^)]*\) \{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Brace-matched body. A "scan the next N characters" approximation reads into the FOLLOWING
    // block and reports fields that don't pick at all — discardSelfEnergyCount already raises a
    // real choice and was flagged that way.
    let depth = 0, i = re.lastIndex - 1, end = src.length;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (/Math\.random\(\)/.test(src.slice(m.index, end))) found.add(m[1]);
  }
  return found;
}

const AUTO = autoPickFields();
const CHOOSES = /選擇/;
/** 「隨機」 texts are supposed to be random; so are coin flips. */
const REALLY_RANDOM = /隨機|不看正面/;

interface Row { key: string; id: string; prints: number; text: string; fields: string[] }
const rows = new Map<string, Row>();

for (const c of cards) {
  for (const a of c.attacks || []) {
    const text = a.text?.trim();
    if (!text || !CHOOSES.test(text) || REALLY_RANDOM.test(text)) continue;
    const key = `${normalizeCardName(c.name)}::${normalizeCardName(a.name)}`;
    if (key in attackEffects) continue;         // hand-written handler — audited separately
    const existing = rows.get(key + text);
    if (existing) { existing.prints++; continue; }

    const real = Math.random;
    let outcome;
    try {
      Math.random = (() => 0.5) as typeof Math.random;
      outcome = resolveGenericAttackEffect(text, a.damage || '0', NEUTRAL_BOARD);
    } catch { outcome = undefined; } finally { Math.random = real; }
    if (!outcome) continue;

    const fields = Object.keys(outcome).filter(k => AUTO.has(k));
    if (fields.length === 0) continue;
    rows.set(key + text, { key, id: c.id, prints: 1, text, fields });
  }
}

const sorted = [...rows.values()].sort((a, b) => b.prints - a.prints);
const lines = [
  '# Auto-pick audit (Standard-legal)',
  '',
  'Attacks whose text says 選擇 but whose effect the engine picks at random.',
  `Auto-picking outcome fields detected in attackResolution.ts: ${[...AUTO].sort().join(', ')}`,
  '',
  `## texts (${sorted.length})`,
  '',
];
for (const r of sorted) {
  lines.push(`- \`${r.key}\` (${r.id}, ${r.prints} print${r.prints > 1 ? 's' : ''}) — auto-picked: ${r.fields.join(', ')}`);
  lines.push(`  > ${r.text.replace(/\n/g, ' ')}`);
}
fs.writeFileSync(path.resolve(__dirname, '../../../data-scraped/auto-pick-audit.md'), lines.join('\n'), 'utf-8');
console.log(`auto-picking fields: ${AUTO.size}`);
console.log(`texts that say 選擇 but are auto-picked: ${sorted.length}`);
console.log('-> data-scraped/auto-pick-audit.md');
