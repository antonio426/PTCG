/**
 * Shared "map an outdated/legacy card id to a current Standard-legal print" logic.
 * Extracted from scripts/audit-preset-decks-standard.ts (which now imports from here) so the
 * /api/cards/remap route reuses the identical matching rules instead of a second copy:
 * same-name candidates constrained by supertype (+stage for Pokémon), exact attack+ability
 * signature preferred, deterministic newest-set fallback.
 *
 * A second resolution path handles ids the catalog doesn't know at all (the old scraper's
 * `scr-*` ids that some pre-repoint localStorage decks still carry): scraped-cards-all.json
 * knows each scr id's name and set+number, so an exact set+number hit in the catalog wins,
 * then the name-based standard pick, then null.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { MapCard } from './types';

const SCRAPED_FILE = path.resolve(__dirname, '../../data/scraped-cards-all.json');

const STAGE_SUBTYPES = ['Basic', 'Stage 1', 'Stage 2'];

export function stageOf(c: MapCard): string | null {
  return (c.subtypes || []).find(s => STAGE_SUBTYPES.includes(s)) ?? null;
}

/** Attack+ability fingerprint — two prints with the same fingerprint are the same real card. */
export function signature(c: MapCard): string {
  const atk = (c.attacks || [])
    .map(a => `${a.name}:${(a.cost || []).join(',')}:${a.damage}`)
    .sort()
    .join('|');
  const abi = (c.abilities || []).map(a => a.name).sort().join('|');
  return `${atk}##${abi}`;
}

export function isStandard(c: MapCard): boolean {
  return c.legalities?.standard === 'Legal';
}

export function buildStandardByName(cards: MapCard[]): Map<string, MapCard[]> {
  const standardByName = new Map<string, MapCard[]>();
  for (const c of cards) {
    if (!isStandard(c)) continue;
    if (!standardByName.has(c.name)) standardByName.set(c.name, []);
    standardByName.get(c.name)!.push(c);
  }
  return standardByName;
}

/** Picks the best standard-legal stand-in for `old`, or null if none qualifies. */
export function pickReplacement(old: MapCard, standardByName: Map<string, MapCard[]>): { card: MapCard; exact: boolean } | null {
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
  // card id, so repeated runs always produce the same result.
  cands.sort((a, b) => (b.set?.id || '').localeCompare(a.set?.id || '') || a.id.localeCompare(b.id));
  return { card: cands[0], exact: false };
}

interface ScrapedEntry { id: string; name: string; set?: { id: string }; number?: string; supertype?: string }

let scrapedById: Map<string, ScrapedEntry> | null = null;
function loadScrapedById(): Map<string, ScrapedEntry> {
  if (scrapedById) return scrapedById;
  scrapedById = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(SCRAPED_FILE, 'utf-8')).data as ScrapedEntry[];
    for (const e of arr) if (e?.id) scrapedById.set(e.id, e);
  } catch { /* file absent: scr-* ids simply resolve to null */ }
  return scrapedById;
}

const numerator = (num: string | undefined) => {
  const m = (num || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * Resolve one possibly-legacy id. Returns the id itself when it's already a Standard-legal
 * catalog print, a different id when a Standard replacement was found, or null when nothing
 * resolvable exists (caller keeps the original — deckStore.validateDeck tolerates unknowns).
 */
export function remapId(
  id: string,
  byId: Map<string, MapCard>,
  standardByName: Map<string, MapCard[]>,
): string | null {
  const card = byId.get(id);
  if (card) {
    if (isStandard(card)) return id;
    return pickReplacement(card, standardByName)?.card.id ?? null;
  }
  // Unknown to the catalog — usually an old scraper id. Try its scraped record.
  const scraped = loadScrapedById().get(id);
  if (!scraped) return null;
  // Exact print first: same set + card number in the current catalog.
  const setId = scraped.set?.id;
  const num = numerator(scraped.number);
  if (setId && num !== null) {
    for (const c of byId.values()) {
      if (c.set?.id === setId && numerator(c.number) === num) {
        return isStandard(c) ? c.id : (pickReplacement(c, standardByName)?.card.id ?? null);
      }
    }
  }
  // Fall back to a Standard print of the same name (same deterministic newest-set ordering
  // as pickReplacement's fallback).
  const cands = [...(standardByName.get(scraped.name) || [])];
  cands.sort((a, b) => (b.set?.id || '').localeCompare(a.set?.id || '') || a.id.localeCompare(b.id));
  return cands[0]?.id ?? null;
}
