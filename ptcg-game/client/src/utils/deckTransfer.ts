import type { Card } from '@ptcg/shared';

/**
 * Deck text/JSON transfer, extracted from DeckBuilder so it can be tested. This handles a user's
 * own saved data — a round-trip that silently drops or duplicates cards is data loss, and there
 * was no way to check it while the logic lived inside a component.
 */

export const MAX_DECK_CARDS = 60;

const SUPERTYPE_ZH: Record<string, string> = {
  'Pokémon': '寶可夢', Trainer: '訓練家', Energy: '能量', 其他: '其他',
};

/**
 * One line per distinct PRINT (not per name): two prints of the same card are different cards for
 * deck purposes, and the id on each line is what makes the round-trip exact.
 */
export function deckToText(deckName: string, cardIds: string[], catalog: Card[]): string {
  const byId = new Map(catalog.map(c => [c.id, c]));
  const counts = new Map<string, number>();
  for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const groups: Record<string, string[]> = { 'Pokémon': [], Trainer: [], Energy: [], 其他: [] };
  for (const [id, count] of counts) {
    const card = byId.get(id);
    // Keep the id even when the catalog has never heard of the card (a deck saved before a print
    // rotated out). Dropping the line would delete the card from the user's deck on round-trip.
    groups[card?.supertype ?? '其他'] ??= [];
    (groups[card?.supertype ?? '其他'] ?? groups['其他']).push(`${count} ${card?.name ?? '未知卡片'} ${id}`);
  }

  return [
    `# ${deckName || '未命名牌組'}（${cardIds.length} 張）`,
    ...Object.entries(groups)
      .filter(([, lines]) => lines.length)
      .flatMap(([group, lines]) => [`## ${SUPERTYPE_ZH[group] ?? group}`, ...lines]),
  ].join('\n');
}

export interface TextImportResult {
  cardIds: string[];
  /** Lines that named nothing resolvable — surfaced to the user rather than silently skipped. */
  unresolved: string[];
  /** True when the source listed more than a legal deck holds and the tail was cut. */
  truncated: boolean;
}

/** `4 高級球 SV1-100`, `4x 高級球`, `4 高級球` — count, name, optional print id. */
const LINE = /^(\d+)\s*[x×]?\s+(.+?)(?:\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+))?$/;

export function textToDeck(text: string, catalog: Card[]): TextImportResult {
  const byId = new Map(catalog.map(c => [c.id, c]));
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  const cardIds: string[] = [];
  const unresolved: string[] = [];
  // Counted separately from what we actually build: a single line asking for 70 copies gets
  // capped per line, so the built list lands on exactly 60 and comparing lengths at the end
  // would report no truncation at all.
  let requested = 0;

  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) { unresolved.push(line); continue; }
    const asked = parseInt(m[1], 10) || 0;
    const count = Math.min(asked, MAX_DECK_CARDS);
    const name = m[2].trim();

    // The printed id is authoritative when present — it survives two prints sharing a name, and
    // it's what deckToText writes. Fall back to the name, preferring a Standard-legal print.
    let id = m[3] && byId.has(m[3]) ? m[3] : undefined;
    if (!id) {
      const byName = catalog.find(c => c.name === name && c.legalities?.standard === 'Legal')
        ?? catalog.find(c => c.name === name);
      id = byName?.id;
    }
    // An id we can't resolve is still a real line the user wrote; keep it so a deck exported
    // before a print rotated out survives the trip, exactly as deckStore tolerates unknown ids.
    if (!id && m[3]) id = m[3];
    if (!id) { unresolved.push(line); continue; }

    requested += asked;
    for (let i = 0; i < count; i++) cardIds.push(id);
  }

  return {
    cardIds: cardIds.slice(0, MAX_DECK_CARDS),
    unresolved,
    truncated: requested > MAX_DECK_CARDS,
  };
}

export function deckToJson(deckName: string, cardIds: string[]): string {
  return JSON.stringify({ name: deckName, cards: cardIds }, null, 2);
}

export interface JsonImportResult {
  name: string;
  cardIds: string[];
}

/** Throws on anything that isn't `{ name, cards: string[] }` so the caller can show one message. */
export function jsonToDeck(raw: string, fallbackName: string): JsonImportResult {
  const parsed = JSON.parse(raw) as { name?: unknown; cards?: unknown };
  if (!Array.isArray(parsed.cards) || !parsed.cards.every(c => typeof c === 'string')) {
    throw new Error('bad shape');
  }
  return {
    name: String(parsed.name || fallbackName),
    cardIds: (parsed.cards as string[]).slice(0, MAX_DECK_CARDS),
  };
}
