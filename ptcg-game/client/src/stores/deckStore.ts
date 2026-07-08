import { create } from 'zustand';
import { MAX_DECK_SIZE, MIN_DECK_SIZE, MAX_COPIES_PER_CARD } from '@ptcg/shared';

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
  addCard: (cardId: string) => void;
  removeCard: (cardId: string) => void;
  saveDeck: () => void;
  loadDeck: (id: string) => void;
  deleteDeck: (id: string) => void;
  validateDeck: () => { valid: boolean; errors: string[] };
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

  addCard: (cardId: string) => {
    const { currentDeck } = get();
    const cardCount = currentDeck.cards.filter((id) => id === cardId).length;

    if (currentDeck.cards.length >= MAX_DECK_SIZE) return;
    if (cardCount >= MAX_COPIES_PER_CARD) return;

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

  validateDeck: () => {
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
