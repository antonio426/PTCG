/**
 * Audits server/data/preset-decks.json for prints that aren't standard-legal, and (with --fix)
 * repoints each to the standard-legal print of the same card.
 *
 * WHY: the preset deck lists were originally built against the old scraper's ID scheme (see
 * AGENTS.md's "卡片 ID 格式不一致" issue) and a past migration resolved them by NAME, which
 * silently picked whichever print happened to match first — often a Sword & Shield-era card that
 * has since rotated out of Standard. The engine then faithfully executes that old card's printed
 * attacks, which reads to a player as "this card's effect doesn't match its text". The reported
 * case was 輕飄飄 S5R-027 (自我再生/潑水) appearing where the current SV-era 輕飄飄 (海之影,
 * item-lock) was expected.
 *
 * Swapping genuinely CHANGES how a deck plays: same-name prints from different eras are usually
 * different card designs (different attacks, sometimes different typing), not just new artwork.
 * That's intended here — the goal is decks that are actually Standard-legal.
 *
 * Safety rules when choosing a replacement:
 *  - same name AND same supertype
 *  - for Pokémon, the same evolution stage (Basic / Stage 1 / Stage 2) — swapping a Basic for a
 *    Stage 1 would silently break the deck's evolution line
 *  - prefer an identical attack/ability signature when one exists (a true reprint)
 *  - otherwise prefer the print from the newest set, deterministically
 *  - never invent a card: if no qualifying standard print exists, report and leave it alone
 *
 * Run:  npx tsx src/scripts/audit-preset-decks-standard.ts          (dry run, report only)
 *       npx tsx src/scripts/audit-preset-decks-standard.ts --fix    (rewrites preset-decks.json)
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from '../card-api/types';

const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const DECKS_PATH = path.resolve(__dirname, '../../data/preset-decks.json');
const REPORT_OUT = path.resolve(__dirname, '../../../data-scraped/preset-deck-standard-audit.json');

interface DeckEntry { cardId: string; count: number }
interface PresetDeck { id: string; name: string; entries: DeckEntry[] }

const STAGE_SUBTYPES = ['Basic', 'Stage 1', 'Stage 2'];

function stageOf(c: MapCard): string | null {
  return (c.subtypes || []).find(s => STAGE_SUBTYPES.includes(s)) ?? null;
}

/** Attack+ability fingerprint — two prints with the same fingerprint are the same real card. */
function signature(c: MapCard): string {
  const atk = (c.attacks || [])
    .map(a => `${a.name}:${(a.cost || []).join(',')}:${a.damage}`)
    .sort()
    .join('|');
  const abi = (c.abilities || []).map(a => a.name).sort().join('|');
  return `${atk}##${abi}`;
}

function isStandard(c: MapCard): boolean {
  return c.legalities?.standard === 'Legal';
}

function main() {
  const fix = process.argv.includes('--fix');

  const cards = (JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8')).data as MapCard[]);
  const byId = new Map(cards.map(c => [c.id, c]));
  const decks = JSON.parse(fs.readFileSync(DECKS_PATH, 'utf-8')) as PresetDeck[];

  const standardByName = new Map<string, MapCard[]>();
  for (const c of cards) {
    if (!isStandard(c)) continue;
    if (!standardByName.has(c.name)) standardByName.set(c.name, []);
    standardByName.get(c.name)!.push(c);
  }

  /** Picks the best standard-legal stand-in for `old`, or null if none qualifies. */
  function pickReplacement(old: MapCard): { card: MapCard; exact: boolean } | null {
    let cands = (standardByName.get(old.name) || []).filter(c => c.supertype === old.supertype);
    if (old.supertype === 'Pokémon') {
      const stage = stageOf(old);
      // Only constrain by stage when the old card actually declares one; some scraped prints
      // have empty subtypes, and over-filtering there would reject a valid replacement.
      if (stage) cands = cands.filter(c => stageOf(c) === stage);
    }
    if (cands.length === 0) return null;

    const oldSig = signature(old);
    const exactMatches = cands.filter(c => signature(c) === oldSig);
    if (exactMatches.length > 0) {
      exactMatches.sort((a, b) => a.id.localeCompare(b.id));
      return { card: exactMatches[0], exact: true };
    }
    // Deterministic "newest set" heuristic: prefer the highest set id lexically, then lowest
    // card id, so repeated runs always produce the same file.
    cands.sort((a, b) => (b.set?.id || '').localeCompare(a.set?.id || '') || a.id.localeCompare(b.id));
    return { card: cands[0], exact: false };
  }

  const swaps: any[] = [];
  const unresolved: any[] = [];
  let slotsBefore = 0;
  let nonStandardSlots = 0;

  for (const deck of decks) {
    for (const entry of deck.entries) {
      const n = entry.count || 1;
      slotsBefore += n;
      const old = byId.get(entry.cardId);
      if (!old || isStandard(old)) continue;
      nonStandardSlots += n;

      const repl = pickReplacement(old);
      if (!repl) {
        unresolved.push({ deck: deck.name, cardId: entry.cardId, name: old.name, supertype: old.supertype, stage: stageOf(old), count: n });
        continue;
      }
      swaps.push({
        deck: deck.name,
        name: old.name,
        from: entry.cardId,
        to: repl.card.id,
        count: n,
        exactReprint: repl.exact,
        oldSignature: signature(old).slice(0, 120),
        newSignature: signature(repl.card).slice(0, 120),
      });
      // Always apply in memory so the integrity checks below validate the POST-swap decks even
      // on a dry run; only the file write is gated on --fix.
      entry.cardId = repl.card.id;
    }
  }

  // ── Post-swap integrity checks (report only; never silently mutate counts) ──
  const violations: any[] = [];
  for (const deck of decks) {
    let total = 0;
    const perName = new Map<string, number>();
    for (const e of deck.entries) {
      const n = e.count || 1;
      total += n;
      const c = byId.get(e.cardId);
      if (!c) continue;
      const isBasicEnergy = (c.subtypes || []).includes('Basic Energy');
      if (!isBasicEnergy) perName.set(c.name, (perName.get(c.name) || 0) + n);
    }
    if (total !== 60) violations.push({ deck: deck.name, kind: 'deck-size', total });
    for (const [name, n] of perName) {
      if (n > 4) violations.push({ deck: deck.name, kind: 'over-4-copies', name, count: n });
    }
    // Evolution-line sanity: every Stage 1/2 in the deck should have something it can evolve from.
    const namesInDeck = new Set(deck.entries.map(e => byId.get(e.cardId)?.name).filter(Boolean) as string[]);
    for (const e of deck.entries) {
      const c = byId.get(e.cardId);
      if (!c || c.supertype !== 'Pokémon') continue;
      const stage = stageOf(c);
      if (stage !== 'Stage 1' && stage !== 'Stage 2') continue;
      const from = c.evolvesFrom;
      if (from && !namesInDeck.has(from)) {
        violations.push({ deck: deck.name, kind: 'broken-evolution-line', card: c.name, id: c.id, needs: from });
      }
    }
  }

  const report = { generatedAt: new Date().toISOString(), applied: fix, slotsBefore, nonStandardSlots, swaps, unresolved, violations };
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2), 'utf-8');

  if (fix) {
    const slotsAfter = decks.reduce((s, d) => s + d.entries.reduce((t, e) => t + (e.count || 1), 0), 0);
    if (slotsAfter !== slotsBefore) {
      throw new Error(`Card-slot total changed (${slotsBefore} -> ${slotsAfter}); this script only repoints ids and must never add/remove cards. Aborting without writing decks.`);
    }
    fs.writeFileSync(DECKS_PATH, JSON.stringify(decks, null, 2), 'utf-8');
  }

  console.log(`=== Preset deck Standard audit${fix ? ' (APPLIED)' : ' (dry run)'} ===`);
  console.log(`  Decks: ${decks.length}   card slots: ${slotsBefore}`);
  console.log(`  Non-standard slots: ${nonStandardSlots}`);
  console.log(`  Swaps: ${swaps.length} (exact reprints: ${swaps.filter(s => s.exactReprint).length}, different design: ${swaps.filter(s => !s.exactReprint).length})`);
  console.log(`  Unresolved (no standard print of that name/stage): ${unresolved.length}`);
  console.log(`  Integrity violations after swap: ${violations.length}`);
  for (const v of violations.slice(0, 20)) console.log(`    ${JSON.stringify(v)}`);
  if (unresolved.length > 0) {
    console.log(`  Unresolved sample:`);
    for (const u of unresolved.slice(0, 15)) console.log(`    ${u.name} (${u.cardId}, ${u.supertype}${u.stage ? '/' + u.stage : ''}) in ${u.deck}`);
  }
  console.log(`\n  Full report: data-scraped/preset-deck-standard-audit.json`);
}

main();
