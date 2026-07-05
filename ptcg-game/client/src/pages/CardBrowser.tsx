import { useState, useEffect, useCallback, useRef } from 'react';
import { useCardStore } from '../stores/cardStore';
import type { Card, Supertype, EnergyType } from '@ptcg/shared';

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
  { label: '妖', value: 'Fairy' },
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
  Fairy: 'bg-pink-400',
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
  Fairy: 'from-pink-900/60 to-pink-800/30',
  Dragon: 'from-indigo-900/60 to-indigo-800/30',
  Colorless: 'from-gray-900/60 to-gray-800/30',
};

const PAGE_SIZE = 24;

function EnergyIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' | 'lg' }) {
  const colorClass = TYPE_COLORS[type] || 'bg-gray-400';
  const sizeClass = size === 'lg' ? 'w-7 h-7 text-sm' : size === 'md' ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]';
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full ${colorClass} ${sizeClass} font-bold text-white shadow-sm`}
      title={type}
    >
      {type === 'Colorless' ? '無' : type === 'Psychic' ? '超' : type === 'Fighting' ? '鬥' : type === 'Darkness' ? '惡' : type === 'Lightning' ? '雷' : type === 'Metal' ? '鋼' : type === 'Fairy' ? '妖' : type === 'Dragon' ? '龍' : type.charAt(0)}
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
          <img src={card.images.large} alt={card.name} className="h-64 w-auto object-contain rounded-lg" />
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

          {/* Abilities */}
          {card.abilities && card.abilities.length > 0 && (
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-lg p-2">
              <span className="text-yellow-400 font-semibold text-xs">{card.abilities[0].type}</span>
              <p className="text-slate-200 text-xs font-medium">{card.abilities[0].name}</p>
              <p className="text-slate-400 text-[11px]">{card.abilities[0].text}</p>
            </div>
          )}

          {/* Attacks */}
          {card.attacks && card.attacks.length > 0 && (
            <div className="space-y-1.5">
              {card.attacks.slice(0, 2).map((atk, i) => (
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
      <div className="bg-slate-800 border border-slate-600 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col md:flex-row gap-6 p-6">
          <div className="flex-shrink-0 flex justify-center">
            <img src={card.images.large} alt={card.name} className="w-64 h-auto rounded-lg shadow-lg" />
          </div>
          <div className="flex-1 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">{card.name}</h2>
                <p className="text-slate-400 text-sm">{card.supertype} {card.subtypes.join(' - ')}</p>
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
            </div>
            {card.hp && (
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold text-red-400">HP {card.hp}</span>
                {card.types?.map((t) => <EnergyIcon key={t} type={t} size="md" />)}
              </div>
            )}
            {card.abilities && card.abilities.length > 0 && (
              <div className="bg-slate-700/50 rounded-lg p-3 border-l-4 border-yellow-500">
                <span className="text-yellow-400 font-semibold text-sm">{card.abilities[0].type}</span>
                <p className="text-slate-200 font-medium">{card.abilities[0].name}</p>
                <p className="text-slate-300 text-sm">{card.abilities[0].text}</p>
              </div>
            )}
            {card.attacks && card.attacks.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">招式</h3>
                {card.attacks.map((atk, i) => (
                  <div key={i} className="bg-slate-700/30 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{atk.name}</span>
                        <div className="flex gap-0.5">
                          {atk.cost.map((c, j) => <EnergyIcon key={j} type={c} />)}
                        </div>
                      </div>
                      <span className="text-lg font-bold text-slate-100">{atk.damage}</span>
                    </div>
                    {atk.text && <p className="text-slate-400 text-xs">{atk.text}</p>}
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 text-sm">
              {card.weaknesses && card.weaknesses.length > 0 && (
                <div>
                  <span className="text-slate-500">弱點</span>
                  <div className="flex gap-1 mt-1">
                    {card.weaknesses.map((w, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <EnergyIcon type={w.type} /> <span className="text-slate-300">{w.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {card.resistances && card.resistances.length > 0 && (
                <div>
                  <span className="text-slate-500">抵抗力</span>
                  <div className="flex gap-1 mt-1">
                    {card.resistances.map((r, i) => (
                      <div key={i} className="flex items-center gap-1">
                        <EnergyIcon type={r.type} /> <span className="text-slate-300">{r.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {card.retreatCost && (
              <div className="flex items-center gap-2">
                <span className="text-slate-500 text-sm">撤退費用</span>
                <div className="flex gap-0.5">
                  {card.retreatCost.map((c, i) => <EnergyIcon key={i} type={c} />)}
                </div>
              </div>
            )}
            <div className="pt-2 border-t border-slate-700 text-xs text-slate-500 space-y-1">
              <p>編號: {card.set.id} - {card.number}</p>
              <p>系列: {card.set.series} / {card.set.name}</p>
              {card.rarity && <p>稀有度: {card.rarity}</p>}
              {card.artist && <p>繪師: {card.artist}</p>}
              <div className="flex gap-3 mt-1">
                {card.legalities.standard && <span className={`${card.legalities.standard === 'Legal' ? 'text-green-400' : 'text-red-400'}`}>標準: {card.legalities.standard}</span>}
                {card.legalities.expanded && <span className={`${card.legalities.expanded === 'Legal' ? 'text-green-400' : 'text-red-400'}`}>擴充: {card.legalities.expanded}</span>}
              </div>
            </div>
          </div>
        </div>
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
          onError={(e) => {
            // If image fails, show placeholder
            (e.target as HTMLImageElement).style.display = 'none';
          }}
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
          ) : card.subtypes && card.subtypes.length > 0 && card.subtypes[0] !== 'Basic' ? (
            <span className="text-slate-500">{card.subtypes[0]}</span>
          ) : null}
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

export default function CardBrowser() {
  const { cards, sets, loading, error, fetchCards, searchCards, getCardById, fetchCardDetail } = useCardStore();
  const [query, setQuery] = useState('');
  const [supertype, setSupertype] = useState<Supertype | ''>('');
  const [selectedTypes, setSelectedTypes] = useState<EnergyType[]>([]);
  const [selectedSet, setSelectedSet] = useState('');
  const [hpMin, setHpMin] = useState('');
  const [hpMax, setHpMax] = useState('');
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
  }, [query, supertype, selectedTypes, selectedSet, hpMin, hpMax]);

  const toggleType = (t: EnergyType) => {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const rawFiltered = searchCards(query, {
    supertype: supertype || undefined,
    types: selectedTypes.length > 0 ? selectedTypes : undefined,
    set: selectedSet || undefined,
  });

  const hpFiltered = rawFiltered.filter((c) => {
    const hp = c.hp ? parseInt(c.hp, 10) : NaN;
    if (hpMin && !isNaN(hp) && hp < parseInt(hpMin, 10)) return false;
    if (hpMax && !isNaN(hp) && hp > parseInt(hpMax, 10)) return false;
    return true;
  });

  const totalPages = Math.ceil(hpFiltered.length / PAGE_SIZE);
  const pagedCards = hpFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
          <div className="relative flex-1 sm:flex-initial">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋卡牌名稱..."
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
        </div>
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-5">
          <div>
            <label className="text-sm text-slate-400 mb-2 block">卡牌類型</label>
            <div className="flex flex-wrap gap-2">
              {SUPERTYPES.map((st) => (
                <button
                  key={st.value}
                  onClick={() => setSupertype(st.value as Supertype | '')}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    supertype === st.value
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  }`}
                >
                  {st.label}
                </button>
              ))}
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
                      ? 'text-white ring-2 ring-offset-1 ring-offset-slate-800'
                      : 'text-slate-300 bg-slate-700 hover:bg-slate-600'
                  } ${TYPE_COLORS[to.value]} ${selectedTypes.includes(to.value) ? 'brightness-110' : 'opacity-70'}`}
                >
                  {to.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-1 block">系列</label>
              <select
                value={selectedSet}
                onChange={(e) => setSelectedSet(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">全部系列</option>
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
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
      {!loading && !error && hpFiltered.length === 0 && (
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
            <p className="text-slate-400 text-sm">共 {hpFiltered.length} 張卡牌 (顯示 {pagedCards.length} 張)</p>
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

      {/* Hover popover */}
      {hoveredCardId && <CardHoverPopover cardId={hoveredCardId} position={hoverPos} />}

      {/* Modal */}
      {selectedCard && <CardModal card={selectedCard} onClose={() => setSelectedCard(null)} />}
    </div>
  );
}
