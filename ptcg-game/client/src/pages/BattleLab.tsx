import { useState, useEffect, useCallback } from 'react';
import { useDeckStore } from '../stores/deckStore';

interface TestResult {
  deckAWins: number;
  deckBWins: number;
  totalGames: number;
  averageTurns: number;
  gameLogs: GameLogEntry[];
}

interface GameLogEntry {
  game: number;
  winner: 0 | 1;
  turns: number;
  events: { turn: number; player: number; action: string; thought?: string }[];
}

export default function BattleLab() {
  const { decks } = useDeckStore();

  const [deckA, setDeckA] = useState('');
  const [deckB, setDeckB] = useState('');
  const [numGames, setNumGames] = useState(100);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TestResult | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const runTest = useCallback(async () => {
    if (!deckA || !deckB) return;

    setRunning(true);
    setProgress(0);
    setResult(null);

    try {
      const deckACards = decks.find(d => d.id === deckA)?.cards || [];
      const deckBCards = decks.find(d => d.id === deckB)?.cards || [];

      const batchSize = Math.min(numGames, 10);
      let allResults: { game: number; winner: 0 | 1; turns: number; events: GameLogEntry['events'] }[] = [];
      let deckAWins = 0;
      let deckBWins = 0;
      let totalTurns = 0;

      for (let batch = 0; batch < numGames; batch += batchSize) {
        const gamesThisBatch = Math.min(batchSize, numGames - batch);

        const res = await fetch('/api/battles/ai-vs-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deckA: deckACards, deckB: deckBCards, games: gamesThisBatch }),
        });

        if (!res.ok) throw new Error('Battle API failed');

        const data = await res.json();

        for (let i = 0; i < data.results.length; i++) {
          const gameResult = data.results[i];
          const gameNum = batch + i + 1;

          const events: GameLogEntry['events'] = gameResult.logs.map((log: any) => ({
            turn: log.turn,
            player: log.player,
            action: `${log.action} — ${log.details}`,
            thought: '',
          }));

          const winner = gameResult.winner as 0 | 1;
          if (winner === 0) deckAWins++;
          else deckBWins++;

          totalTurns += gameResult.turns;

          allResults.push({ game: gameNum, winner, turns: gameResult.turns, events });
        }

        setProgress(Math.round(((batch + gamesThisBatch) / numGames) * 100));
      }

      setResult({
        deckAWins,
        deckBWins,
        totalGames: numGames,
        averageTurns: numGames > 0 ? Math.round((totalTurns / numGames) * 10) / 10 : 0,
        gameLogs: allResults.slice(-100),
      });
    } catch (err) {
      console.error('Battle test failed:', err);
    }

    setRunning(false);
  }, [deckA, deckB, numGames, decks]);

  const handleRerun = () => {
    runTest();
  };

  const winRateA = result ? ((result.deckAWins / result.totalGames) * 100).toFixed(1) : '0';
  const winRateB = result ? ((result.deckBWins / result.totalGames) * 100).toFixed(1) : '0';

  const deckAName = decks.find((d) => d.id === deckA)?.name || 'Deck A';
  const deckBName = decks.find((d) => d.id === deckB)?.name || 'Deck B';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">AI 牌組實驗室</h1>

      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="text-sm text-slate-400 mb-1.5 block">牌組 A</label>
            {decks.length === 0 ? (
              <p className="text-slate-500 text-sm bg-slate-700/50 rounded-lg p-3">無可用牌組</p>
            ) : (
              <select
                value={deckA}
                onChange={(e) => setDeckA(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">選擇牌組...</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.cards.length})</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-1.5 block">牌組 B</label>
            {decks.length === 0 ? (
              <p className="text-slate-500 text-sm bg-slate-700/50 rounded-lg p-3">無可用牌組</p>
            ) : (
              <select
                value={deckB}
                onChange={(e) => setDeckB(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">選擇牌組...</option>
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.cards.length})</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="text-sm text-slate-400 mb-1.5 block">對戰場數</label>
            <select
              value={numGames}
              onChange={(e) => setNumGames(Number(e.target.value))}
              className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-blue-500"
            >
              <option value={10}>10 場</option>
              <option value={100}>100 場</option>
              <option value={1000}>1000 場</option>
            </select>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={runTest}
            disabled={!deckA || !deckB || running}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {running ? '測試中...' : '開始測試'}
          </button>
          {result && (
            <button
              onClick={handleRerun}
              disabled={running}
              className="px-6 py-2.5 bg-slate-700 text-slate-200 rounded-lg font-medium hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              重新測試
            </button>
          )}
        </div>
      </div>

      {running && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-slate-300">測試進度</span>
            <span className="text-sm text-slate-400">{progress}%</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
            <div
              className="bg-blue-600 h-full rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-slate-500 mt-2">正在模擬對戰，請稍候...</p>
        </div>
      )}

      {result && !running && (
        <div className="space-y-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">測試結果</h2>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-slate-700/40 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-green-400">{winRateA}%</p>
                <p className="text-sm text-slate-400 mt-1">{deckAName}</p>
                <p className="text-xs text-slate-500">{result.deckAWins} 勝</p>
              </div>
              <div className="bg-slate-700/40 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-yellow-400">{result.totalGames}</p>
                <p className="text-sm text-slate-400 mt-1">總場次</p>
                <p className="text-xs text-slate-500">平均 {result.averageTurns} 回合</p>
              </div>
              <div className="bg-slate-700/40 rounded-lg p-4 text-center">
                <p className="text-2xl font-bold text-red-400">{winRateB}%</p>
                <p className="text-sm text-slate-400 mt-1">{deckBName}</p>
                <p className="text-xs text-slate-500">{result.deckBWins} 勝</p>
              </div>
            </div>

            <div className="mb-4">
              <h3 className="text-sm font-semibold text-slate-300 mb-3">勝率比較</h3>
              <div className="space-y-2">
                <div>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-green-400">{deckAName}</span>
                    <span className="text-slate-400">{winRateA}%</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                    <div
                      className="bg-green-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${winRateA}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-red-400">{deckBName}</span>
                    <span className="text-slate-400">{winRateB}%</span>
                  </div>
                  <div className="w-full bg-slate-700 rounded-full h-4 overflow-hidden">
                    <div
                      className="bg-red-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${winRateB}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <p className="text-center text-white font-medium">
              {parseFloat(winRateA) > parseFloat(winRateB)
                ? `${deckAName} 勝率 ${winRateA}%，表現較佳`
                : parseFloat(winRateB) > parseFloat(winRateA)
                ? `${deckBName} 勝率 ${winRateB}%，表現較佳`
                : '雙方勢均力敵'}
            </p>
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="flex items-center gap-2 text-sm text-slate-300 hover:text-white transition-colors"
            >
              <span className={`transform transition-transform ${showLogs ? 'rotate-90' : ''}`}>&#9654;</span>
              {showLogs ? '隱藏對戰記錄' : '顯示對戰記錄'}
            </button>

            {showLogs && (
              <div className="mt-4 space-y-3 max-h-96 overflow-y-auto">
                {result.gameLogs.length === 0 ? (
                  <p className="text-slate-500 text-sm">無記錄</p>
                ) : (
                  result.gameLogs.map((log) => (
                    <div key={log.game} className="bg-slate-700/30 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-slate-200">第 {log.game} 場</span>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            log.winner === 0 ? 'bg-green-700 text-green-200' : 'bg-red-700 text-red-200'
                          }`}>
                            {log.winner === 0 ? deckAName : deckBName} 勝
                          </span>
                          <span className="text-xs text-slate-500">{log.turns} 回合</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {log.events.slice(-5).map((event, ei) => (
                          <div key={ei} className="text-xs border-l-2 border-slate-600 pl-2 py-0.5">
                            <span className="text-slate-400">T{event.turn}</span>{' '}
                            <span className={event.player === 0 ? 'text-blue-400' : 'text-red-400'}>
                              {event.player === 0 ? deckAName : deckBName}
                            </span>{' '}
                            <span className="text-slate-200">{event.action}</span>
                            {event.thought && (
                              <p className="text-slate-500 italic mt-0.5">思考: {event.thought}</p>
                            )}
                          </div>
                        ))}
                        {log.events.length > 5 && (
                          <p className="text-xs text-slate-600 pl-2">...及其他 {log.events.length - 5} 個行動</p>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!result && !running && (
        <div className="bg-slate-800/50 border border-dashed border-slate-700 rounded-xl p-12 text-center">
          <div className="text-5xl mb-4">🧪</div>
          <p className="text-slate-500">選擇兩副牌組並開始測試</p>
          <p className="text-slate-600 text-sm mt-1">系統將模擬 AI 對戰並統計結果</p>
        </div>
      )}
    </div>
  );
}
