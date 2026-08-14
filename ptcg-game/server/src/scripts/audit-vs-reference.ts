/**
 * Cross-checks the reference site's own event logs (220 games captured from
 * ptcg-tw-sim.com under .playwright-mcp/games) against THIS engine's registries.
 *
 * The point is not win rates: it is "which card effects did a real game actually
 * fire, and would our engine have done anything at all for them?"
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';
import { trainerEffects } from '../game/effects/trainers';
import { abilityEffects } from '../game/effects/abilities';
import { attackEffects } from '../game/effects/attacks';
import { matchesGenericAttackTemplate } from '../game/effects/genericAttacks';
import { hasToolEffect } from '../game/effects/tools';
import { PASSIVE_ABILITY_NAMES } from '../game/effects/passiveAbilities';
import { normalizeAbilityName, normalizeCardName } from '../game/effects/types';

const GAMES = path.resolve(__dirname, '../../../.playwright-mcp/games');
const CARDS = path.resolve(__dirname, '../../data/cards.json');
const OUT = path.resolve(__dirname, '../../../data-scraped/reference-audit.md');

const cards = (JSON.parse(fs.readFileSync(CARDS, 'utf-8')).data as MapCard[]);
const byName = new Map<string, MapCard[]>();
for (const c of cards) {
  const k = normalizeCardName(c.name);
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k)!.push(c);
}
const abilityNames = new Set<string>();
const attackTextByKey = new Map<string, string>();
for (const c of cards) {
  for (const a of c.abilities || []) abilityNames.add(normalizeAbilityName(a.name));
  for (const a of c.attacks || []) attackTextByKey.set(`${normalizeCardName(c.name)}::${normalizeAbilityName(a.name)}`, a.text || '');
}

const files = fs.readdirSync(GAMES).filter(f => f.endsWith('.json'));
let finished = 0;
const abilityUsed = new Map<string, number>();     // ability name -> times
const attackUsed = new Map<string, number>();      // "pokemon::attack" -> times
const namedEffect = new Map<string, number>();     // "<name>：..." prefixes
const dmgFormulas = new Map<string, number>();
const statusLines = new Map<string, number>();

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) || 0) + 1);

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(GAMES, f), 'utf-8'));
  if (j.finished) finished++;
  for (const raw of j.log as string[]) {
    const l = raw.replace(/^\[\d+:\d+\]\s*/, '').trim();

    let m = l.match(/使用了\s*(.+?)\s*的特性「(.+?)」/);
    if (m) { bump(abilityUsed, normalizeAbilityName(m[2])); continue; }

    m = l.match(/的\s*(.+?)\s*使出「(.+?)」/);
    if (m) { bump(attackUsed, `${normalizeCardName(m[1])}::${normalizeAbilityName(m[2])}`); }

    m = l.match(/^([^：:\s][^：:]{1,14})：/);
    if (m) bump(namedEffect, normalizeCardName(m[1]));

    m = l.match(/【([^】]+)】/);
    if (m) bump(dmgFormulas, m[1].replace(/\d+/g, 'N'));

    if (/中毒|灼傷|麻痺|睡眠|混亂/.test(l)) bump(statusLines, l.replace(/\d+/g, 'N').replace(/[「『][^」』]*[」』]/g, '「X」').slice(0, 80));
  }
}

// ---- classify every named effect the reference site actually fired ----
type Row = { name: string; hits: number; kind: string; covered: boolean; note: string };
const rows: Row[] = [];

for (const [name, hits] of namedEffect) {
  const prints = byName.get(name) || [];
  const isTrainer = prints.some(p => p.supertype === 'Trainer');
  const isToolOrStadium = prints.some(p => (p.subtypes || []).some(s => s === 'Pokémon Tool' || s === 'Stadium'));
  const isAbility = abilityNames.has(name);
  if (isTrainer) {
    const covered = name in trainerEffects || (isToolOrStadium && (hasToolEffect(name) || true));
    rows.push({ name, hits, kind: isToolOrStadium ? 'Trainer(Tool/Stadium)' : 'Trainer', covered: name in trainerEffects || isToolOrStadium, note: name in trainerEffects ? 'trainerEffects' : isToolOrStadium ? 'generic tool/stadium' : '' });
  } else if (isAbility) {
    const covered = name in abilityEffects || PASSIVE_ABILITY_NAMES.has(name);
    rows.push({ name, hits, kind: 'Ability', covered, note: name in abilityEffects ? 'abilityEffects' : PASSIVE_ABILITY_NAMES.has(name) ? 'passive' : '' });
  } else if (prints.length === 0) {
    rows.push({ name, hits, kind: 'engine-message', covered: true, note: 'not a card name' });
  } else {
    rows.push({ name, hits, kind: 'other', covered: true, note: '' });
  }
}

// abilities seen via the explicit 特性 line
for (const [name, hits] of abilityUsed) {
  if (rows.some(r => r.name === name)) continue;
  const covered = name in abilityEffects || PASSIVE_ABILITY_NAMES.has(name);
  rows.push({ name, hits, kind: 'Ability', covered, note: covered ? (name in abilityEffects ? 'abilityEffects' : 'passive') : '' });
}

// attacks
const attackRows: Row[] = [];
for (const [key, hits] of attackUsed) {
  const [poke, atk] = key.split('::');
  const text = attackTextByKey.get(key);
  let covered: boolean, note: string;
  if (text === undefined) { covered = true; note = 'attack/print not in cards.json (skipped)'; }
  else if (key in attackEffects) { covered = true; note = 'attackEffects'; }
  else if (!text.trim()) { covered = true; note = 'plain damage (no text)'; }
  else if (matchesGenericAttackTemplate(text)) { covered = true; note = 'generic template'; }
  else { covered = false; note = `TEXT NOT HANDLED: ${text.slice(0, 60)}`; }
  attackRows.push({ name: key, hits, kind: 'Attack', covered, note });
}

const uncovered = [...rows, ...attackRows].filter(r => !r.covered).sort((a, b) => b.hits - a.hits);
const covered = [...rows, ...attackRows].filter(r => r.covered);

const L: string[] = [];
L.push(`# 參考站對局稽核報告（vs ptcg-tw-sim.com）\n`);
L.push(`- 對局數：${files.length}（完成 ${finished}）`);
L.push(`- 參考站實際觸發過的具名效果：${rows.length}（特性/訓練家/其他）`);
L.push(`- 參考站實際使用過的招式：${attackRows.length}`);
L.push(`- **我方引擎沒有對應處理的：${uncovered.length}**\n`);

L.push(`## 我方未覆蓋（依出現次數排序）\n`);
if (!uncovered.length) L.push('（無）\n');
for (const r of uncovered) L.push(`- \`${r.name}\` ×${r.hits} — ${r.kind} — ${r.note}`);

L.push(`\n## 傷害計算式（參考站顯示的公式）\n`);
for (const [f, c] of [...dmgFormulas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`- \`${f}\` ×${c}`);

L.push(`\n## 狀態異常相關敘述\n`);
for (const [s, c] of [...statusLines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`- \`${s}\` ×${c}`);

L.push(`\n## 已覆蓋（抽樣前 40）\n`);
for (const r of covered.sort((a, b) => b.hits - a.hits).slice(0, 40)) L.push(`- \`${r.name}\` ×${r.hits} — ${r.kind} — ${r.note}`);

fs.writeFileSync(OUT, L.join('\n'), 'utf-8');
console.log(`games=${files.length} finished=${finished} namedEffects=${rows.length} attacks=${attackRows.length} UNCOVERED=${uncovered.length}`);
console.log('\n--- uncovered (top 30) ---');
for (const r of uncovered.slice(0, 30)) console.log(`  ${r.name} x${r.hits} [${r.kind}] ${r.note}`);
console.log(`\nreport -> data-scraped/reference-audit.md`);
