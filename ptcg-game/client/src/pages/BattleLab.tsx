import { useState, useEffect, useCallback } from 'react';
import { useDeckStore } from '../stores/deckStore';
import Modal from '../components/Modal';
import StatBox from '../components/StatBox';
import Badge from '../components/Badge';

interface TestResult {
  deckAWins: number;
  deckBWins: number;
  /** Games that hit the engine's move cap without resolving. The server used to hand these to
   * deck A, which tilted every win rate shown here towards whichever deck sat in seat A. */
  draws: number;
  totalGames: number;
  averageTurns: number;
  gameLogs: GameLogEntry[];
}

interface GameLogEntry {
  game: number;
  winner: 0 | 1 | null;
  turns: number;
  events: { turn: number; player: number; action: string; thought?: string }[];
}

const AI_OPTIONS = [
  { value: 'random', label: '隨機（RandomAI）' },
  { value: 'mock', label: '舊版優先序（MockAI）' },
  { value: 'heuristic', label: '規則式（HeuristicAI）' },
];

function Icon({ children, className = 'w-4 h-4' }: { children: React.ReactNode; className?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>{children}</svg>;
}
const IconTrophy = (p: { className?: string }) => <Icon {...p}><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4Z" /><path d="M7 5H4a1 1 0 0 0-1 1v1a4 4 0 0 0 4 4M17 5h3a1 1 0 0 1 1 1v1a4 4 0 0 1-4 4" /></Icon>;
const IconFlask = (p: { className?: string }) => <Icon {...p}><path d="M9 3h6M10 3v6l-5.5 9a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3" /><path d="M7.5 14h9" /></Icon>;
const IconSwords = (p: { className?: string }) => <Icon {...p}><path d="m14.5 3 6.5 6.5-9 9-4-4-2 2 1 3-3-1-2-6 2-2 9-9Z" /></Icon>;

export default function BattleLab() {
  const { decks } = useDeckStore();

  const [deckA, setDeckA] = useState('');
  const [deckB, setDeckB] = useState('');
  const [aiTypeA, setAiTypeA] = useState('random');
  const [aiTypeB, setAiTypeB] = useState('heuristic');
  const [hardModeAvailable, setHardModeAvailable] = useState(false);
  const [numGames, setNumGames] = useState(100);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TestResult | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [detailGame, setDetailGame] = useState<GameLogEntry | null>(null);

  useEffect(() => {
    fetch('/api/ai').then(r => r.json()).then(d => setHardModeAvailable(!!d.hard)).catch(() => {});
  }, []);

  const involvesClaude = aiTypeA === 'claude' || aiTypeB === 'claude';
  const effectiveNumGames = involvesClaude ? Math.min(numGames, 3) : numGames;

  const runTest = useCallback(async () => {
    if (!deckA || !deckB) return;

    setRunning(true);
    setProgress(0);
    setResult(null);

    try {
      const deckACards = decks.find(d => d.id === deckA)?.cards || [];
      const deckBCards = decks.find(d => d.id === deckB)?.cards || [];
      const numGames = effectiveNumGames;

      const batchSize = Math.min(numGames, involvesClaude ? 3 : 10);
      let allResults: { game: number; winner: 0 | 1 | null; turns: number; events: GameLogEntry['events'] }[] = [];
      let deckAWins = 0;
      let deckBWins = 0;
      let draws = 0;
      let totalTurns = 0;

      for (let batch = 0; batch < numGames; batch += batchSize) {
        const gamesThisBatch = Math.min(batchSize, numGames - batch);

        const res = await fetch('/api/battles/ai-vs-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deckA: deckACards, deckB: deckBCards, games: gamesThisBatch, aiTypeA, aiTypeB }),
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

          const winner = gameResult.winner as 0 | 1 | null;
          if (winner === null) draws++;
          else if (winner === 0) deckAWins++;
          else deckBWins++;

          totalTurns += gameResult.turns;

          allResults.push({ game: gameNum, winner, turns: gameResult.turns, events });
        }

        setProgress(Math.round(((batch + gamesThisBatch) / numGames) * 100));
      }

      setResult({
        deckAWins,
        deckBWins,
        draws,
        totalGames: numGames,
        averageTurns: numGames > 0 ? Math.round((totalTurns / numGames) * 10) / 10 : 0,
        gameLogs: allResults.slice(-100),
      });
    } catch (err) {
      console.error('Battle test failed:', err);
    }

    setRunning(false);
  }, [deckA, deckB, effectiveNumGames, involvesClaude, aiTypeA, aiTypeB, decks]);

  const handleRerun = () => {
    runTest();
  };

  const winRateA = result ? ((result.deckAWins / result.totalGames) * 100).toFixed(1) : '0';
  const winRateB = result ? ((result.deckBWins / result.totalGames) * 100).toFixed(1) : '0';

  const deckAName = decks.find((d) => d.id === deckA)?.name || 'Deck A';
  const deckBName = decks.find((d) => d.id === deckB)?.name || 'Deck B';
  const aiLabel: Record<string, string> = { random: 'RandomAI', mock: 'MockAI', heuristic: 'HeuristicAI', claude: 'ClaudeAI' };
  const aWinning = result && parseFloat(winRateA) > parseFloat(winRateB);
  const bWinning = result && parseFloat(winRateB) > parseFloat(winRateA);

  function SideConfig({ side, deck, setDeck, aiType, setAiType }: {
    side: 'A' | 'B'; deck: string; setDeck: (v: string) => void; aiType: string; setAiType: (v: string) => void;
  }) {
    const accent = side === 'A' ? 'border-emerald-700/60 bg-emerald-950/30' : 'border-red-800/60 bg-red-950/20';
    return (
      <div className={`rounded-xl border p-4 ${accent}`}>
        <p className={`text-xs font-bold mb-3 tracking-wide ${side === 'A' ? 'text-emerald-400' : 'text-red-400'}`}>陣營 {side}</p>
        {decks.length === 0 ? (
          <p className="text-slate-500 text-sm bg-black/20 rounded-lg p-3">無可用牌組</p>
        ) : (
          <select
            value={deck}
            onChange={(e) => setDeck(e.target.value)}
            className="w-full bg-black/30 border border-emerald-900/50 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-emerald-500 mb-2"
          >
            <option value="">選擇牌組...</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>{d.name} ({d.cards.length})</option>
            ))}
          </select>
        )}
        <select
          value={aiType}
          onChange={(e) => setAiType(e.target.value)}
          className="w-full bg-black/30 border border-emerald-900/50 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-emerald-500"
        >
          {AI_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          <option value="claude" disabled={!hardModeAvailable}>
            Claude{hardModeAvailable ? '' : '（未設定金鑰，暫不可用）'}
          </option>
        </select>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <IconFlask className="w-6 h-6 text-emerald-400" />
        <h1 className="text-2xl font-bold text-white">AI 牌組實驗室</h1>
      </div>
      <p className="text-sm text-emerald-500/70 -mt-4">選兩個「牌組 + AI 策略」陣營互相模擬對戰，統計勝率</p>

      <div className="bg-[radial-gradient(ellipse_at_top,theme(colors.battle.felt.from)_0%,theme(colors.battle.felt.via)_60%,theme(colors.battle.felt.to)_100%)] border border-emerald-900/50 rounded-2xl p-6 shadow-xl">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-stretch mb-4">
          <SideConfig side="A" deck={deckA} setDeck={setDeckA} aiType={aiTypeA} setAiType={setAiTypeA} />
          <div className="flex items-center justify-center text-emerald-600/60 font-black text-lg">VS</div>
          <SideConfig side="B" deck={deckB} setDeck={setDeckB} aiType={aiTypeB} setAiType={setAiTypeB} />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end gap-4 mb-4">
          <div className="flex-1">
            <label className="text-sm text-emerald-500/70 mb-1.5 block">對戰場數</label>
            <select
              value={numGames}
              onChange={(e) => setNumGames(Number(e.target.value))}
              className="w-full bg-black/30 border border-emerald-900/50 rounded-lg px-3 py-2.5 text-slate-100 focus:outline-none focus:border-emerald-500"
            >
              <option value={10}>10 場</option>
              <option value={100} disabled={involvesClaude}>100 場</option>
              <option value={1000} disabled={involvesClaude}>1000 場</option>
            </select>
            {involvesClaude && (
              <p className="text-[11px] text-amber-400 mt-1">Claude 每步都要付費，此次最多只跑 {effectiveNumGames} 場</p>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={runTest}
              disabled={!deckA || !deckB || running}
              className="px-6 py-2.5 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-lg font-medium hover:from-emerald-400 hover:to-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-lg shadow-emerald-950/50"
            >
              {running ? '測試中...' : '開始測試'}
            </button>
            {result && (
              <button
                onClick={handleRerun}
                disabled={running}
                className="px-6 py-2.5 bg-black/30 border border-emerald-900/50 text-emerald-200 rounded-lg font-medium hover:bg-black/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重新測試
              </button>
            )}
          </div>
        </div>

        {running && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-emerald-200 flex items-center gap-1.5"><IconSwords className="w-3.5 h-3.5" />模擬對戰中...</span>
              <span className="text-sm text-emerald-400/80">{progress}%</span>
            </div>
            <div className="w-full bg-black/40 rounded-full h-3 overflow-hidden border border-emerald-900/40">
              <div
                className="bg-gradient-to-r from-emerald-500 to-emerald-300 h-full rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {result && !running && (
        <div className="space-y-4">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">測試結果</h2>

            <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center mb-6">
              <div className="text-center">
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  {aWinning && <IconTrophy className="w-5 h-5 text-yellow-400" />}
                  <p className="text-3xl font-bold text-emerald-400">{winRateA}%</p>
                </div>
                <p className="text-sm text-slate-300 truncate">{deckAName}</p>
                <Badge label={aiLabel[aiTypeA] || aiTypeA} className="bg-emerald-900/40 border-emerald-700/50 text-emerald-300 mt-1" />
                <p className="text-xs text-slate-500 mt-1">{result.deckAWins} 勝</p>
              </div>
              <div className="flex flex-col items-center gap-1">
                <StatBox value={result.totalGames} label="總場次" colorClassName="bg-black/30 border-slate-600 text-slate-100" />
                <p className="text-[11px] text-slate-500">平均 {result.averageTurns} 回合</p>
                {result.draws > 0 && (
                  <p className="text-[11px] text-amber-400">{result.draws} 場未分勝負</p>
                )}
              </div>
              <div className="text-center">
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <p className="text-3xl font-bold text-red-400">{winRateB}%</p>
                  {bWinning && <IconTrophy className="w-5 h-5 text-yellow-400" />}
                </div>
                <p className="text-sm text-slate-300 truncate">{deckBName}</p>
                <Badge label={aiLabel[aiTypeB] || aiTypeB} className="bg-red-950/40 border-red-800/50 text-red-300 mt-1" />
                <p className="text-xs text-slate-500 mt-1">{result.deckBWins} 勝</p>
              </div>
            </div>

            <div className="mb-4">
              <h3 className="text-sm font-semibold text-slate-300 mb-2">勝率比較</h3>
              <div className="w-full bg-slate-700 rounded-full h-5 overflow-hidden flex">
                <div
                  className="bg-gradient-to-r from-emerald-600 to-emerald-400 h-full flex items-center justify-start pl-2 transition-all duration-500"
                  style={{ width: `${winRateA}%` }}
                >
                  {parseFloat(winRateA) > 12 && <span className="text-[10px] font-bold text-emerald-950">{winRateA}%</span>}
                </div>
                <div
                  className="bg-gradient-to-r from-red-500 to-red-600 h-full flex items-center justify-end pr-2 transition-all duration-500"
                  style={{ width: `${winRateB}%` }}
                >
                  {parseFloat(winRateB) > 12 && <span className="text-[10px] font-bold text-red-950">{winRateB}%</span>}
                </div>
              </div>
            </div>

            <p className="text-center text-white font-medium">
              {aWinning
                ? `${deckAName}（${aiLabel[aiTypeA] || aiTypeA}）勝率 ${winRateA}%，表現較佳`
                : bWinning
                ? `${deckBName}（${aiLabel[aiTypeB] || aiTypeB}）勝率 ${winRateB}%，表現較佳`
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
              <div className="mt-4 space-y-2 max-h-96 overflow-y-auto">
                {result.gameLogs.length === 0 ? (
                  <p className="text-slate-500 text-sm">無記錄</p>
                ) : (
                  result.gameLogs.map((log) => (
                    <button
                      key={log.game}
                      onClick={() => setDetailGame(log)}
                      className="w-full text-left bg-slate-700/30 hover:bg-slate-700/60 rounded-lg p-3 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-200">第 {log.game} 場</span>
                        <div className="flex items-center gap-2">
                          <Badge
                            label={log.winner === null ? '未分勝負' : `${log.winner === 0 ? deckAName : deckBName} 勝`}
                            className={log.winner === null ? 'bg-amber-900/50 border-amber-700/50 text-amber-300' : log.winner === 0 ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300' : 'bg-red-900/50 border-red-700/50 text-red-300'}
                          />
                          <span className="text-xs text-slate-500">{log.turns} 回合 · {log.events.length} 個行動</span>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!result && !running && (
        <div className="bg-slate-800/50 border border-dashed border-slate-700 rounded-xl p-12 text-center">
          <IconFlask className="w-10 h-10 mx-auto mb-4 text-slate-600" />
          <p className="text-slate-500">選擇兩個陣營並開始測試</p>
          <p className="text-slate-600 text-sm mt-1">系統將模擬 AI 對戰並統計結果</p>
        </div>
      )}

      {detailGame && (
        <Modal
          onClose={() => setDetailGame(null)}
          title={<><IconSwords className="w-4 h-4" />第 {detailGame.game} 場對戰紀錄</>}
          maxWidthClassName="max-w-xl"
        >
          <div className="flex items-center gap-2 mb-3">
            <Badge
              label={detailGame.winner === null ? '未分勝負' : `${detailGame.winner === 0 ? deckAName : deckBName} 勝`}
              className={detailGame.winner === null ? 'bg-amber-900/50 border-amber-700/50 text-amber-300' : detailGame.winner === 0 ? 'bg-emerald-900/50 border-emerald-700/50 text-emerald-300' : 'bg-red-900/50 border-red-700/50 text-red-300'}
            />
            <span className="text-xs text-emerald-500/70">{detailGame.turns} 回合</span>
          </div>
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {detailGame.events.map((event, ei) => (
              <div key={ei} className="text-xs border-l-2 border-emerald-900/50 pl-2 py-0.5">
                <span className="text-emerald-600/70">T{event.turn}</span>{' '}
                <span className={event.player === 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {event.player === 0 ? deckAName : deckBName}
                </span>{' '}
                <span className="text-slate-200">{event.action}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
