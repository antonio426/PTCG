import { useState, useEffect, useCallback, useRef } from 'react';
import { useCardStore } from '../stores/cardStore';
import { useDeckStore } from '../stores/deckStore';
import { MAX_DECK_SIZE } from '@ptcg/shared';
import type { Card, Supertype, EnergyType, Subtype } from '@ptcg/shared';
import type { SortOrder } from '../stores/cardStore';

// ---- Card type filter defs (same as CardBrowser) ----
const CARD_TYPE_DEFS = [
  { label: '寶可夢', supertype: 'Pokémon' as Supertype },
  { label: '訓練家', supertype: 'Trainer' as Supertype, excludeSubtypes: ['Item', 'Pokémon Tool', 'Stadium'] as Subtype[] },
  { label: '能量', supertype: 'Energy' as Supertype },
  { label: '寶可夢道具', subtype: 'Pokémon Tool' as Subtype },
  { label: '競技場', subtype: 'Stadium' as Subtype },
  { label: '物品', subtype: 'Item' as Subtype },
  { label: 'ACE SPEC', rarity: 'ACE SPEC Rare' },
] as const;

// ---- Evolution stage filter defs ----
const STAGE_DEFS = [
  { label: '基礎寶可夢', subtype: 'Basic' as Subtype },
  { label: '1階寶可夢', subtype: 'Stage 1' as Subtype },
  { label: '2階寶可夢', subtype: 'Stage 2' as Subtype },
  { label: 'ex', nameSuffix: 'ex' },
  { label: 'MEGA', namePrefix: '超級' },
] as const;

const SUPERTYPES: { label: string; value: Supertype | '' }[] = [
  { label: '全部', value: '' },
  { label: '寶可夢', value: 'Pokémon' },
  { label: '訓練家', value: 'Trainer' },
  { label: '能量', value: 'Energy' },
];

const TYPE_OPTIONS: { label: string; value: EnergyType }[] = [
  { label: '草', value: 'Grass' },
  { label: '火', value: 'Fire' },
  { label: '水', value: 'Water' },
  { label: '雷', value: 'Lightning' },
  { label: '超', value: 'Psychic' },
  { label: '鬥', value: 'Fighting' },
  { label: '惡', value: 'Darkness' },
  { label: '鋼', value: 'Metal' },
  { label: '龍', value: 'Dragon' },
  { label: '無', value: 'Colorless' },
];

const TYPE_COLORS: Record<string, string> = {
  Grass: 'bg-green-500',
  Fire: 'bg-red-500',
  Water: 'bg-blue-500',
  Lightning: 'bg-yellow-400',
  Psychic: 'bg-purple-500',
  Fighting: 'bg-orange-600',
  Darkness: 'bg-stone-800',
  Metal: 'bg-slate-400',
  Dragon: 'bg-indigo-500',
  Colorless: 'bg-gray-400',
};

const TYPE_BG: Record<string, string> = {
  Grass: 'from-green-900/60 to-green-800/30',
  Fire: 'from-red-900/60 to-red-800/30',
  Water: 'from-blue-900/60 to-blue-800/30',
  Lightning: 'from-yellow-900/60 to-yellow-800/30',
  Psychic: 'from-purple-900/60 to-purple-800/30',
  Fighting: 'from-orange-900/60 to-orange-800/30',
  Darkness: 'from-stone-900/60 to-stone-800/30',
  Metal: 'from-slate-900/60 to-slate-800/30',
  Dragon: 'from-indigo-900/60 to-indigo-800/30',
  Colorless: 'from-gray-900/60 to-gray-800/30',
};

const SORT_OPTIONS: { label: string; value: SortOrder }[] = [
  { label: '編號 ↑', value: 'number-asc' },
  { label: '編號 ↓', value: 'number-desc' },
  { label: '名稱 A→Z', value: 'name-asc' },
  { label: '名稱 Z→A', value: 'name-desc' },
  { label: 'HP ↓', value: 'hp-desc' },
  { label: 'HP ↑', value: 'hp-asc' },
];

const RARITY_OPTIONS: { label: string; value: string }[] = [
  { label: 'Common', value: 'Common' },
  { label: 'Uncommon', value: 'Uncommon' },
  { label: 'Rare', value: 'Rare' },
  { label: 'Rare Holo', value: 'Rare Holo' },
  { label: 'Rare Holo V', value: 'Rare Holo V' },
  { label: 'Rare Holo VMAX', value: 'Rare Holo VMAX' },
  { label: 'Rare Holo VSTAR', value: 'Rare Holo VSTAR' },
  { label: 'Rare Ultra', value: 'Rare Ultra' },
  { label: 'Rare Rainbow', value: 'Rare Rainbow' },
  { label: 'Rare Secret', value: 'Rare Secret' },
  { label: 'Rare Shiny', value: 'Rare Shiny' },
  { label: 'Rare Shiny Holo', value: 'Rare Shiny Holo' },
  { label: 'Rare Shiny Ultra', value: 'Rare Shiny Ultra' },
  { label: 'Rare ACE SPEC', value: 'Rare ACE SPEC' },
  { label: 'Rare BREAK', value: 'Rare BREAK' },
  { label: 'Amazing', value: 'Amazing' },
  { label: 'Promo', value: 'Promo' },
];

const PAGE_SIZE = 24;

function EnergyIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' | 'lg' }) {
  const colorClass = TYPE_COLORS[type] || 'bg-gray-400';
  const sizeClass = size === 'lg' ? 'w-7 h-7 text-sm' : size === 'md' ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${colorClass} ${sizeClass} font-bold text-white shadow-sm`}
      title={type}
    >
      {type === 'Colorless' ? '無' : type === 'Psychic' ? '超' : type === 'Fighting' ? '鬥' : type === 'Darkness' ? '惡' : type === 'Lightning' ? '雷' : type === 'Metal' ? '鋼' : type === 'Dragon' ? '龍' : type.charAt(0)}
    </span>
  );
}

function isBasicEnergy(card: Card): boolean {
  return card.supertype === 'Energy' && card.subtypes.includes('Basic Energy' as Subtype);
}

function groupBySupertype(cards: Card[], deckCardIds: string[]) {
  const counts: Record<string, { card: Card; count: number }> = {};
  for (const id of deckCardIds) {
    const card = cards.find((c) => c.id === id);
    if (!card) continue;
    if (!counts[id]) {
      counts[id] = { card, count: 0 };
    }
    counts[id].count++;
  }
  const groups: Record<string, { card: Card; count: number }[]> = {
    Pokémon: [],
    Trainer: [],
    Energy: [],
  };
  for (const entry of Object.values(counts)) {
    const group = entry.card.supertype as 'Pokémon' | 'Trainer' | 'Energy';
    if (groups[group]) {
      groups[group].push(entry);
    }
  }
  return groups;
}

function getDisplaySubtypes(card: Card): string[] {
  const hidden = new Set(['ex', 'V-UNION']);
  return card.subtypes.filter((s: string) => !hidden.has(s));
}

export default function DeckBuilder() {
  const { cards, sets, loading, fetchCards, searchCards, fetchCardDetail } = useCardStore();
  const {
    decks, currentDeck, presetDecks, presetDecksLoading,
    createDeck, addCard, removeCard, saveDeck, loadDeck, deleteDeck, validateDeck, setDeckName,
    fetchPresetDecks, loadPresetDeck,
  } = useDeckStore();

  // ---- Search & filter state ----
  const [query, setQuery] = useState('');
  const [supertype, setSupertype] = useState<Supertype | ''>('');
  const [selectedTypes, setSelectedTypes] = useState<EnergyType[]>([]);
  const [selectedSet, setSelectedSet] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [validation, setValidation] = useState(() => validateDeck(cards));

  // ---- CardBrowser-style filter state ----
  const [showFilters, setShowFilters] = useState(false);
  const [selectedCardType, setSelectedCardType] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [hpMin, setHpMin] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [standardOnly, setStandardOnly] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('number-asc');
  const [selectedRarities, setSelectedRarities] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  // ---- Hover popover state ----
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchCards();
    fetchPresetDecks();
  }, [fetchCards, fetchPresetDecks]);

  useEffect(() => {
    const result = validateDeck(cards);
    setValidation(result);
  }, [currentDeck.cards, cards, validateDeck]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [query, supertype, selectedTypes, selectedSet, selectedCardType, selectedStage, hpMin, hpMax, standardOnly, sortOrder, selectedRarities]);

  const toggleType = (t: EnergyType) => {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const toggleRarity = (r: string) => {
    setSelectedRarities((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
    );
  };

  const selectCardType = (label: string) => {
    setSelectedCardType((prev) => prev === label ? null : label);
  };

  const selectStage = (label: string) => {
    setSelectedStage((prev) => prev === label ? null : label);
  };

  // ---- Build filter args ----
  const filterArgs: {
    supertype?: Supertype;
    types?: string[];
    set?: string;
    rarity?: string[];
    sortOrder?: SortOrder;
  } = {};

  if (supertype) filterArgs.supertype = supertype;
  if (selectedTypes.length > 0) filterArgs.types = selectedTypes;
  if (selectedSet) filterArgs.set = selectedSet;
  if (selectedRarities.length > 0) filterArgs.rarity = selectedRarities;
  filterArgs.sortOrder = sortOrder;

  let rawFiltered = searchCards(query, filterArgs);

  // Standard format filter
  if (standardOnly) {
    rawFiltered = rawFiltered.filter(c => c.legalities?.standard === 'Legal');
  }

  // HP range
  const hpFiltered = rawFiltered.filter((c) => {
    const hp = c.hp ? parseInt(c.hp, 10) : NaN;
    if (hpMin && !isNaN(hp) && hp < parseInt(hpMin, 10)) return false;
    if (hpMax && !isNaN(hp) && hp > parseInt(hpMax, 10)) return false;
    return true;
  });

  // Client-side card type & stage filters
  const filteredByType = hpFiltered.filter((c) => {
    let typeMatch = true;
    if (selectedCardType) {
      const def = CARD_TYPE_DEFS.find((d) => d.label === selectedCardType);
      if (def) {
        if ('supertype' in def) typeMatch = c.supertype === def.supertype;
        if ('subtype' in def) typeMatch = c.subtypes?.includes(def.subtype);
        if ('rarity' in def) typeMatch = c.rarity === def.rarity;
        if ('excludeSubtypes' in def && def.excludeSubtypes) {
          typeMatch = typeMatch && !def.excludeSubtypes.some(s => c.subtypes?.includes(s));
        }
      }
    }
    let stageMatch = true;
    if (selectedStage) {
      const def = STAGE_DEFS.find((d) => d.label === selectedStage);
      if (def) {
        if ('subtype' in def) stageMatch = c.subtypes?.includes(def.subtype);
        if ('nameSuffix' in def) stageMatch = c.name.endsWith(def.nameSuffix) && !c.name.startsWith('超級');
        if ('namePrefix' in def) {
          stageMatch = def.namePrefix === '超級'
            ? c.name.startsWith('超級') && c.supertype === 'Pokémon'
            : c.name.startsWith(def.namePrefix);
        }
      }
    }
    return typeMatch && stageMatch;
  });

  const totalPages = Math.ceil(filteredByType.length / PAGE_SIZE);
  const pagedCards = filteredByType.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const deckCardCount = currentDeck.cards.length;
  const groupedCards = groupBySupertype(cards, currentDeck.cards);

  // ---- Hover handlers ----
  const handleHoverStart = useCallback((cardId: string, e: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    fetchCardDetail(cardId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    hoverTimer.current = setTimeout(() => {
      setHoveredCardId(cardId);
      setHoverPos({ x: rect.right, y: rect.top });
    }, 300);
  }, [fetchCardDetail]);

  const handleHoverEnd = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setHoveredCardId(null);
    }, 150);
  }, []);

  const handleCreateDeck = () => {
    if (!newDeckName.trim()) return;
    createDeck(newDeckName.trim());
    setNewDeckName('');
  };

  const handleSave = () => {
    if (currentDeck.name.trim()) {
      saveDeck();
    }
  };

  // ---- Hover popover ----
  const hoveredCard = hoveredCardId ? (cards.find(c => c.id === hoveredCardId) || null) : null;

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-8rem)]">
      {/* ============ LEFT PANEL: Card Selector ============ */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-2xl font-bold text-white">牌組構築</h1>
          <button
            onClick={() => setShowSaved(!showSaved)}
            className="ml-auto px-3 py-1.5 rounded-lg text-sm bg-slate-800 border border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            已存牌組 ({decks.length})
          </button>
        </div>

        {/* ---- Search row ---- */}
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋卡牌名稱或編號..."
            className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <select
            value={selectedSet}
            onChange={(e) => setSelectedSet(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 w-40"
          >
            <option value="">全部系列</option>
            {(() => {
              const grouped = sets.reduce<Record<string, typeof sets>>((acc, s) => {
                const key = s.series || '其他';
                if (!acc[key]) acc[key] = [];
                acc[key].push(s);
                return acc;
              }, {});
              return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([series, seriesSets]) => (
                <optgroup key={series} label={series}>
                  {seriesSets.map((s) => (
                    <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
                  ))}
                </optgroup>
              ));
            })()}
          </select>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
              showFilters ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500'
            }`}
          >
            篩選
          </button>
        </div>

        {/* ---- Collapsible advanced filters ---- */}
        {showFilters && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3 space-y-4 overflow-y-auto max-h-80">
            {/* Card type */}
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">卡牌類型</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSelectedCardType(null)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    !selectedCardType
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  全部
                </button>
                {CARD_TYPE_DEFS.map((def) => (
                  <button
                    key={def.label}
                    onClick={() => selectCardType(def.label)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                      selectedCardType === def.label
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {def.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Evolution stage */}
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">進化分類</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSelectedStage(null)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    !selectedStage
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  全部
                </button>
                {STAGE_DEFS.map((def) => (
                  <button
                    key={def.label}
                    onClick={() => selectStage(def.label)}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                      selectedStage === def.label
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {def.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Supertype + Type (row) */}
            <div className="flex flex-wrap gap-2">
              {SUPERTYPES.map((st) => (
                <button
                  key={st.value}
                  onClick={() => setSupertype(st.value as Supertype | '')}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    supertype === st.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {st.label}
                </button>
              ))}
              <span className="w-px bg-slate-700 mx-1" />
              {TYPE_OPTIONS.map((to) => (
                <button
                  key={to.value}
                  onClick={() => toggleType(to.value)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    selectedTypes.includes(to.value)
                      ? `text-white ring-2 ring-offset-1 ring-offset-slate-900 ${TYPE_COLORS[to.value]} brightness-110`
                      : `text-slate-300 ${TYPE_COLORS[to.value]} opacity-60 hover:opacity-90`
                  }`}
                >
                  {to.label}
                </button>
              ))}
            </div>

            {/* HP + Standard + Sort + Rarity in a 2-col grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">HP 範圍</label>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    value={hpMin}
                    onChange={(e) => setHpMin(e.target.value)}
                    placeholder="最小"
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-slate-500 text-xs">-</span>
                  <input
                    type="number"
                    value={hpMax}
                    onChange={(e) => setHpMax(e.target.value)}
                    placeholder="最大"
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs text-slate-400 mb-1 block">標準</label>
                  <button
                    onClick={() => setStandardOnly(!standardOnly)}
                    className={`w-full px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      standardOnly
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {standardOnly ? '✓ 僅標準賽制' : '顯示全部卡牌'}
                  </button>
                </div>
                <div className="flex-1">
                  <label className="text-xs text-slate-400 mb-1 block">排列順序</label>
                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Rarity */}
            <div>
              <label className="text-xs text-slate-400 mb-1.5 block">稀有度</label>
              <div className="flex flex-wrap gap-1.5">
                {selectedRarities.length > 0 && (
                  <button
                    onClick={() => setSelectedRarities([])}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium bg-red-700 text-white hover:bg-red-600"
                  >
                    清除
                  </button>
                )}
                {RARITY_OPTIONS.map((ro) => (
                  <button
                    key={ro.value}
                    onClick={() => toggleRarity(ro.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      selectedRarities.includes(ro.value)
                        ? 'bg-amber-600 text-white ring-2 ring-amber-400'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {ro.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---- Card grid ---- */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500" />
          </div>
        ) : filteredByType.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">沒有符合的卡牌</div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <p className="text-slate-400 text-xs">共 {filteredByType.length} 張卡牌 (顯示 {pagedCards.length} 張)</p>
            </div>
            <div className="flex-1 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3 pr-1">
              {pagedCards.map((card) => {
                const inDeckCount = currentDeck.cards.filter((id) => id === card.id).length;
                const basic = isBasicEnergy(card);
                const copyLimited = !basic && inDeckCount >= 4;
                const maxed = copyLimited || deckCardCount >= MAX_DECK_SIZE;
                const primaryType = (card.types && card.types.length > 0 ? card.types[0] : 'Colorless') as string;
                const hasGradient = card.types && card.types.length > 0;
                const gradientClass = hasGradient
                  ? TYPE_BG[primaryType] || 'from-slate-800/80 to-slate-700/40'
                  : 'from-slate-800/80 to-slate-700/40';

                return (
                  <button
                    key={card.id}
                    onClick={() => !maxed && addCard(card.id, basic)}
                    disabled={maxed}
                    className={`bg-slate-800/80 border rounded-xl overflow-hidden text-left transition-all duration-200 group relative ${
                      maxed
                        ? 'border-slate-700 opacity-40 cursor-not-allowed'
                        : 'border-slate-700/60 hover:border-blue-500/70 hover:shadow-lg hover:shadow-blue-500/10'
                    }`}
                    onMouseEnter={(e) => handleHoverStart(card.id, e)}
                    onMouseLeave={handleHoverEnd}
                  >
                    {/* Image area */}
                    <div className={`aspect-[2.5/3.5] bg-gradient-to-b ${gradientClass} flex items-center justify-center overflow-hidden relative`}>
                      <img
                        src={card.images.small}
                        alt={card.name}
                        className="w-full h-full object-contain p-1.5 group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                      {/* Type badges */}
                      {card.types && card.types.length > 0 && (
                        <div className="absolute top-1.5 left-1.5 flex gap-0.5">
                          {card.types.slice(0, 2).map((t) => <EnergyIcon key={t} type={t} size="sm" />)}
                        </div>
                      )}
                      {/* HP badge */}
                      {card.hp && (
                        <div className="absolute top-1.5 right-1.5 bg-red-900/70 text-red-300 text-[10px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm">
                          HP {card.hp}
                        </div>
                      )}
                      {/* No-image fallback */}
                      {!card.images.small && (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">無圖片</div>
                      )}
                    </div>
                    {/* Info area */}
                    <div className="p-2 space-y-1">
                      <h3 className="text-sm font-semibold text-white truncate leading-tight">{card.name}</h3>
                      <div className="flex items-center gap-2 text-xs">
                        {card.supertype !== 'Pokémon' ? (
                          <span className="text-slate-400">{card.supertype}</span>
                        ) : (() => {
                          const displaySubs = getDisplaySubtypes(card);
                          const mainSub = displaySubs.find(s => s !== 'Basic');
                          return mainSub ? <span className="text-slate-500">{mainSub}</span> : null;
                        })()}
                      </div>
                      {/* Attacks summary */}
                      {card.attacks && card.attacks.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {card.attacks.slice(0, 2).map((atk, i) => (
                            <span key={i} className="text-[10px] text-slate-400 bg-slate-700/50 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                              {atk.cost?.map((c, j) => (
                                <span key={j} className={`inline-block w-2 h-2 rounded-full mr-0.5 ${TYPE_COLORS[c] || 'bg-gray-400'}`} />
                              ))}
                              {atk.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Count indicator */}
                      <div className="flex items-center justify-between pt-0.5">
                        <p className="text-[10px] text-slate-600">{card.set.id} #{card.number}</p>
                        {inDeckCount > 0 && (
                          <span className={`text-xs font-mono ${basic ? 'text-emerald-400' : 'text-blue-400'}`}>
                            {basic ? `x${inDeckCount}` : `${inDeckCount}/4`}
                          </span>
                        )}
                      </div>
                      {/* Add hint */}
                      {!maxed && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors duration-200 rounded-xl">
                          <span className="text-white text-lg font-bold opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none">
                            +
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center items-center gap-2 pt-4 pb-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 rounded-lg text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  上一頁
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  const start = Math.max(1, Math.min(page - 3, totalPages - 6));
                  const n = start + i;
                  if (n > totalPages) return null;
                  return (
                    <button
                      key={n}
                      onClick={() => setPage(n)}
                      className={`w-8 h-8 rounded-lg text-sm font-medium ${
                        page === n ? 'bg-blue-600 text-white' : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1.5 rounded-lg text-sm bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  下一頁
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ============ RIGHT PANEL: Deck Editor ============ */}
      <div className="w-full lg:w-96 xl:w-[28rem] flex flex-col min-h-0">
        {showSaved && (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-4 max-h-80 overflow-y-auto">
            <h3 className="text-sm font-semibold text-slate-300 mb-2">我的牌組</h3>
            {decks.length === 0 ? (
              <p className="text-slate-500 text-xs mb-3">尚未儲存任何牌組</p>
            ) : (
              <div className="space-y-1 mb-3">
                {decks.map((deck) => (
                  <div key={deck.id} className="flex items-center gap-2 bg-slate-700/50 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{deck.name}</p>
                      <p className="text-xs text-slate-500">{deck.cards.length} 張卡牌</p>
                    </div>
                    <button onClick={() => loadDeck(deck.id)} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">載入</button>
                    <button onClick={() => deleteDeck(deck.id)} className="px-2 py-1 text-xs bg-red-700 text-white rounded hover:bg-red-600">刪除</button>
                  </div>
                ))}
              </div>
            )}

            <details className="group">
              <summary className="flex items-center gap-2 cursor-pointer text-sm font-semibold text-slate-300 hover:text-slate-100 mb-2 select-none">
                <span className="transform transition-transform group-open:rotate-90">▶</span>
                內建預組（唯讀）{presetDecks.length} 套
              </summary>
              {presetDecksLoading ? (
                <div className="text-center py-4 text-slate-500 text-xs">載入中...</div>
              ) : presetDecks.length === 0 ? (
                <p className="text-slate-500 text-xs">暫無內建預組</p>
              ) : (
                <div className="space-y-1">
                  {presetDecks.map((deck) => (
                    <div key={deck.id} className="flex items-center gap-2 bg-slate-700/30 rounded-lg px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{deck.name}</p>
                        <p className="text-xs text-slate-500">{deck.cards.length} 張卡牌</p>
                      </div>
                      <button
                        onClick={() => loadPresetDeck(deck.id)}
                        className="px-2 py-1 text-xs bg-emerald-700 text-white rounded hover:bg-emerald-600"
                      >
                        載入
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </div>
        )}

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 mb-3">
            <input
              type="text"
              value={currentDeck.name}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="牌組名稱"
              className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
            <span className={`text-sm font-bold ${deckCardCount === MAX_DECK_SIZE ? 'text-green-400' : deckCardCount > MAX_DECK_SIZE ? 'text-red-400' : 'text-slate-400'}`}>
              {deckCardCount}/{MAX_DECK_SIZE}
            </span>
          </div>

          {!currentDeck.name.trim() && (
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newDeckName}
                onChange={(e) => setNewDeckName(e.target.value)}
                placeholder="新牌組名稱..."
                className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                onKeyDown={(e) => e.key === 'Enter' && handleCreateDeck()}
              />
              <button onClick={handleCreateDeck} className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">新增</button>
            </div>
          )}

          <div className="flex gap-2 mb-3">
            <button
              onClick={handleSave}
              disabled={!currentDeck.name.trim() || deckCardCount === 0}
              className="flex-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              儲存牌組
            </button>
            <button
              onClick={() => { if (currentDeck.id) deleteDeck(currentDeck.id); }}
              disabled={!currentDeck.id}
              className="px-3 py-1.5 text-sm bg-red-700 text-white rounded-lg hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              刪除
            </button>
          </div>

          <div className="flex items-center gap-2 mb-2">
            {validation.valid ? (
              <span className="flex items-center gap-1 text-green-400 text-xs">
                <span className="w-2 h-2 bg-green-400 rounded-full" /> 牌組合法
              </span>
            ) : (
              <span className="flex items-center gap-1 text-red-400 text-xs">
                <span className="w-2 h-2 bg-red-400 rounded-full" /> 牌組不合法
              </span>
            )}
          </div>

          {!validation.valid && validation.errors.length > 0 && (
            <div className="mb-2 space-y-0.5">
              {validation.errors.map((err, i) => (
                <p key={i} className="text-red-400 text-xs">{err}</p>
              ))}
            </div>
          )}

          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {(['Pokémon', 'Trainer', 'Energy'] as const).map((group) => {
              const entries = groupedCards[group];
              if (entries.length === 0) return null;
              const groupLabel = group === 'Pokémon' ? '寶可夢' : group === 'Trainer' ? '訓練家' : '能量';
              return (
                <div key={group}>
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
                    {groupLabel} {entries.reduce((s, e) => s + e.count, 0)}
                  </h4>
                  <div className="space-y-1">
                    {entries.map(({ card, count }) => (
                      <div key={card.id} className="flex items-center gap-2 bg-slate-700/40 rounded-lg px-2.5 py-1.5 group/card">
                        <div className="w-8 h-8 rounded bg-slate-600 overflow-hidden flex-shrink-0">
                          <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-white truncate">{card.name}</p>
                          {card.supertype === 'Pokémon' && card.types && (
                            <div className="flex gap-0.5 mt-0.5">
                              {card.types.map((t) => <EnergyIcon key={t} type={t} />)}
                            </div>
                          )}
                        </div>
                        <span className="text-xs text-slate-400 font-mono">x{count}</span>
                        <button
                          onClick={() => removeCard(card.id)}
                          className="opacity-0 group-hover/card:opacity-100 text-red-400 hover:text-red-300 text-xs px-1 transition-opacity"
                        >
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {currentDeck.cards.length === 0 && (
              <div className="text-center py-12 text-slate-500 text-sm">
                牌組為空，從左側選擇卡牌
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hover popover */}
      {hoveredCard && (
        <div
          className="fixed z-[60] pointer-events-none"
          style={{ left: hoverPos.x + 20, top: hoverPos.y - 40 }}
        >
          <div className="bg-slate-800/95 border border-slate-600 rounded-2xl shadow-2xl backdrop-blur-sm w-72 overflow-hidden">
            <div className="bg-slate-700/50 p-3 flex justify-center">
              <img src={hoveredCard.images.large} alt={hoveredCard.name} className="h-64 w-auto object-contain rounded-lg" />
            </div>
            <div className="p-3 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-white font-bold text-sm leading-tight">{hoveredCard.name}</h3>
                  <p className="text-slate-400 text-xs">{hoveredCard.supertype} | {hoveredCard.set.id} #{hoveredCard.number}</p>
                </div>
                {hoveredCard.hp && (
                  <div className="flex items-center gap-1">
                    <span className="text-red-400 font-bold text-base">HP {hoveredCard.hp}</span>
                    {hoveredCard.types?.map((t) => <EnergyIcon key={t} type={t} size="sm" />)}
                  </div>
                )}
              </div>
              <div className="flex gap-2 text-[11px] text-slate-500">
                {hoveredCard.rarity && <span>稀有度: {hoveredCard.rarity}</span>}
                {hoveredCard.regulationMark && <span>規制: {hoveredCard.regulationMark}</span>}
              </div>
              {hoveredCard.abilities && hoveredCard.abilities.length > 0 && (
                <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-2">
                  <span className="text-yellow-400 font-semibold text-xs">{hoveredCard.abilities[0].type}</span>
                  <p className="text-slate-200 text-xs font-medium">{hoveredCard.abilities[0].name}</p>
                  <p className="text-slate-400 text-[11px]">{hoveredCard.abilities[0].text}</p>
                </div>
              )}
              {hoveredCard.attacks && hoveredCard.attacks.length > 0 && (
                <div className="space-y-1.5">
                  {hoveredCard.attacks.slice(0, 2).map((atk, i) => (
                    <div key={i} className="bg-slate-700/40 rounded-lg p-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-white text-xs font-medium">{atk.name}</span>
                          <div className="flex gap-0.5">
                            {atk.cost?.map((c, j) => <EnergyIcon key={j} type={c} />)}
                          </div>
                        </div>
                        <span className="text-sm font-bold text-slate-200">{atk.damage}</span>
                      </div>
                      {atk.text && <p className="text-slate-500 text-[10px] mt-0.5">{atk.text}</p>}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 text-xs text-slate-400">
                {hoveredCard.weaknesses && hoveredCard.weaknesses.length > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="text-slate-500">弱:</span>
                    <EnergyIcon type={hoveredCard.weaknesses[0].type} />
                    <span>{hoveredCard.weaknesses[0].value}</span>
                  </span>
                )}
                {hoveredCard.resistances && hoveredCard.resistances.length > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="text-slate-500">抗:</span>
                    <EnergyIcon type={hoveredCard.resistances[0].type} />
                    <span>{hoveredCard.resistances[0].value}</span>
                  </span>
                )}
                {hoveredCard.retreatCost && hoveredCard.retreatCost.length > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="text-slate-500">逃:</span>
                    {hoveredCard.retreatCost.map((c, i) => <EnergyIcon key={i} type={c} />)}
                  </span>
                )}
              </div>
              <div className="flex gap-2 text-[11px]">
                {hoveredCard.legalities?.standard && (
                  <span className={hoveredCard.legalities.standard === 'Legal' ? 'text-green-400' : 'text-red-400'}>
                    標準: {hoveredCard.legalities.standard}
                  </span>
                )}
                {hoveredCard.legalities?.expanded && (
                  <span className={hoveredCard.legalities.expanded === 'Legal' ? 'text-green-400' : 'text-red-400'}>
                    擴充: {hoveredCard.legalities.expanded}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
