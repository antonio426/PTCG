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

/**
 * Outcome fields whose apply block takes the decision away from the player.
 *
 * Two ways that happens, and only the first was modelled for a long time:
 *  1. the block picks at RANDOM (`Math.random()`), the classic auto-pick;
 *  2. the block decides DETERMINISTICALLY — spends everything eligible, or the first N — which is
 *     just as much a decision when the card says 「任意數量」. 烈獄狂火X was discarding every Fire
 *     Energy on the board this way, and a random-only detector could never see it.
 *
 * (2) is recognised by the shape those effects share: the block ends by setting `baseDamage` from
 * the COUNT of what it just spent (`… .length * amount`), i.e. "how much you pay is how hard you
 * hit" — which is precisely the decision being made for the player.
 */
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
    const body = src.slice(m.index, end);
    // A block that calls raiseAttackPick has been converted: it asks the player, and only falls
    // back to picking when there is nothing to decide (no candidates, or a choice already up).
    // queueAttackPick counts too — it is the same hand-back, for an attack that asks a SECOND
    // question, where raiseAttackPick would (correctly) refuse because one is already standing.
    if (/(raise|queue)AttackPick\(/.test(body)) continue;
    const picksAtRandom = /Math\.random\(\)/.test(body);
    const spendsToScaleDamage = /baseDamage\s*=\s*[^;]*\.length\s*\*/.test(body)
      || /baseDamage\s*=\s*discarded\s*\*/.test(body);
    if (picksAtRandom || spendsToScaleDamage) found.add(m[1]);
  }
  return found;
}

const AUTO = autoPickFields();
// 「任意數量」/「任意張數」 is a player decision every bit as much as 「選擇」 is — the card is
// telling you to pick how many, and how many is the whole point when the count scales the damage.
// Reported by a player: 超級噴火龍Xex's 烈獄狂火X (「將自己的場上寶可夢身上附加的任意數量的【火】
// 能量卡丟棄，造成其張數×90點傷害」) was discarding EVERY Fire Energy on the board, and this audit
// could not see it because the text never says 選擇.
const CHOOSES = /選擇|任意數量|任意張數/;
/** 「隨機」 texts are supposed to be random; so are coin flips. */
const REALLY_RANDOM = /隨機|不看.{0,4}正面/;

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
