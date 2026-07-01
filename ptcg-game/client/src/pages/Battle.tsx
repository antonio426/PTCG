import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useDeckStore } from '../stores/deckStore';
import { useCardStore } from '../stores/cardStore';
import { useGameStore } from '../stores/gameStore';
import type { Card } from '@ptcg/shared';

type GamePhase = 'select' | 'playing' | 'ended';

interface LogEntry {
  player: number;
  action: string;
  detail: string;
  turn: number;
}

function ActiveCard({ card, faceDown, label }: { card?: Card | null; faceDown?: boolean; label?: string }) {
  if (!card || faceDown) {
    return (
      <div className="flex flex-col items-center gap-1">
        <div className="w-20 h-28 bg-slate-700 border-2 border-dashed border-slate-600 rounded-lg flex items-center justify-center">
          <span className="text-slate-500 text-xs">?</span>
        </div>
        {label && <span className="text-xs text-slate-500">{label}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1 group cursor-pointer">
      <div className="w-20 h-28 bg-slate-700 border-2 border-slate-600 rounded-lg overflow-hidden group-hover:border-yellow-500 transition-colors">
        <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
      </div>
      <span className="text-xs text-white truncate max-w-20 text-center">{card.name}</span>
      {label && <span className="text-xs text-slate-500">{label}</span>}
    </div>
  );
}

function BenchCard({ card, faceDown }: { card?: Card | null; faceDown?: boolean }) {
  if (!card || faceDown) {
    return (
      <div className="w-14 h-20 bg-slate-800 border border-dashed border-slate-600 rounded-md flex items-center justify-center">
        <span className="text-slate-600 text-xs">?</span>
      </div>
    );
  }

  return (
    <div className="w-14 h-20 bg-slate-700 border border-slate-600 rounded-md overflow-hidden cursor-pointer hover:border-slate-500 transition-colors">
      <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
    </div>
  );
}

function HandCard({ card }: { card: Card }) {
  return (
    <div className="w-16 h-22 bg-slate-700 border border-slate-600 rounded-lg overflow-hidden hover:border-yellow-500 hover:-translate-y-2 transition-all cursor-pointer shadow-lg flex-shrink-0">
      <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
    </div>
  );
}

export default function Battle() {
  const { id: routeGameId } = useParams<{ id: string }>();
  const { decks, loadDeck, currentDeck } = useDeckStore();
  const { cards, fetchCards } = useCardStore();
  const { createAIBattle, leaveGame } = useGameStore();

  const [phase, setPhase] = useState<GamePhase>('select');
  const [selectedDeckId, setSelectedDeckId] = useState('');
  const [gameLog, setGameLog] = useState<LogEntry[]>([]);
  const [opponentActive, setOpponentActive] = useState<Card | null>(null);
  const [opponentBench, setOpponentBench] = useState<(Card | null)[]>([null, null, null, null, null]);
  const [playerHand, setPlayerHand] = useState<Card[]>([]);
  const [playerActive, setPlayerActive] = useState<Card | null>(null);
  const [playerBench, setPlayerBench] = useState<(Card | null)[]>([null, null, null, null, null]);
  const [playerPrizes, setPlayerPrizes] = useState(6);
  const [opponentPrizes, setOpponentPrizes] = useState(6);
  const [isMyTurn, setIsMyTurn] = useState(true);
  const [turnNumber, setTurnNumber] = useState(1);
  const [winner, setWinner] = useState<number | null>(null);
  const [showPlayerDiscard, setShowPlayerDiscard] = useState(false);
  const [showOpponentDiscard, setShowOpponentDiscard] = useState(false);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  useEffect(() => {
    if (routeGameId) {
      setPhase('playing');
    }
  }, [routeGameId]);

  const handleStartBattle = async () => {
    if (!selectedDeckId) return;
    const deck = decks.find((d) => d.id === selectedDeckId);
    if (!deck) return;

    setPhase('playing');
    setTurnNumber(1);
    setIsMyTurn(true);
    setGameLog([
      { player: 0, action: '對戰開始', detail: '雙方各抽 7 張手牌', turn: 0 },
      { player: 0, action: '決定先攻', detail: '你先攻！', turn: 0 },
    ]);
    setPlayerPrizes(6);
    setOpponentPrizes(6);
    setWinner(null);

    const deckCards = deck.cards.map((id) => cards.find((c) => c.id === id)).filter(Boolean) as Card[];
    const hand = deckCards.slice(0, 7);
    setPlayerHand(hand);

    if (hand.length > 0) {
      const basic = hand.find((c) => c.subtypes.includes('Basic'));
      if (basic) {
        setPlayerActive(basic);
        setPlayerHand((prev) => prev.filter((c) => c.id !== basic.id));
      }
    }
  };

  const handleEndTurn = () => {
    setIsMyTurn(false);
    setTurnNumber((t) => t + 1);
    setGameLog((prev) => [
      ...prev,
      { player: 0, action: '結束回合', detail: `第 ${turnNumber} 回合結束`, turn: turnNumber },
    ]);

    setTimeout(() => {
      setIsMyTurn(true);
      setGameLog((prev) => [
        ...prev,
        { player: 1, action: 'AI 思考中', detail: 'AI 正在決定行動...', turn: turnNumber },
      ]);

      setTimeout(() => {
        const basicCards = cards.filter((c) => c.subtypes.includes('Basic'));
        if (basicCards.length > 0) {
          const randomActive = basicCards[Math.floor(Math.random() * basicCards.length)];
          setOpponentActive(randomActive);
        }
        setGameLog((prev) => [
          ...prev,
          { player: 1, action: 'AI 結束回合', detail: `第 ${turnNumber} 回合結束`, turn: turnNumber },
        ]);
      }, 1500);
    }, 500);
  };

  const selectedDeck = decks.find((d) => d.id === selectedDeckId);

  if (phase === 'select') {
    return (
      <div className="flex items-center justify-center min-h-[70vh]">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-md">
          <h1 className="text-2xl font-bold text-white text-center mb-6">AI 對戰練習</h1>

          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">選擇牌組</label>
              {decks.length === 0 ? (
                <p className="text-slate-500 text-sm bg-slate-700/50 rounded-lg p-3 text-center">
                  尚無可用牌組，請先到牌組構築建立牌組
                </p>
              ) : (
                <select
                  value={selectedDeckId}
                  onChange={(e) => setSelectedDeckId(e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  <option value="">選擇牌組...</option>
                  {decks.map((d) => (
                    <option key={d.id} value={d.id}>{d.name} ({d.cards.length} 張)</option>
                  ))}
                </select>
              )}
            </div>

            {selectedDeck && (
              <div className="bg-slate-700/40 rounded-lg p-3 text-sm text-slate-300">
                <p>牌組: {selectedDeck.name}</p>
                <p>卡牌: {selectedDeck.cards.length} 張</p>
              </div>
            )}

            <button
              onClick={handleStartBattle}
              disabled={!selectedDeckId}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              開始對戰
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-[calc(100vh-8rem)] min-h-0">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-red-400">對手</span>
              <div className="flex gap-1">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={`w-3 h-3 rounded-full ${i < opponentPrizes ? 'bg-yellow-400' : 'bg-slate-700'}`} />
                ))}
              </div>
              <button onClick={() => setShowOpponentDiscard(true)} className="text-xs text-slate-500 hover:text-slate-300">
                棄牌堆
              </button>
            </div>
            <span className="text-xs text-slate-500">回合 {turnNumber}</span>
          </div>

          <div className="flex justify-center mb-3">
            <ActiveCard card={opponentActive} label="戰鬥寶可夢" />
          </div>

          <div className="flex justify-center gap-2">
            {opponentBench.map((card, i) => (
              <BenchCard key={i} card={card} />
            ))}
          </div>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 mb-3 flex-1 flex flex-col items-center justify-center min-h-0">
          {winner !== null ? (
            <div className="text-center">
              <p className="text-2xl font-bold text-yellow-400 mb-2">
                {winner === 0 ? '你贏了！' : '你輸了！'}
              </p>
              <button
                onClick={() => setPhase('select')}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                返回大廳
              </button>
            </div>
          ) : isMyTurn ? (
            <div className="flex gap-4">
              <button className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm hover:bg-green-700">抽牌</button>
              <button className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">使用支援者</button>
              <button className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700">進化</button>
              <button className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm hover:bg-yellow-700">能量</button>
              <button className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700">撤退</button>
              <button onClick={handleEndTurn} className="px-4 py-2 bg-slate-600 text-white rounded-lg text-sm hover:bg-slate-500">
                結束回合
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-slate-400">
              <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-blue-500" />
              AI 思考中...
            </div>
          )}
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-blue-400">你</span>
              <div className="flex gap-1">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={`w-3 h-3 rounded-full ${i < playerPrizes ? 'bg-yellow-400' : 'bg-slate-700'}`} />
                ))}
              </div>
              <button onClick={() => setShowPlayerDiscard(true)} className="text-xs text-slate-500 hover:text-slate-300">
                棄牌堆
              </button>
            </div>
            <span className="text-xs text-slate-500">手牌 {playerHand.length}</span>
          </div>

          <div className="flex justify-center mb-3">
            <ActiveCard card={playerActive} label="戰鬥寶可夢" />
          </div>

          <div className="flex justify-center gap-2 mb-3">
            {playerBench.map((card, i) => (
              <BenchCard key={i} card={card} />
            ))}
          </div>

          <div className="flex justify-center gap-2 overflow-x-auto pb-2">
            {playerHand.length === 0 ? (
              <div className="text-slate-600 text-sm py-4">手牌為空</div>
            ) : (
              <div className="flex gap-2">
                {playerHand.slice(0, 10).map((card, i) => (
                  <div
                    key={i}
                    className="flex-shrink-0 w-14 h-20 bg-slate-700 border border-slate-600 rounded-md overflow-hidden hover:border-yellow-500 hover:-translate-y-2 transition-all cursor-pointer shadow-lg"
                  >
                    <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
                  </div>
                ))}
                {playerHand.length > 10 && (
                  <div className="flex items-center text-slate-500 text-xs px-2">
                    +{playerHand.length - 10}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="w-72 flex-shrink-0 bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col min-h-0">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">對戰紀錄</h3>
        <div className="flex-1 overflow-y-auto space-y-1.5">
          {gameLog.length === 0 ? (
            <p className="text-slate-600 text-xs">尚無紀錄</p>
          ) : (
            [...gameLog].reverse().map((entry, i) => (
              <div key={i} className="text-xs border-l-2 border-slate-700 pl-2 py-0.5">
                <span className={`font-medium ${entry.player === 0 ? 'text-blue-400' : 'text-red-400'}`}>
                  [{entry.turn}]
                </span>{' '}
                <span className="text-slate-200">{entry.action}</span>
                {entry.detail && <p className="text-slate-500 mt-0.5">{entry.detail}</p>}
              </div>
            ))
          )}
        </div>
      </div>

      {showPlayerDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowPlayerDiscard(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">你的棄牌堆</h3>
              <button onClick={() => setShowPlayerDiscard(false)} className="text-slate-400 hover:text-white">&times;</button>
            </div>
            <p className="text-slate-500 text-sm">暫無棄牌</p>
          </div>
        </div>
      )}

      {showOpponentDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowOpponentDiscard(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">對手棄牌堆</h3>
              <button onClick={() => setShowOpponentDiscard(false)} className="text-slate-400 hover:text-white">&times;</button>
            </div>
            <p className="text-slate-500 text-sm">暫無棄牌</p>
          </div>
        </div>
      )}
    </div>
  );
}
