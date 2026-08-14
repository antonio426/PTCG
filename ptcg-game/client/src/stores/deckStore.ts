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
  presetDecks: Deck[];
  presetDecksLoading: boolean;
  createDeck: (name: string) => void;
  addCard: (cardId: string, skipCopyLimit?: boolean) => void;
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
  presetDecks: [],
  presetDecksLoading: false,

  createDeck: (name: string) => {
    set({
      currentDeck: { id: null, name, cards: [] },
    });
  },

  addCard: (cardId: string, skipCopyLimit?: boolean) => {
    const { currentDeck } = get();
    const cardCount = currentDeck.cards.filter((id) => id === cardId).length;

    if (currentDeck.cards.length >= MAX_DECK_SIZE) return;
    if (!skipCopyLimit && cardCount >= MAX_COPIES_PER_CARD) return;

    set({
      currentDeck: {
        ...currentDeck,
        cards: [...currentDeck.cards, cardId],
      },
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
    set({ decks: updated });
    saveDecks(updated);
  },

  loadDeck: (id: string) => {
    const { decks } = get();
    const deck = decks.find((d) => d.id === id);
    if (!deck) return;

    set({
      currentDeck: { id: deck.id, name: deck.name, cards: [...deck.cards] },
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

    const countMap = new Map<string, number>();
    for (const id of currentDeck.cards) {
      countMap.set(id, (countMap.get(id) || 0) + 1);
    }

    for (const [id, count] of countMap) {
      if (count > MAX_COPIES_PER_CARD) {
        // Basic Energy 不受 4 張上限限制
        if (allCards) {
          const card = allCards.find((c) => c.id === id);
          if (card?.subtypes.includes('Basic Energy' as Subtype)) continue;
          // 如果卡片不在當前目錄中（可能是舊格式 scr-* ID），跳過檢查
          if (!card) continue;
        }
        errors.push(`卡牌 ${id} 超過了 ${MAX_COPIES_PER_CARD} 張的上限（目前 ${count} 張）`);
      }
    }

    return { valid: errors.length === 0, errors };
  },

  setDeckName: (name: string) => {
    const { currentDeck } = get();
    set({ currentDeck: { ...currentDeck, name } });
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
    });
  },
}));

// Fire-and-forget at module load: must run after useDeckStore exists (setState above).
void migrateLegacyDeckIds();
