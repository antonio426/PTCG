import { useState, useEffect } from 'react';
import { useCardStore } from '../stores/cardStore';
import { useDeckStore } from '../stores/deckStore';
import { MAX_DECK_SIZE } from '@ptcg/shared';
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

function EnergyIcon({ type }: { type: string }) {
  const colorClass = TYPE_COLORS[type] || 'bg-gray-400';
  return (
    <span className={`inline-flex items-center justify-center rounded-full ${colorClass} w-4 h-4 text-[8px] font-bold text-white`} title={type}>
      {type === 'Colorless' ? '無' : type.charAt(0)}
    </span>
  );
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

export default function DeckBuilder() {
  const { cards, sets, loading, fetchCards, searchCards } = useCardStore();
  const {
    decks, currentDeck, presetDecks, presetDecksLoading,
    createDeck, addCard, removeCard, saveDeck, loadDeck, deleteDeck, validateDeck, setDeckName,
    fetchPresetDecks, loadPresetDeck,
  } = useDeckStore();

  const [query, setQuery] = useState('');
  const [supertype, setSupertype] = useState<Supertype | ''>('');
  const [selectedTypes, setSelectedTypes] = useState<EnergyType[]>([]);
  const [selectedSet, setSelectedSet] = useState('');
  const [showSaved, setShowSaved] = useState(false);
  const [newDeckName, setNewDeckName] = useState('');
  const [validation, setValidation] = useState(validateDeck);

  useEffect(() => {
    fetchCards();
    fetchPresetDecks();
  }, [fetchCards, fetchPresetDecks]);

  useEffect(() => {
    const result = validateDeck();
    setValidation(result);
  }, [currentDeck.cards, validateDeck]);

  const toggleType = (t: EnergyType) => {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  };

  const filteredCards = searchCards(query, {
    supertype: supertype || undefined,
    types: selectedTypes.length > 0 ? selectedTypes : undefined,
    set: selectedSet || undefined,
  });

  const deckCardCount = currentDeck.cards.length;
  const groupedCards = groupBySupertype(cards, currentDeck.cards);

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

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-8rem)]">
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

        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋卡牌..."
            className="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <select
            value={selectedSet}
            onChange={(e) => setSelectedSet(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-blue-500 w-40"
          >
            <option value="">全部系列</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
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
                  ? 'text-white ring-2 ring-offset-1 ring-offset-slate-900'
                  : 'text-slate-300 bg-slate-700 hover:bg-slate-600'
              } ${TYPE_COLORS[to.value]} ${selectedTypes.includes(to.value) ? 'brightness-110' : 'opacity-70'}`}
            >
              {to.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500" />
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-sm">沒有符合的卡牌</div>
        ) : (
          <div className="flex-1 overflow-y-auto grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 pr-1">
            {filteredCards.map((card) => {
              const inDeckCount = currentDeck.cards.filter((id) => id === card.id).length;
              const maxed = inDeckCount >= 4 || deckCardCount >= MAX_DECK_SIZE;
              return (
                <button
                  key={card.id}
                  onClick={() => !maxed && addCard(card.id)}
                  disabled={maxed}
                  className={`bg-slate-800 border rounded-lg overflow-hidden text-left transition-all ${
                    maxed ? 'border-slate-700 opacity-40 cursor-not-allowed' : 'border-slate-700 hover:border-blue-500 hover:shadow-md'
                  }`}
                >
                  <div className="aspect-[3/4] bg-slate-700">
                    <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" loading="lazy" />
                  </div>
                  <div className="p-1.5">
                    <p className="text-xs text-white truncate">{card.name}</p>
                    {card.supertype === 'Pokémon' && card.types && (
                      <div className="flex gap-0.5 mt-0.5">
                        {card.types.map((t) => <EnergyIcon key={t} type={t} />)}
                      </div>
                    )}
                    {inDeckCount > 0 && (
                      <span className="text-xs text-blue-400">{inDeckCount}/4</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

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
    </div>
  );
}
