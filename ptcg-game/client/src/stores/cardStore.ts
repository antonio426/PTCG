import { create } from 'zustand';
import type { Card, CardSet, Supertype, Subtype } from '@ptcg/shared';

interface CardFilters {
  query?: string;
  supertype?: Supertype;
  subtypes?: Subtype[];
  types?: string[];
  set?: string;
  rarity?: string[];
  sortOrder?: SortOrder;
  namePrefix?: string;
  /** Filter cards whose name ends with this string (e.g. 'EX') */
  nameSuffix?: string;
  /** Where the text query is matched: card name/id (default), attack names+text, ability
   * names+text, or all of those at once. */
  searchScope?: SearchScope;
  /** Mechanic-tag filter — see cardMatchesTag for how each is derived from card data. */
  tag?: CardTag;
  /** Restrict to specific regulation marks (賽季 H/I/J …). */
  regulationMarks?: string[];
}

export type SearchScope = 'name' | 'attack' | 'ability' | 'all';
export type CardTag = 'ace-spec' | 'tera' | 'mega-ex' | 'trainer-named';

export const CARD_TAG_DEFS: { tag: CardTag; label: string }[] = [
  { tag: 'ace-spec', label: 'ACE SPEC' },
  { tag: 'tera', label: '太晶' },
  { tag: 'mega-ex', label: '超級進化' },
  { tag: 'trainer-named', label: '訓練家冠名' },
];

/** Data-derived mechanic tags. 古代/未來 are deliberately absent: no source in the current
 * dataset carries a structured Ancient/Future marker (subtypes count is 0 across all 10k+
 * cards; the official scrape only has it as free text) — recorded as a data gap in ROADMAP.md. */
export function cardMatchesTag(c: Card, tag: CardTag): boolean {
  switch (tag) {
    case 'ace-spec':
      return c.rarity === 'ACE';
    case 'tera':
      // Same marker the server's passive-ability logic uses (hasTeraBenchedImmunity): every
      // Tera print carries this fixed rules line inside an attack, plus the few 太晶-named cards.
      return c.name.includes('太晶')
        || !!c.attacks?.some(a => a.text?.trim() === '只要這隻寶可夢在備戰區，不會受到招式的傷害。');
    case 'mega-ex':
      return c.name.startsWith('超級') && c.subtypes.includes('ex');
    case 'trainer-named':
      return c.supertype === 'Pokémon' && /^.{1,6}的./.test(c.name);
  }
}

type SortOrder = 'number-asc' | 'number-desc' | 'name-asc' | 'name-desc' | 'hp-desc' | 'hp-asc';

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

export type { SortOrder };
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
      const scope = filters?.searchScope ?? 'name';
      const nameHit = (c: Card) => c.name.toLowerCase().includes(lower) || c.id.toLowerCase().includes(lower);
      // (a.name ?? ''): a handful of scraped entries carry no name at all (e.g. S5R-059
      // 爆炸頭水牛's ability — the case normalizeCardName guards server-side).
      const attackHit = (c: Card) => !!c.attacks?.some(a =>
        (a.name ?? '').toLowerCase().includes(lower) || (a.text ?? '').toLowerCase().includes(lower));
      const abilityHit = (c: Card) => !!c.abilities?.some(a =>
        (a.name ?? '').toLowerCase().includes(lower) || (a.text ?? '').toLowerCase().includes(lower));
      result = result.filter((c) =>
        scope === 'name' ? nameHit(c)
        : scope === 'attack' ? attackHit(c)
        : scope === 'ability' ? abilityHit(c)
        : nameHit(c) || attackHit(c) || abilityHit(c));
    }

    if (filters?.tag) {
      result = result.filter((c) => cardMatchesTag(c, filters.tag!));
    }

    if (filters?.regulationMarks?.length) {
      result = result.filter((c) => c.regulationMark && filters.regulationMarks!.includes(c.regulationMark));
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

    if (filters?.rarity?.length) {
      result = result.filter(
        (c) => c.rarity && filters.rarity!.includes(c.rarity),
      );
    }

    if (filters?.namePrefix) {
      result = result.filter((c) => c.name.startsWith(filters.namePrefix!));
    }

    if (filters?.nameSuffix) {
      result = result.filter(
        (c) => c.name.endsWith(filters.nameSuffix!) && !c.name.startsWith('超級'),
      );
    }

    // Apply sort
    if (filters?.sortOrder) {
      const order = filters.sortOrder;
      result = [...result].sort((a, b) => {
        switch (order) {
          case 'number-asc':
            return a.id.localeCompare(b.id);
          case 'number-desc':
            return b.id.localeCompare(a.id);
          case 'name-asc':
            return a.name.localeCompare(b.name);
          case 'name-desc':
            return b.name.localeCompare(a.name);
          case 'hp-desc': {
            const ha = a.hp ? parseInt(a.hp, 10) : 0;
            const hb = b.hp ? parseInt(b.hp, 10) : 0;
            return hb - ha;
          }
          case 'hp-asc': {
            const ha = a.hp ? parseInt(a.hp, 10) : 0;
            const hb = b.hp ? parseInt(b.hp, 10) : 0;
            return ha - hb;
          }
          default:
            return 0;
        }
      });
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
