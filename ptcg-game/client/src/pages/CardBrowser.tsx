import { useState, useEffect, useCallback, useRef } from 'react';
import { useCardStore, CARD_TAG_DEFS, ensureEvolutionChains } from '../stores/cardStore';
import type { SearchScope, CardTag } from '../stores/cardStore';
import type { SortOrder } from '../stores/cardStore';
import { ACE_SPEC_NAMES } from '@ptcg/shared';
import type { Card, Supertype, EnergyType, Subtype } from '@ptcg/shared';
import { handleCardImgError } from '../utils/cardImageFallback';
import CardArtDetail from '../components/CardArtDetail';


/** Card type filter defs (single-select) */
const CARD_TYPE_DEFS = [
  { label: '寶可夢', supertype: 'Pokémon' as Supertype },
  { label: '訓練家', supertype: 'Trainer' as Supertype, excludeSubtypes: ['Item', 'Pokémon Tool', 'Stadium'] as Subtype[] },
  { label: '能量', supertype: 'Energy' as Supertype },
  { label: '寶可夢道具', subtype: 'Pokémon Tool' as Subtype },
  { label: '競技場', subtype: 'Stadium' as Subtype },
  { label: '物品', subtype: 'Item' as Subtype },
  { label: 'ACE SPEC', names: ACE_SPEC_NAMES },
] as const;

/** Evolution stage filter defs (independent multi-toggle) */
const STAGE_DEFS = [
  { label: '基礎寶可夢', subtype: 'Basic' as Subtype },
  { label: '1階寶可夢', subtype: 'Stage 1' as Subtype },
  { label: '2階寶可夢', subtype: 'Stage 2' as Subtype },
  { label: 'ex', nameSuffix: 'ex' },
  { label: 'MEGA', namePrefix: '超級' },
] as const;

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

const PAGE_SIZE = 24;

const SORT_OPTIONS: { label: string; value: SortOrder }[] = [
  { label: '編號 ↑', value: 'number-asc' },
  { label: '編號 ↓', value: 'number-desc' },
  { label: '名稱 A→Z', value: 'name-asc' },
  { label: '名稱 Z→A', value: 'name-desc' },
  { label: 'HP ↓', value: 'hp-desc' },
  { label: 'HP ↑', value: 'hp-asc' },
];

// Official asia.pokemon-card.com rarity codes (from the card-search filter panel),
// in the same order the official site lists them.
const RARITY_OPTIONS: { label: string; value: string }[] = [
  { label: 'C', value: 'C' },
  { label: 'U', value: 'U' },
  { label: 'R', value: 'R' },
  { label: 'RR', value: 'RR' },
  { label: 'RRR', value: 'RRR' },
  { label: 'PR', value: 'PR' },
  { label: 'TR', value: 'TR' },
  { label: 'SR', value: 'SR' },
  { label: 'HR', value: 'HR' },
  { label: 'UR', value: 'UR' },
  { label: 'K', value: 'K' },
  { label: 'A', value: 'A' },
  { label: 'AR', value: 'AR' },
  { label: 'SAR', value: 'SAR' },
  { label: 'S', value: 'S' },
  { label: 'SSR', value: 'SSR' },
  { label: 'ACE', value: 'ACE' },
  { label: 'BWR', value: 'BWR' },
  { label: 'MUR', value: 'MUR' },
  { label: 'MA', value: 'MA' },
  { label: '無標記', value: '無標記' },
];

const TYPE_LABELS: Record<string, string> = {
  Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超',
  Fighting: '鬥', Darkness: '惡', Metal: '鋼', Fairy: '妖', Dragon: '龍', Colorless: '無',
};

function EnergyIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' | 'lg' }) {
  const colorClass = TYPE_COLORS[type] || 'bg-gray-400';
  const sizeClass = size === 'lg' ? 'w-7 h-7 text-sm' : size === 'md' ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${colorClass} ${sizeClass} font-bold text-white shadow-sm`}
      title={type}
    >
      {TYPE_LABELS[type] || type.charAt(0)}
    </span>
  );
}

// Hover popover showing detailed card preview
function CardHoverPopover({ cardId, position }: { cardId: string; position: { x: number; y: number } }) {
  const card = useCardStore((s) => s.getCardById(cardId)) || null;
  const popRef = useRef<HTMLDivElement>(null);
  if (!card) return null;

  // Adjust popover position to stay within viewport
  let left = position.x + 20;
  let top = position.y - 40;

  return (
    <div
      ref={popRef}
      className="fixed z-[60] pointer-events-none"
      style={{ left, top }}
    >
      <div className="bg-slate-800/95 border border-slate-600 rounded-2xl shadow-2xl backdrop-blur-sm w-72 overflow-hidden">
        {/* Card image */}
        <div className="bg-slate-700/50 p-3 flex justify-center">
          <img src={card.images.large} alt={card.name} className="h-64 w-auto object-contain rounded-lg" onError={handleCardImgError} />
        </div>
        <div className="p-3 space-y-2">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-white font-bold text-sm leading-tight">{card.name}</h3>
              <p className="text-slate-400 text-xs">{card.supertype} | {card.set.id} #{card.number}</p>
            </div>
            {card.hp && (
              <div className="flex items-center gap-1">
                <span className="text-red-400 font-bold text-base">HP {card.hp}</span>
                {card.types?.map((t) => <EnergyIcon key={t} type={t} size="sm" />)}
              </div>
            )}
          </div>

          {/* Rarity & Regulation */}
          <div className="flex gap-2 text-[11px] text-slate-500">
            {card.rarity && <span>稀有度: {card.rarity}</span>}
            {card.regulationMark && <span>規制: {card.regulationMark}</span>}
          </div>

          {/* Rules text (V/VMAX/ex rule box etc.) */}
          {card.rules && card.rules.length > 0 && (
            <div className="space-y-1">
              {card.rules.map((rule, i) => (
                <p key={i} className="text-slate-400 text-[11px] italic">{rule}</p>
              ))}
            </div>
          )}

          {/* Abilities */}
          {card.abilities && card.abilities.length > 0 && (
            <div className="space-y-1.5">
              {card.abilities.map((ab, i) => (
                <div key={i} className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-2">
                  <span className="text-yellow-400 font-semibold text-xs">{ab.type}</span>
                  <p className="text-slate-200 text-xs font-medium">{ab.name}</p>
                  <p className="text-slate-400 text-[11px]">{ab.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Attacks */}
          {card.attacks && card.attacks.length > 0 && (
            <div className="space-y-1.5">
              {card.attacks.map((atk, i) => (
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

          {/* Weakness/Resistance/Retreat */}
          <div className="flex items-center gap-3 text-xs text-slate-400">
            {card.weaknesses && card.weaknesses.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="text-slate-500">弱:</span>
                <EnergyIcon type={card.weaknesses[0].type} />
                <span>{card.weaknesses[0].value}</span>
              </span>
            )}
            {card.resistances && card.resistances.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="text-slate-500">抗:</span>
                <EnergyIcon type={card.resistances[0].type} />
                <span>{card.resistances[0].value}</span>
              </span>
            )}
            {card.retreatCost && card.retreatCost.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="text-slate-500">逃:</span>
                {card.retreatCost.map((c, i) => <EnergyIcon key={i} type={c} />)}
              </span>
            )}
          </div>

          {/* Legality */}
          <div className="flex gap-2 text-[11px]">
            {card.legalities?.standard && (
              <span className={card.legalities.standard === 'Legal' ? 'text-green-400' : 'text-red-400'}>
                標準: {card.legalities.standard}
              </span>
            )}
            {card.legalities?.expanded && (
              <span className={card.legalities.expanded === 'Legal' ? 'text-green-400' : 'text-red-400'}>
                擴充: {card.legalities.expanded}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CardModal({ card, onClose }: { card: Card; onClose: () => void }) {
  if (!card) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="bg-slate-800 border border-slate-600 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end -mt-2 -mr-2 mb-1">
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>
        <CardArtDetail card={card} variant="full" />
      </div>
    </div>
  );
}

function CardGridItem({
  card,
  onSelect,
  onHoverStart,
  onHoverEnd,
}: {
  card: Card;
  onSelect: () => void;
  onHoverStart: (id: string, e: React.MouseEvent) => void;
  onHoverEnd: () => void;
}) {
  const primaryType = (card.types && card.types.length > 0 ? card.types[0] : 'Colorless') as string;
  const hasGradient = card.types && card.types.length > 0;
  const gradientClass = hasGradient
    ? TYPE_BG[primaryType] || 'from-slate-800/80 to-slate-700/40'
    : 'from-slate-800/80 to-slate-700/40';

  return (
    <button
      onClick={onSelect}
      onMouseEnter={(e) => onHoverStart(card.id, e)}
      onMouseLeave={onHoverEnd}
      className="bg-slate-800/80 border border-slate-700/60 rounded-xl overflow-hidden hover:border-blue-500/70 hover:shadow-lg hover:shadow-blue-500/10 transition-all duration-200 text-left group relative"
    >
      {/* Image area with gradient background */}
      <div className={`aspect-[2.5/3.5] bg-gradient-to-b ${gradientClass} flex items-center justify-center overflow-hidden relative`}>
        <img
          src={card.images.small}
          alt={card.name}
          className="w-full h-full object-contain p-1.5 group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
          onError={handleCardImgError}
        />
        {/* Type badge top-left (only when types available) */}
        {card.types && card.types.length > 0 && (
          <div className="absolute top-2 left-2 flex gap-0.5">
            {card.types.slice(0, 2).map((t) => <EnergyIcon key={t} type={t} size="sm" />)}
          </div>
        )}
        {/* HP badge top-right for Pokemon */}
        {card.hp && (
          <div className="absolute top-2 right-2 bg-red-900/70 text-red-300 text-[10px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-sm">
            HP {card.hp}
          </div>
        )}
        {/* Fallback overlay when no image */}
        {!card.images.small && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-xs">
            無圖片
          </div>
        )}
      </div>
      {/* Info area */}
      <div className="p-2.5 space-y-1">
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
        {/* Attacks summary (only when details loaded) */}
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
        {/* Set info */}
        <p className="text-[10px] text-slate-600 pt-0.5">{card.set.id} #{card.number}</p>
      </div>
    </button>
  );
}

function getDisplaySubtypes(card: Card): string[] {
  // Filter hidden subtypes at runtime (ex, V-UNION)
  const hidden = new Set(['ex', 'V-UNION']);
  return card.subtypes.filter((s: string) => !hidden.has(s));
}

export default function CardBrowser() {
  const { cards, sets, loading, error, fetchCards, searchCards, getCardById, fetchCardDetail } = useCardStore();
  const [query, setQuery] = useState('');
  const [selectedCardType, setSelectedCardType] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<EnergyType[]>([]);
  const [selectedSet, setSelectedSet] = useState('');
  const [hpMin, setHpMin] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [standardOnly, setStandardOnly] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('number-asc');
  const [selectedRarities, setSelectedRarities] = useState<string[]>([]);
  const [searchScope, setSearchScope] = useState<SearchScope>('name');
  const [viewMode, setViewMode] = useState<'list' | 'sets'>('list');
  const [selectedTag, setSelectedTag] = useState<CardTag | null>(null);
  const [selectedMarks, setSelectedMarks] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedCard, setSelectedCard] = useState<Card | null>(null);
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  useEffect(() => {
    setPage(1);
  }, [query, selectedCardType, selectedStage, selectedTypes, selectedSet, hpMin, hpMax, standardOnly, sortOrder, selectedRarities, searchScope, selectedTag, selectedMarks]);

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

  // ---- Set-pack view data: per-set card count + dominant regulation mark ----
  const setPacks = (() => {
    if (viewMode !== 'sets') return [];
    const bySet = new Map<string, { id: string; name: string; count: number; marks: Record<string, number> }>();
    for (const c of cards) {
      const id = c.set?.id;
      if (!id) continue;
      const e = bySet.get(id) ?? { id, name: c.set?.name || id, count: 0, marks: {} };
      e.count++;
      if (!e.name && c.set?.name) e.name = c.set.name;
      if (c.regulationMark) e.marks[c.regulationMark] = (e.marks[c.regulationMark] ?? 0) + 1;
      bySet.set(id, e);
    }
    return [...bySet.values()].map(e => ({
      ...e,
      mark: Object.entries(e.marks).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—',
    }));
  })();
  const MARK_ORDER = ['J', 'I', 'H', 'G', 'F', 'E', 'D', '—'];

  const openSetPack = (packId: string, mark: string) => {
    setSelectedSet(packId);
    if (!['H', 'I', 'J'].includes(mark)) setStandardOnly(false); // otherwise a rotated pack lists empty
    setViewMode('list');
  };

  // Build filter args — non-type filters are sent to searchCards (AND logic)
  const filterArgs: {
    types?: string[];
    set?: string;
    rarity?: string[];
    sortOrder?: SortOrder;
    searchScope?: SearchScope;
    tag?: CardTag;
    regulationMarks?: string[];
  } = {};
  filterArgs.searchScope = searchScope;
  if (selectedTag) filterArgs.tag = selectedTag;
  if (selectedMarks.length > 0) filterArgs.regulationMarks = selectedMarks;

  if (selectedTypes.length > 0) {
    filterArgs.types = selectedTypes;
  }
  if (selectedSet) {
    filterArgs.set = selectedSet;
  }
  if (selectedRarities.length > 0) {
    filterArgs.rarity = selectedRarities;
  }
  filterArgs.sortOrder = sortOrder;

  let rawFiltered = searchCards(query, filterArgs);

  // Default to showing only standard-legal cards
  if (standardOnly) {
    rawFiltered = rawFiltered.filter(c => c.legalities?.standard === 'Legal');
  }

  const hpFiltered = rawFiltered.filter((c) => {
    if (!hpMin && !hpMax) return true;
    const hp = c.hp ? parseInt(c.hp, 10) : NaN;
    // Cards with no HP (Trainer/Energy) can't match an HP range at all.
    if (isNaN(hp)) return false;
    if (hpMin && hp < parseInt(hpMin, 10)) return false;
    if (hpMax && hp > parseInt(hpMax, 10)) return false;
    return true;
  });

  // Client-side single-select filter for card types & stages
  const filteredByType = hpFiltered.filter((c) => {
    // Card type check
    let typeMatch = true;
    if (selectedCardType) {
      const def = CARD_TYPE_DEFS.find((d) => d.label === selectedCardType);
      if (def) {
        if ('supertype' in def) typeMatch = c.supertype === def.supertype;
        if ('subtype' in def) typeMatch = c.subtypes?.includes(def.subtype);
        if ('rarity' in def) typeMatch = c.rarity === def.rarity;
        if ('names' in def) typeMatch = (def.names as readonly string[]).includes(c.name);
        if ('excludeSubtypes' in def && def.excludeSubtypes) {
          typeMatch = typeMatch && !def.excludeSubtypes.some(s => c.subtypes?.includes(s));
        }
      }
    }
    // Evolution stage check
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

  const handleHoverStart = useCallback((cardId: string, e: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

    // Fetch full card details on hover (summary cards lack abilities/attacks/etc)
    fetchCardDetail(cardId);

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <h1 className="text-2xl font-bold text-white">卡牌瀏覽</h1>
        <div className="flex gap-2 w-full sm:w-auto">
          <select
            value={searchScope}
            onChange={(e) => { const v = e.target.value as SearchScope; setSearchScope(v); if (v === 'evolution') void ensureEvolutionChains(); }}
            title="關鍵字要搜尋卡片的哪個部分"
            className="bg-slate-800 border border-slate-600 rounded-lg px-2 py-2 text-slate-300 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="name">名稱</option>
            <option value="attack">招式</option>
            <option value="ability">特性</option>
            <option value="evolution">進化鏈</option>
            <option value="all">全部</option>
          </select>
          <div className="relative flex-1 sm:flex-initial">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchScope === 'attack' ? '搜尋招式名稱或效果文字...' : searchScope === 'ability' ? '搜尋特性名稱或效果文字...' : searchScope === 'all' ? '搜尋名稱／招式／特性...' : '搜尋卡牌名稱...'}
              className="w-full sm:w-72 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-4 py-2 rounded-lg border transition-colors ${
              showFilters ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500'
            }`}
          >
            篩選
          </button>
          <button
            onClick={() => setViewMode(viewMode === 'sets' ? 'list' : 'sets')}
            title="在清單與卡包分組視圖間切換"
            className={`px-4 py-2 rounded-lg border transition-colors ${
              viewMode === 'sets' ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500'
            }`}
          >
            📦 卡包
          </button>
        </div>
      </div>

      {/* Set-pack grouped view: J/I/H sections, per-pack card counts. Release dates are
          absent from the whole dataset (TCGdex zh-tw never populates them) — ROADMAP note. */}
      {viewMode === 'sets' && (
        <div className="space-y-6">
          {MARK_ORDER.filter(m => setPacks.some(p => p.mark === m)).map(mark => (
            <div key={mark}>
              <h2 className="text-lg font-bold text-amber-300 mb-2">
                {mark === '—' ? '無標記' : `${mark} 標`}
                <span className="text-xs text-slate-500 ml-2">{setPacks.filter(p => p.mark === mark).length} 個卡包</span>
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {setPacks.filter(p => p.mark === mark).sort((a, b) => b.id.localeCompare(a.id)).map(p => (
                  <button
                    key={p.id}
                    onClick={() => openSetPack(p.id, p.mark)}
                    className="text-left bg-slate-800 border border-slate-700 rounded-lg p-3 hover:border-emerald-500 transition-colors"
                  >
                    <div className="text-sm font-semibold text-white truncate">{p.name || p.id}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{p.id} · {p.count} 張</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === 'list' && (<>
      {/* Filters */}
      {showFilters && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-5">
          {/* 卡牌類型 — single-select */}
          <div>
            <label className="text-sm text-slate-400 mb-2 block">卡牌類型</label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedCardType(null)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  !selectedCardType
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                全部
              </button>
              {CARD_TYPE_DEFS.map((def) => {
                const active = selectedCardType === def.label;
                return (
                  <button
                    key={def.label}
                    onClick={() => selectCardType(def.label)}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {def.label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* 標籤 — single-select mechanic tags (derived from card data; see cardMatchesTag) */}
          <div>
            <label className="text-sm text-slate-400 mb-2 block">標籤</label>
            <div className="flex flex-wrap gap-2">
              {CARD_TAG_DEFS.map(({ tag, label }) => (
                <button
                  key={tag}
                  onClick={() => setSelectedTag(prev => prev === tag ? null : tag)}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    selectedTag === tag ? 'bg-purple-600 border-purple-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 賽季 — multi-select regulation marks */}
          <div>
            <label className="text-sm text-slate-400 mb-2 block">賽季標記</label>
            <div className="flex flex-wrap gap-2">
              {['H', 'I', 'J'].map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMarks(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m])}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    selectedMarks.includes(m) ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {m} 標
                </button>
              ))}
            </div>
          </div>

          {/* 進化分類 — single-select */}
          <div>
            <label className="text-sm text-slate-400 mb-2 block">進化分類</label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedStage(null)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  !selectedStage
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                全部
              </button>
              {STAGE_DEFS.map((def) => {
                const active = selectedStage === def.label;
                return (
                  <button
                    key={def.label}
                    onClick={() => selectStage(def.label)}
                    className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {def.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-2 block">屬性</label>
            <div className="flex flex-wrap gap-2">
              {TYPE_OPTIONS.map((to) => (
                <button
                  key={to.value}
                  onClick={() => toggleType(to.value)}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
                    selectedTypes.includes(to.value)
                      ? `text-white ring-2 ring-offset-1 ring-offset-slate-800 ${TYPE_COLORS[to.value]} brightness-110`
                      : 'text-slate-300 bg-slate-700 hover:bg-slate-600'
                  }`}
                >
                  {to.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-1 block">標準</label>
              <button
                onClick={() => setStandardOnly(!standardOnly)}
                className={`w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  standardOnly
                    ? 'bg-green-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {standardOnly ? '✓ 僅標準賽制' : '顯示全部卡牌'}
              </button>
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">排列順序</label>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">系列</label>
              <select
                value={selectedSet}
                onChange={(e) => setSelectedSet(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500"
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
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1 block">HP 範圍</label>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  value={hpMin}
                  onChange={(e) => setHpMin(e.target.value)}
                  placeholder="最小"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                <span className="text-slate-500">-</span>
                <input
                  type="number"
                  value={hpMax}
                  onChange={(e) => setHpMax(e.target.value)}
                  placeholder="最大"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-2 block">稀有度</label>
            <div className="flex flex-wrap gap-2">
              {selectedRarities.length > 0 && (
                <button
                  onClick={() => setSelectedRarities([])}
                  className="px-3 py-1 rounded-lg text-sm font-medium bg-red-700 text-white hover:bg-red-600"
                >
                  清除
                </button>
              )}
              {RARITY_OPTIONS.map((ro) => (
                <button
                  key={ro.value}
                  onClick={() => toggleRarity(ro.value)}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
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

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-center">
          載入失敗: {error}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && filteredByType.length === 0 && (
        <div className="text-center py-20 text-slate-500">
          <div className="text-5xl mb-4">🔍</div>
          <p className="text-lg">沒有找到符合條件的卡牌</p>
          <p className="text-sm mt-1">請調整搜尋條件再試一次</p>
        </div>
      )}

      {/* Card grid */}
      {!loading && !error && pagedCards.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-sm">共 {filteredByType.length} 張卡牌 (顯示 {pagedCards.length} 張)</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
            {pagedCards.map((card) => (
              <CardGridItem
                key={card.id}
                card={card}
                onSelect={() => setSelectedCard(card)}
                onHoverStart={(id, e) => handleHoverStart(id, e)}
                onHoverEnd={handleHoverEnd}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 pt-4">
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

      </>)}

      {/* Hover popover */}
      {hoveredCardId && <CardHoverPopover cardId={hoveredCardId} position={hoverPos} />}

      {/* Modal */}
      {selectedCard && <CardModal card={selectedCard} onClose={() => setSelectedCard(null)} />}
    </div>
  );
}
