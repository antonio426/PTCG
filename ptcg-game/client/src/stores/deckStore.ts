import { create } from 'zustand';
import { MAX_DECK_SIZE, MIN_DECK_SIZE, MAX_COPIES_PER_CARD } from '@ptcg/shared';
import type { Card, Subtype } from '@ptcg/shared';

interface Deck {
  id: string;
  name: string;
  cards: string[];
  format: string;
  createdAt: number;
}

interface CurrentDeck {
  id: string | null;
  name: string;
  cards: string[];
}

interface DeckState {
  decks: Deck[];
  currentDeck: CurrentDeck;
  /** Unsaved-changes marker for the current draft (未存檔 indicator). */
  dirty: boolean;
  presetDecks: Deck[];
  presetDecksLoading: boolean;
  createDeck: (name: string) => void;
  addCard: (cardId: string, skipCopyLimit?: boolean, allCards?: Card[]) => void;
  removeCard: (cardId: string) => void;
  saveDeck: () => void;
  loadDeck: (id: string) => void;
  deleteDeck: (id: string) => void;
  validateDeck: (allCards?: Card[]) => { valid: boolean; errors: string[] };
  setDeckName: (name: string) => void;
  fetchPresetDecks: () => Promise<void>;
  loadPresetDeck: (id: string) => void;
}

function generateId(): string {
  return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function isBasicEnergyCard(card: Card | undefined): boolean {
  return !!card && card.subtypes.includes('Basic Energy' as Subtype);
}

/**
 * How many cards in `deckCardIds` share `cardId`'s printed NAME. The real 4-copy limit is per
 * name, not per print — counting by id let a deck hold 4 of each of two prints of the same
 * Pokémon (8 total, illegal). Basic Energy is exempt from the limit entirely and reports 0.
 *
 * Falls back to counting the exact id when the catalog isn't loaded yet or doesn't know the
 * card: legacy ids are deliberately tolerated everywhere in this store, and an unknown id has
 * no name to group by.
 */
export function sameNameCopyCount(deckCardIds: string[], cardId: string, allCards?: Card[]): number {
  const target = allCards?.find((c) => c.id === cardId);
  if (!target) return deckCardIds.filter((id) => id === cardId).length;
  if (isBasicEnergyCard(target)) return 0;
  return deckCardIds.filter((id) => {
    const card = allCards!.find((c) => c.id === id);
    return card ? card.name === target.name : id === cardId;
  }).length;
}

function loadDecks(): Deck[] {
  try {
    const saved = localStorage.getItem('ptcg-decks');
    if (saved) return JSON.parse(saved);
  } catch {}
  return [];
}

function saveDecks(decks: Deck[]): void {
  try { localStorage.setItem('ptcg-decks', JSON.stringify(decks)); } catch {}
}

/* One-time migration of legacy card ids inside saved decks (old scraper scr-* ids and
 * rotated prints like S5R-027 輕飄飄) to current Standard-legal prints — decks saved before
 * the preset repoint kept referencing old prints, so battles showed the old card's real
 * attacks/art ("自我再生") instead of the current design. The server decides every mapping
 * (POST /api/cards/remap); unresolvable ids stay untouched (validateDeck tolerates them). */
const MIGRATION_FLAG = 'ptcg-decks-migrated-v1';
const MIGRATION_BACKUP = 'ptcg-decks-pre-migration';

async function migrateLegacyDeckIds(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return;
    const decks = loadDecks();
    if (decks.length === 0) { localStorage.setItem(MIGRATION_FLAG, String(Date.now())); return; }

    const ids = [...new Set(decks.flatMap(d => d.cards))];
    const res = await fetch('/api/cards/remap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return; // flag stays unset -> retried on next app load
    const { remap } = await res.json() as { remap: Record<string, string | null> };

    const changed = new Map<string, string>();
    const unresolved = new Set<string>();
    const migrated = decks.map(d => ({
      ...d,
      cards: d.cards.map(id => {
        const to = remap[id];
        if (to === null) { unresolved.add(id); return id; }
        if (to && to !== id) { changed.set(id, to); return to; }
        return id;
      }),
    }));

    if (changed.size > 0) {
      // single, never-overwritten backup of the pre-migration state
      if (!localStorage.getItem(MIGRATION_BACKUP)) {
        localStorage.setItem(MIGRATION_BACKUP, localStorage.getItem('ptcg-decks') ?? '[]');
      }
      saveDecks(migrated);
      useDeckStore.setState({ decks: migrated });
      console.info(
        `[deck-migration] 已把 ${changed.size} 種舊卡片 ID 換成 Standard 印刷（原始資料備份於 localStorage['${MIGRATION_BACKUP}']）：`,
        Object.fromEntries(changed),
      );
    }
    if (unresolved.size > 0) {
      console.warn('[deck-migration] 無法解析、維持原樣的 ID：', [...unresolved]);
    }
    localStorage.setItem(MIGRATION_FLAG, String(Date.now()));
  } catch { /* network hiccup: retry next load */ }
}

export const useDeckStore = create<DeckState>((set, get) => ({
  decks: loadDecks(),
  currentDeck: { id: null, name: '', cards: [] },
  dirty: false,
  presetDecks: [],
  presetDecksLoading: false,

  createDeck: (name: string) => {
    set({
      currentDeck: { id: null, name, cards: [] },
      dirty: false,
    });
  },

  addCard: (cardId: string, skipCopyLimit?: boolean, allCards?: Card[]) => {
    const { currentDeck } = get();
    // Per NAME when the catalog is available — see sameNameCopyCount.
    const cardCount = sameNameCopyCount(currentDeck.cards, cardId, allCards);

    if (currentDeck.cards.length >= MAX_DECK_SIZE) return;
    if (!skipCopyLimit && cardCount >= MAX_COPIES_PER_CARD) return;

    set({
      currentDeck: {
        ...currentDeck,
        cards: [...currentDeck.cards, cardId],
      },
      dirty: true,
    });
  },

  removeCard: (cardId: string) => {
    const { currentDeck } = get();
    const index = currentDeck.cards.lastIndexOf(cardId);
    if (index === -1) return;

    const updated = [...currentDeck.cards];
    updated.splice(index, 1);

    set({
      currentDeck: { ...currentDeck, cards: updated },
      dirty: true,
    });
  },

  saveDeck: () => {
    const { currentDeck, decks } = get();

    let updated: Deck[];
    if (currentDeck.id) {
      updated = decks.map((d) =>
        d.id === currentDeck.id
          ? { ...d, name: currentDeck.name, cards: currentDeck.cards, format: 'standard' }
          : d,
      );
    } else {
      const newDeck: Deck = {
        id: generateId(),
        name: currentDeck.name,
        cards: currentDeck.cards,
        format: 'standard',
        createdAt: Date.now(),
      };
      updated = [...decks, newDeck];
      set({ currentDeck: { ...currentDeck, id: newDeck.id } });
    }
    set({ decks: updated, dirty: false });
    saveDecks(updated);
  },

  loadDeck: (id: string) => {
    const { decks } = get();
    const deck = decks.find((d) => d.id === id);
    if (!deck) return;

    set({
      currentDeck: { id: deck.id, name: deck.name, cards: [...deck.cards] },
      dirty: false,
    });
  },

  deleteDeck: (id: string) => {
    const { decks, currentDeck } = get();
    const updated = decks.filter((d) => d.id !== id);
    set({
      decks: updated,
      currentDeck:
        currentDeck.id === id
          ? { id: null, name: '', cards: [] }
          : currentDeck,
    });
    saveDecks(updated);
  },

  validateDeck: (allCards?: Card[]) => {
    const { currentDeck } = get();
    const errors: string[] = [];

    if (currentDeck.cards.length < MIN_DECK_SIZE) {
      errors.push(`牌組至少需要 ${MIN_DECK_SIZE} 張卡牌（目前 ${currentDeck.cards.length} 張）`);
    }

    if (currentDeck.cards.length > MAX_DECK_SIZE) {
      errors.push(`牌組最多只能有 ${MAX_DECK_SIZE} 張卡牌`);
    }

    // The limit is 4 per NAME, not per print — grouping by id let a deck hold 4 of each of two
    // prints of the same Pokémon. Cards the catalog doesn't know (legacy scr-* ids) have no name
    // to group by, so they keep falling back to their own id, which is also what makes them
    // tolerated rather than rejected.
    const countMap = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const id of currentDeck.cards) {
      const card = allCards?.find((c) => c.id === id);
      if (isBasicEnergyCard(card)) continue; // Basic Energy 不受 4 張上限限制
      // 卡片不在當前目錄中（可能是舊格式 scr-* ID）時跳過檢查，與其他驗證一致地容忍舊 ID
      if (allCards && !card) continue;
      const key = card ? `name:${card.name}` : `id:${id}`;
      countMap.set(key, (countMap.get(key) || 0) + 1);
      labels.set(key, card?.name ?? id);
    }

    for (const [key, count] of countMap) {
      if (count > MAX_COPIES_PER_CARD) {
        errors.push(`卡牌 ${labels.get(key)} 超過了 ${MAX_COPIES_PER_CARD} 張的上限（目前 ${count} 張）`);
      }
    }

    // Real rules: a deck must contain at least 1 Basic Pokémon (you must be able to open with
    // an Active). Only checkable when the catalog is supplied; unknown ids are tolerated the
    // same way the 4-copy check tolerates them.
    if (allCards && currentDeck.cards.length > 0) {
      const hasBasic = currentDeck.cards.some((id) => {
        const card = allCards.find((c) => c.id === id);
        return !!card && card.supertype === 'Pokémon' && card.subtypes.includes('Basic' as Subtype);
      });
      const anyResolved = currentDeck.cards.some((id) => allCards.some((c) => c.id === id));
      if (anyResolved && !hasBasic) errors.push('牌組至少需要 1 隻基礎寶可夢');
    }

    return { valid: errors.length === 0, errors };
  },

  setDeckName: (name: string) => {
    const { currentDeck } = get();
    set({ currentDeck: { ...currentDeck, name }, dirty: true });
  },

  fetchPresetDecks: async () => {
    set({ presetDecksLoading: true });
    try {
      const res = await fetch('/api/preset-decks');
      if (!res.ok) throw new Error('Failed to fetch preset decks');
      const decks: Deck[] = await res.json();
      set({ presetDecks: decks, presetDecksLoading: false });
    } catch {
      set({ presetDecksLoading: false });
    }
  },

  loadPresetDeck: (id: string) => {
    const { presetDecks } = get();
    const deck = presetDecks.find((d) => d.id === id);
    if (!deck) return;
    set({
      currentDeck: { id: null, name: `[預組] ${deck.name}`, cards: [...deck.cards] },
      dirty: true, // a preset copy is an unsaved draft until 存檔
    });
  },
}));

// Fire-and-forget at module load: must run after useDeckStore exists (setState above).
void migrateLegacyDeckIds();
