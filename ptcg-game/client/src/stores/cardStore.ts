import { create } from 'zustand';
import type { Card, CardSet, Supertype, Subtype } from '@ptcg/shared';

interface CardFilters {
  query?: string;
  supertype?: Supertype;
  subtypes?: Subtype[];
  types?: string[];
  set?: string;
}

interface CardState {
  cards: Card[];
  sets: CardSet[];
  loading: boolean;
  error: string | null;
  cardDetails: Record<string, Card>;
  fetchCards: () => Promise<void>;
  searchCards: (query: string, filters?: CardFilters) => Card[];
  getCardById: (id: string) => Card | undefined;
  fetchCardDetail: (id: string) => Promise<Card | undefined>;
}

export const useCardStore = create<CardState>((set, get) => ({
  cards: [],
  sets: [],
  loading: false,
  error: null,
  cardDetails: {},

  fetchCards: async () => {
    set({ loading: true, error: null });
    try {
      const [cardsRes, setsRes] = await Promise.all([
        fetch('/api/cards'),
        fetch('/api/cards/sets'),
      ]);

      if (!cardsRes.ok || !setsRes.ok) {
        throw new Error('Failed to fetch card data');
      }

      const cards: Card[] = await cardsRes.json();
      const sets: CardSet[] = await setsRes.json();

      set({ cards, sets, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Unknown error',
        loading: false,
      });
    }
  },

  searchCards: (query: string, filters?: CardFilters) => {
    const { cards } = get();
    let result = cards;

    if (query) {
      const lower = query.toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          c.id.toLowerCase().includes(lower),
      );
    }

    if (filters?.supertype) {
      result = result.filter((c) => c.supertype === filters.supertype);
    }

    if (filters?.subtypes?.length) {
      result = result.filter((c) =>
        filters.subtypes!.some((s) => c.subtypes.includes(s)),
      );
    }

    if (filters?.types?.length) {
      result = result.filter(
        (c) => c.types && filters.types!.some((t) => c.types!.includes(t as never)),
      );
    }

    if (filters?.set) {
      result = result.filter((c) => c.set.id === filters.set);
    }

    return result;
  },

  getCardById: (id: string) => {
    return get().cardDetails[id] || get().cards.find((c) => c.id === id);
  },

  fetchCardDetail: async (id: string) => {
    // Check local detail cache first
    const existing = get().cardDetails[id];
    if (existing && existing.hp) return existing; // has real detail data

    // The summary card might already be in `cards` - but it's summary-level,
    // so we still need to fetch the detail.
    try {
      const res = await fetch(`/api/cards/${id}`);
      if (!res.ok) return undefined;
      const card: Card = await res.json();
      set((state) => ({
        cardDetails: { ...state.cardDetails, [id]: card },
      }));
      return card;
    } catch {
      return undefined;
    }
  },
}));
