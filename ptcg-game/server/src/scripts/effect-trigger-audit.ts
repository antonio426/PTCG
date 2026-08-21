/**
 * Finds "a handler exists, but it doesn't do what the card says" — the gap coverage-report.ts is
 * blind to by construction. Pairs each registered ability/Trainer's PRINTED text against its
 * handler's runtime source and flags text-stated conditions the code shows no sign of
 * implementing. Every check below is derived from a bug that was actually shipped in this repo.
 *
 * Runtime source via Function.prototype.toString() rather than slicing the .ts file: many registry
 * entries are factory-produced (attachEnergyFromHandAbility('碧綠之舞','Grass',1,true)) and a text
 * slice can't see their bodies. The static registry line is unioned in so factory ARGUMENTS
 * (numbers, energy types) are visible too — those live in the call site, not the closure body.
 *
 * Output goes to data-scraped/effect-trigger-audit.md; stdout is counts only.
 *
 * Run with: npx tsx src/scripts/effect-trigger-audit.ts
 *
 * A flag is a lead, not a verdict — read the card and the handler before changing anything. Two
 * unit conventions in this codebase account for most of the noise and are already allowed for:
 * damage COUNTERS in text vs damage POINTS in code (×10), and coin counts spelled as repeated
 * flipCoin() calls. When a new false-positive class turns up, encode it here rather than
 * remembering it — that is the only thing keeping this list short enough to review.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';
import { abilityEffects } from '../game/effects/abilities';
import { trainerEffects } from '../game/effects/trainers';
import { PASSIVE_ABILITY_NAMES } from '../game/effects/passiveAbilities';
import { normalizeAbilityName, normalizeCardName } from '../game/effects/types';
import type { EffectHandler } from '../game/effects/types';

const DATA = path.resolve(__dirname, '../../data');
const SRC = path.resolve(__dirname, '../game/effects');

const cards = (JSON.parse(fs.readFileSync(path.join(DATA, 'cards.json'), 'utf-8')).data as MapCard[])
  .filter(c => c.legalities?.standard === 'Legal');
const decks = JSON.parse(fs.readFileSync(path.join(DATA, 'preset-decks.json'), 'utf-8')) as
  { entries: { cardId: string }[] }[];
const reachableIds = new Set(decks.flatMap(d => d.entries.map(e => e.cardId)));

// ── printed text, plus whether a preset deck can actually put it on the table ────────────────
interface Printed { text: string; reachable: boolean; prints: number; sample: string }
const abilityText = new Map<string, Printed>();
const trainerText = new Map<string, Printed>();
const note = (m: Map<string, Printed>, key: string, text: string, id: string, reachable: boolean) => {
  const prev = m.get(key);
  if (!prev) { m.set(key, { text, reachable, prints: 1, sample: id }); return; }
  prev.prints++;
  // Prefer a reachable print's wording — that's the one the player will actually meet.
  if (reachable && !prev.reachable) { prev.text = text; prev.sample = id; }
  prev.reachable ||= reachable;
};
for (const c of cards) {
  const reachable = reachableIds.has(c.id);
  for (const a of c.abilities || []) {
    if (a.text?.trim()) note(abilityText, normalizeAbilityName(a.name), a.text, c.id, reachable);
  }
  if (c.supertype === 'Trainer') {
    const t = (c as never as { effect?: string; text?: string }).effect
      || (c as never as { text?: string }).text || (c.rules || []).join(' ');
    if (t?.trim()) note(trainerText, normalizeCardName(c.name), t, c.id, reachable);
  }
}

// ── handler fingerprint = runtime bodies ∪ the static registry line (factory args live there) ──
const registrySrc = {
  ability: fs.readFileSync(path.join(SRC, 'abilities.ts'), 'utf-8'),
  trainer: fs.readFileSync(path.join(SRC, 'trainers.ts'), 'utf-8'),
};
function registryLine(src: string, key: string): string {
  // The registry maps read `'名稱': handlerOrFactoryCall(...),` — grab that whole entry.
  const i = src.indexOf(`'${key}':`);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\n', i) + 1);
}

/** Top-level `const x = …` / `function x(…)` block for an identifier, up to the next top-level
 * declaration. Crude, but every effects file follows that one-declaration-per-block style. */
function blockFor(src: string, id: string): string {
  const m = src.match(new RegExp(`^(?:export )?(?:const|function) ${id}\\b`, 'm'));
  if (!m || m.index === undefined) return '';
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/^(?:export )?(?:const|function) \w/m);
  return m[0] + (next < 0 ? rest : rest.slice(0, next));
}

/** Runtime bodies ∪ registry line ∪ the definitions they name. Both hops matter: toString() is the
 * only way to see a factory's real body, but a factory's ARGUMENTS (numbers, energy types) live at
 * the call site, and helpers it calls (a shared `gateOk`) live outside the closure text entirely.
 * Without following those, every factory-built entry false-positives on the number and gate checks. */
/** Just this entry's own bodies — no expansion. Checks that ask "does THIS card do X" have to use
 * it: the deep fingerprint below pulls in whole neighbouring blocks, so a sibling's coin flip or
 * number would answer for a card that never does either. */
function directFingerprint(h: EffectHandler, src: string, key: string): string {
  return [h.start, h.resume, h.canPlay].map(f => (f ? String(f) : '')).join('\n') + '\n' + registryLine(src, key);
}

function fingerprint(h: EffectHandler, src: string, key: string): string {
  let fp = directFingerprint(h, src, key);
  const seen = new Set<string>();
  // 3 hops: registry key -> const -> factory call -> the shared helper the factory delegates to.
  // 不公印章's gate sits exactly that deep (unfairSeal -> mutualHandResetAbility ->
  // ownPokemonFaintedLastTurn), and at 2 hops it false-positived as ungated.
  for (let hop = 0; hop < 3; hop++) {
    const ids = [...new Set(fp.match(/\b[a-z][A-Za-z0-9_]{3,}\b/g) || [])].filter(i => !seen.has(i));
    let added = '';
    for (const id of ids) { seen.add(id); added += blockFor(src, id); }
    if (!added) break;
    fp += '\n' + added;
  }
  return fp;
}

// ── checks (each one is a bug this repo actually shipped) ────────────────────────────────────
interface Flag { check: string; name: string; reachable: boolean; prints: number; sample: string; text: string; why: string }
const flags: Flag[] = [];
const flag = (check: string, name: string, p: Printed, why: string) =>
  flags.push({ check, name, reachable: p.reachable, prints: p.prints, sample: p.sample, text: p.text, why });

/** Drop the leading "在自己的回合時可使用1次，" style trigger clause before analysing the EFFECT,
 * so its zone/number words don't get read as part of what the effect does. */
const effectClause = (t: string) => {
  const i = t.indexOf('。');
  return i > 0 && /可使用1次|放置於備戰區時|並完成進化時/.test(t.slice(0, i)) ? t.slice(i + 1) : t;
};

function runChecks(kind: 'ability' | 'trainer', key: string, h: EffectHandler, p: Printed) {
  const src = kind === 'ability' ? registrySrc.ability : registrySrc.trainer;
  const fp = fingerprint(h, src, key);
  const fpDirect = directFingerprint(h, src, key);

  // B3 — entry-timing. The 17-ability pass (1c7d058) gated the ones it found; this re-checks all.
  if (/放置於備戰區時|放置於場上時|並完成進化時|進化成.{0,12}時/.test(p.text)
    && !/playedOrEvolvedThisTurn|pokemonPlayedThisTurn/.test(fp)) {
    flag('B3 entry-timing', key, p, 'text restricts to the turn it entered play; no pokemonPlayedThisTurn gate');
  }

  // B4 — "own Pokémon was KO'd during the opponent's last turn" (扭轉乾坤 / 不公印章).
  if (/在上(個|一個)對手的回合.{0,20}昏厥/.test(p.text) && !/lastPokemonFaintedTurn/.test(fp)) {
    flag('B4 last-turn-KO', key, p, 'text gates on a KO during the opponent\'s last turn; no lastPokemonFaintedTurn check');
  }

  // B2 — printed integers vs literals in the handler (咒詛炸彈 dealt 50 instead of 130).
  // Two unit mismatches are systematic here and must not be read as missing:
  //   N 個傷害指示物 -> the engine stores damage POINTS, so N*10 is the correct literal;
  //   擲 N 次硬幣    -> spelled as N repeated flipCoin() calls, the count never appears.
  //   「只可N張同時使用」 -> a play restriction, not an effect number: the handler expresses it by
  //     looking for another copy in hand ("a second one"), so the digit never appears either.
  const clause = effectClause(p.text).replace(/只可\d+張同時使用。?（[^）]*）/g, '');
  const coinCounts = new Set((clause.match(/擲(\d+)次硬幣/g) || []).map(s => Number(s.match(/\d+/)![0])));
  const counterNums = new Set((clause.match(/(\d+)個傷害指示物/g) || []).map(s => Number(s.match(/\d+/)![0])));
  const nums = [...new Set((clause.match(/\d+/g) || []).map(Number))]
    .filter(n => n >= 2 && !coinCounts.has(n));
  const has = (n: number) => new RegExp(`\\b${n}\\b`).test(fp) || (counterNums.has(n) && new RegExp(`\\b${n * 10}\\b`).test(fp));
  const missing = nums.filter(n => !has(n));
  if (missing.length && nums.length) {
    flag('B2 number', key, p, `printed ${nums.join('/')}, absent from handler: ${missing.join('/')}`);
  }

  // B5 — the text says the PLAYER chooses, but the handler picks for them.
  // A deck search for a SPECIFICALLY NAMED card (選擇1張「脫殼忍者」) has nothing to decide when
  // only one name qualifies, so auto-picking it isn't a deviation from the printed text.
  const blindPick = /在不看|隨機|洗牌後/.test(p.text) || /選擇1張「[^」]+」/.test(p.text);
  if (/選擇(最多)?\d|選擇任意/.test(effectClause(p.text)) && !blindPick
    && (!/prompt:/.test(fp) || /Math\.random/.test(fp))) {
    flag('B5 auto-pick', key, p, /Math\.random/.test(fp) ? 'text says 選擇 but handler uses Math.random' : 'text says 選擇 but handler opens no prompt');
  }

  // B6 — energy-type condition (腎上腺腦力 fired with no Darkness attached).
  const em = p.text.match(/身上附有【(.)】能量/);
  const ZH: Record<string, string> = { 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic', 鬥: 'Fighting', 惡: 'Darkness', 鋼: 'Metal', 龍: 'Dragon', 無: 'Colorless' };
  if (em && ZH[em[1]] && !fp.includes(ZH[em[1]])) {
    flag('B6 energy-gate', key, p, `text requires an attached 【${em[1]}】 (${ZH[em[1]]}) Energy; type absent from handler`);
  }

  // B8 — handler flips a coin the printed text never mentions. Caused by one card reusing
  // another's start() wholesale: 鏽蝕組手下 borrowed 粉碎之錘's and inherited its flip.
  if (/flipCoin\(/.test(fpDirect) && !/硬幣/.test(p.text)) {
    flag('B8 phantom-coin', key, p, 'handler calls flipCoin() but the printed text has no 硬幣 clause');
  }

  // B7 — "放回牌庫" but the handler only ever touches the discard pile (逃跑抽出).
  if (/放回.{0,8}牌庫/.test(p.text) && /discardPile/.test(fp) && !/\.deck/.test(fp)) {
    flag('B7 wrong-zone', key, p, 'text says 放回牌庫 but handler only touches discardPile');
  }
}

for (const [key, h] of Object.entries(abilityEffects)) {
  const p = abilityText.get(key);
  if (p) runChecks('ability', key, h, p);
}
for (const [key, h] of Object.entries(trainerEffects)) {
  const p = trainerText.get(key);
  if (p) runChecks('trainer', key, h, p);
}

// B1 — passive names registered but implemented nowhere in server/src.
const serverSrc = path.resolve(__dirname, '..');
const allSrc: string[] = [];
(function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.ts') && !e.name.startsWith('_')) allSrc.push(fs.readFileSync(full, 'utf-8'));
  }
})(serverSrc);
const passiveBody = allSrc.join('\n');
for (const name of PASSIVE_ABILITY_NAMES) {
  // One occurrence = the PASSIVE_ABILITY_NAMES entry itself; anything real mentions it again.
  const hits = passiveBody.split(name).length - 1;
  if (hits <= 1) {
    const p = abilityText.get(name) || { text: '(no printed text found)', reachable: false, prints: 0, sample: '-' };
    flag('B1 dead-registration', name, p, 'registered in PASSIVE_ABILITY_NAMES, referenced nowhere else in server/src');
  }
}

// ── report ──────────────────────────────────────────────────────────────────────────────────
const order = ['B1 dead-registration', 'B8 phantom-coin', 'B3 entry-timing', 'B6 energy-gate', 'B4 last-turn-KO', 'B7 wrong-zone', 'B2 number', 'B5 auto-pick'];
flags.sort((a, b) =>
  order.indexOf(a.check) - order.indexOf(b.check)
  || Number(b.reachable) - Number(a.reachable)
  || b.prints - a.prints);

const lines = ['# Effect trigger audit', '', 'Each check mirrors a bug this repo actually shipped. `[預組]` = reachable in a preset deck.', ''];
let current = '';
for (const f of flags) {
  if (f.check !== current) { current = f.check; lines.push('', `## ${current} (${flags.filter(x => x.check === current).length})`, ''); }
  lines.push(`- ${f.reachable ? '**[預組]**' : '[  ]'} \`${f.name}\` (${f.sample}, ${f.prints} prints) — ${f.why}`);
  lines.push(`  > ${f.text.replace(/\n/g, ' ')}`);
}
fs.writeFileSync(path.resolve(__dirname, '../../../data-scraped/effect-trigger-audit.md'), lines.join('\n'), 'utf-8');

console.log(`abilities checked: ${Object.keys(abilityEffects).length}, trainers: ${Object.keys(trainerEffects).length}`);
for (const c of order) {
  const g = flags.filter(f => f.check === c);
  if (g.length) console.log(`  ${c}: ${g.length} (${g.filter(f => f.reachable).length} reachable)`);
}
console.log(`\ntotal ${flags.length} -> data-scraped/effect-trigger-audit.md`);
