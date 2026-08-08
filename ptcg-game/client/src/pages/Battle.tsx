import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useDeckStore } from '../stores/deckStore';
import { useCardStore } from '../stores/cardStore';
import { useGameStore, type SanitizedGameCard } from '../stores/gameStore';
import type { Card, LegalAction } from '@ptcg/shared';

/* ====================================================== */
/*  Energy icons                                           */
/* ====================================================== */

const ENERGY_COLORS: Record<string, string> = {
  Grass: 'bg-green-500', Fire: 'bg-red-500', Water: 'bg-blue-500',
  Lightning: 'bg-yellow-400', Psychic: 'bg-purple-500', Fighting: 'bg-orange-600',
  Darkness: 'bg-stone-800', Metal: 'bg-slate-400', Dragon: 'bg-indigo-500',
  Fairy: 'bg-pink-400', Colorless: 'bg-gray-400',
};

const ENERGY_LABELS: Record<string, string> = {
  Grass: '草', Fire: '炎', Water: '水', Lightning: '雷',
  Psychic: '超', Fighting: '闘', Darkness: '悪', Metal: '鋼',
  Dragon: '竜', Fairy: '妖', Colorless: '無',
};

function EnergyIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]';
  return (
    <span className={`inline-flex items-center justify-center rounded-full ${ENERGY_COLORS[type] || 'bg-gray-500'} text-white font-bold ${cls}`}>
      {ENERGY_LABELS[type] || '?'}
    </span>
  );
}

/* ====================================================== */
/*  Card effect preview (hover popover)                    */
/* ====================================================== */

const ABILITY_TYPE_LABELS: Record<string, string> = {
  Ability: '特性', 'Pokémon-Power': '寶可夢力量', 'Poké-Body': '寶可夢身體', 'Poké-Power': '寶可夢力量',
};

function CardDetail({ card }: { card: Card }) {
  const hasWRR = (card.weaknesses?.length || card.resistances?.length || (card.retreatCost?.length ?? 0) > 0);
  return (
    <div className="p-3 w-72">
      <div className="flex gap-3 mb-2">
        <img
          src={card.images.large || card.images.small}
          alt={card.name}
          className="w-20 h-auto rounded-lg object-contain bg-slate-800 flex-shrink-0 border border-slate-700"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-white leading-tight">{card.name}</p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            {card.supertype}{card.subtypes?.length ? ` · ${card.subtypes.join(' / ')}` : ''}
          </p>
          {card.hp && (
            <div className="flex items-center gap-1 mt-1.5">
              <span className="text-xs text-slate-300 font-medium">HP {card.hp}</span>
              {card.types?.map((t, i) => <EnergyIcon key={i} type={t} />)}
            </div>
          )}
        </div>
      </div>

      {card.rules?.map((r, i) => (
        <p key={i} className="text-[11px] text-slate-200 leading-snug mb-1.5">{r}</p>
      ))}

      {card.abilities?.filter(a => a.text).map((a, i) => (
        <div key={i} className="mb-1.5 bg-emerald-950/40 border border-emerald-800/50 rounded-lg px-2 py-1.5">
          <p className="text-[11px] font-semibold text-emerald-400">{ABILITY_TYPE_LABELS[a.type] || a.type}：{a.name}</p>
          <p className="text-[11px] text-slate-300 leading-snug mt-0.5">{a.text}</p>
        </div>
      ))}

      {card.attacks?.map((atk, i) => (
        <div key={i} className="mb-1.5">
          <div className="flex items-center gap-1 flex-wrap">
            {atk.cost.map((c, ci) => <EnergyIcon key={ci} type={c} />)}
            <span className="text-xs font-semibold text-white ml-1">{atk.name}</span>
            {atk.damage && <span className="text-xs text-red-400 ml-auto font-bold">{atk.damage}</span>}
          </div>
          {atk.text && <p className="text-[11px] text-slate-400 leading-snug mt-0.5">{atk.text}</p>}
        </div>
      ))}

      {hasWRR && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400 mt-2 pt-2 border-t border-slate-700">
          {card.weaknesses?.map((w, i) => (
            <span key={i}>弱點 <EnergyIcon type={w.type} />{w.value}</span>
          ))}
          {card.resistances?.map((r, i) => (
            <span key={i}>抵抗 <EnergyIcon type={r.type} />{r.value}</span>
          ))}
          {(card.retreatCost?.length ?? 0) > 0 && (
            <span className="flex items-center gap-1">撤退 {card.retreatCost!.map((_, i) => <EnergyIcon key={i} type="Colorless" />)}</span>
          )}
        </div>
      )}

      {card.flavorText && (
        <p className="text-[10px] text-slate-500 italic leading-snug mt-2 pt-2 border-t border-slate-700">{card.flavorText}</p>
      )}
    </div>
  );
}

function HoverPreview({ card, children, placement = 'above' }: { card: Card; children: ReactNode; placement?: 'above' | 'below' }) {
  const [show, setShow] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={`absolute z-[70] left-1/2 -translate-x-1/2 ${placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'}
            bg-slate-900 border border-slate-600 rounded-xl shadow-2xl pointer-events-none`}
        >
          <CardDetail card={card} />
        </div>
      )}
    </div>
  );
}

/* ====================================================== */
/*  Section header (main-phase action panel)                */
/* ====================================================== */

function SectionHeader({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 mb-1.5 pb-1 border-b border-slate-700/60">
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  );
}

/* ====================================================== */
/*  HP Bar                                                */
/* ====================================================== */

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
      <div className={`h-full ${color} transition-all duration-300`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ====================================================== */
/*  Helper: group legal moves by hand card                */
/* ====================================================== */

interface HandCardAction {
  cardData: Card;
  moves: LegalAction[];
}

function groupMovesByHandCard(legalMoves: LegalAction[], hand: Card[]): HandCardAction[] {
  const result: HandCardAction[] = [];
  for (const hc of hand) {
    const moves = legalMoves.filter(m => {
      if (m.type === 'play_pokemon' || m.type === 'evolve_pokemon' || m.type === 'attach_energy' || m.type === 'play_trainer') {
        return m.payload?.cardId === hc.id;
      }
      return false;
    });
    if (moves.length > 0) {
      result.push({ cardData: hc, moves });
    }
  }
  return result;
}

/* ====================================================== */
/*  Main Battle Component                                 */
/* ====================================================== */

export default function Battle() {
  const { decks } = useDeckStore();
  const { cards, fetchCards } = useCardStore();
  const {
    battleState, loading, error, battlePhase,
    createBattle, submitMove, leaveGame,
  } = useGameStore();

  const [selectedDeckId, setSelectedDeckId] = useState('');
  const [selectedCardInHand, setSelectedCardInHand] = useState<string | null>(null);
  const [showPlayerDiscard, setShowPlayerDiscard] = useState(false);
  const [showOpponentDiscard, setShowOpponentDiscard] = useState(false);
  const [showOpponentHand, setShowOpponentHand] = useState(false);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  // Group legal moves by hand card for the action UI
  const handCardActions = useMemo(() => {
    if (!battleState) return [];
    return groupMovesByHandCard(battleState.legalMoves, battleState.player.hand);
  }, [battleState]);

  // Quick actions: moves that don't need a hand card (plus end_turn)
  const quickActions = useMemo(() => {
    if (!battleState) return [];
    return battleState.legalMoves.filter(m =>
      m.type === 'draw_card' || m.type === 'retreat' || m.type === 'end_turn' || m.type === 'attack'
    );
  }, [battleState]);

  // Play trainer actions (shown separately)
  const trainerActions = useMemo(() => {
    if (!battleState) return [];
    return battleState.legalMoves.filter(m => m.type === 'play_trainer');
  }, [battleState]);

  // Use-ability actions (shown separately) — payload.cardId refers to a Pokémon in play,
  // not a hand card, so groupMovesByHandCard can never surface these.
  const abilityActions = useMemo(() => {
    if (!battleState) return [];
    return battleState.legalMoves.filter(m => m.type === 'use_ability');
  }, [battleState]);

  const handleStartBattle = useCallback(async () => {
    if (!selectedDeckId) return;
    const deck = decks.find(d => d.id === selectedDeckId);
    if (!deck) return;
    try {
      await createBattle(deck.cards);
    } catch { /* handled by store */ }
  }, [selectedDeckId, decks, createBattle]);

  const handleSubmitMove = useCallback((move: LegalAction) => {
    setSelectedCardInHand(null);
    submitMove(move.type, move.payload);
  }, [submitMove]);

  const handleCardClick = useCallback((cardId: string) => {
    setSelectedCardInHand(prev => prev === cardId ? null : cardId);
  }, []);

  const handleRetry = useCallback(() => {
    leaveGame();
  }, [leaveGame]);

  const bs = battleState;
  const phaseLabels: Record<string, string> = {
    draw: '抽牌階段', main: '主要階段', attack: '攻擊階段', end: '結束階段',
  };

  /* ======================== */
  /*  Phase: Select Deck (no server battle active)     */
  /* ======================== */
  if (battlePhase === 'select') {
    return (
      <div className="flex items-center justify-center min-h-[70vh]">
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 w-full max-w-md">
          <h1 className="text-2xl font-bold text-white text-center mb-6">AI 對戰練習</h1>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">選擇你的牌組</label>
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
            <button
              onClick={handleStartBattle}
              disabled={!selectedDeckId || loading}
              className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? '建立對戰中...' : '開始對戰'}
            </button>
            {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  /* ======================== */
  /*  Loading state           */
  /* ======================== */
  if (!bs) {
    return (
      <div className="flex items-center justify-center min-h-[70vh]">
        <div className="flex items-center gap-2 text-slate-400">
          <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
          <span>載入中...</span>
        </div>
      </div>
    );
  }

  /* ======================== */
  /*  Helper sub-components   */
  /* ======================== */

  function PokemonCardView({
    card, size = 'normal', showHp = true, onClick, highlight, selected, previewPlacement = 'above',
  }: {
    card: SanitizedGameCard;
    size?: 'normal' | 'small';
    showHp?: boolean;
    onClick?: () => void;
    highlight?: boolean;
    selected?: boolean;
    previewPlacement?: 'above' | 'below';
  }) {
    const cd = card.cardData;
    const hp = cd.hp ? parseInt(cd.hp) : 0;
    const remainingHp = Math.max(0, hp - card.damage);
    const isW = size === 'small';
    const wCls = isW ? 'w-24' : 'w-32';
    const imgH = isW ? 'h-[4.25rem]' : 'h-[6.5rem]';

    return (
      <div
        className={`flex flex-col items-center gap-0.5 cursor-pointer transition-all
          ${highlight ? 'ring-2 ring-yellow-400 rounded-lg' : ''}
          ${selected ? 'ring-2 ring-blue-400 rounded-lg' : ''}
          ${onClick ? 'hover:-translate-y-1' : ''}`}
        onClick={onClick}
      >
        <HoverPreview card={cd} placement={previewPlacement}>
          <div className={`${wCls} ${imgH} bg-slate-700 border-2 border-slate-600 rounded-lg overflow-hidden hover:border-blue-400 transition-colors`}>
            <img src={cd.images.small} alt={cd.name} className="w-full h-full object-contain" />
          </div>
        </HoverPreview>
        {showHp && hp > 0 && (
          <div className="w-full px-0.5">
            <div className="flex justify-between text-[10px] text-slate-300 mb-0.5">
              <span className="truncate max-w-[60%]">{cd.name}</span>
              <span>{remainingHp}/{hp}</span>
            </div>
            <HpBar current={remainingHp} max={hp} />
          </div>
        )}
        {!showHp && (
          <span className="text-[10px] text-slate-400 truncate max-w-[90%]">{cd.name}</span>
        )}
        {card.attachedEnergy.length > 0 && (
          <div className="flex gap-0.5 flex-wrap justify-center mt-0.5">
            {card.attachedEnergy.map((e, i) => (
              <EnergyIcon key={i} type={e.type} size={isW ? 'sm' : 'sm'} />
            ))}
          </div>
        )}
        {card.damage > 0 && (
          <span className="text-[10px] text-red-400 font-bold">-{card.damage}</span>
        )}
        {card.statusConditions.length > 0 && (
          <span className="text-[10px] text-yellow-400">{card.statusConditions.join(' ')}</span>
        )}
      </div>
    );
  }

  function PrizeDisplay({ count, label }: { count: number; label: string }) {
    return (
      <div className="flex items-center gap-1">
        {label && <span className="text-xs text-slate-400">{label}</span>}
        <div className="flex gap-0.5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={`w-2.5 h-2.5 rounded-full ${i < count ? 'bg-yellow-400' : 'bg-slate-700'}`} />
          ))}
        </div>
      </div>
    );
  }

  /* ======================== */
  /*  Main Battle Layout      */
  /* ======================== */

  const isOver = bs.winner !== null;

  // A multi-step trainer/ability/attack effect (e.g. Ultra Ball) is awaiting a response —
  // every option is already a fully-validated resolve_choice move from the server, so the
  // modal just needs to list them; there's no separate client-side selection logic to get wrong.
  const pendingChoiceMoves = bs.legalMoves.filter(m => m.type === 'resolve_choice');

  return (
    <div className="flex gap-3 h-[calc(100vh-7rem)] min-h-0">

      {/* Pending choice modal: a card effect is mid-resolution and needs an answer before anything else */}
      {!isOver && bs.pendingChoice && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
          <div className="bg-slate-800 border border-blue-500/50 rounded-2xl p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
            <h3 className="text-white font-semibold mb-1">卡牌效果</h3>
            <p className="text-slate-300 text-sm mb-4">{bs.pendingChoice.prompt}</p>
            <div className="flex-1 overflow-y-auto space-y-1.5">
              {pendingChoiceMoves.length === 0 ? (
                <p className="text-slate-500 text-sm">沒有可行的選項……</p>
              ) : (
                pendingChoiceMoves.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => handleSubmitMove(m)}
                    disabled={loading}
                    className="w-full text-left px-3 py-2 bg-slate-700 hover:bg-blue-700 disabled:opacity-40 text-slate-100 rounded-lg text-sm transition-colors"
                  >
                    {m.description}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Selected hand-card modal: full effect preview + action buttons, floats above the
          layout entirely so it never pushes the main-phase panel taller and forces scrolling. */}
      {!isOver && selectedCardInHand && (() => {
        const hca = handCardActions.find(h => h.cardData.id === selectedCardInHand);
        if (!hca) return null;
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
            onClick={() => setSelectedCardInHand(null)}
          >
            <div
              className="bg-slate-900 border border-blue-500/50 rounded-2xl w-full max-w-xs mx-4 max-h-[85vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <CardDetail card={hca.cardData} />
              <div className="flex flex-col gap-1.5 p-3 pt-0">
                {hca.moves.map((m, mi) => (
                  <button
                    key={mi}
                    onClick={() => handleSubmitMove(m)}
                    className="w-full px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition-colors"
                  >
                    {m.description.replace(/^(Play|Attach|Evolve) /, '')}
                  </button>
                ))}
                <button
                  onClick={() => setSelectedCardInHand(null)}
                  className="w-full px-3 py-1.5 text-slate-400 text-xs hover:text-slate-200 transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Left column: battlefield */}
      <div className="flex-1 flex flex-col min-h-0 gap-2">

        {/* Opponent area */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-red-400">對手</span>
              <PrizeDisplay count={bs.opponent.prizes} label="" />
              <button
                onClick={() => setShowOpponentHand(true)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                手牌 ({bs.opponent.handCount})
              </button>
              <button
                onClick={() => setShowOpponentDiscard(true)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                棄牌 ({bs.opponent.discardCount})
              </button>
              <span className="text-xs text-slate-600">牌庫 {bs.opponent.deckCount}</span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-3">
            {bs.opponent.active ? (
              <PokemonCardView card={bs.opponent.active} size="normal" showHp={true} previewPlacement="below" />
            ) : (
              <div className="w-32 h-[6.5rem] bg-slate-700/50 border-2 border-dashed border-slate-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <span className="text-slate-600 text-xs">無寶可夢</span>
              </div>
            )}
            <div className="w-px self-stretch bg-slate-700/70 flex-shrink-0" />
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, i) => {
                const c = bs.opponent.bench[i];
                return c ? (
                  <PokemonCardView key={c.id} card={c} size="small" showHp={false} previewPlacement="below" />
                ) : (
                  <div key={i} className="w-24 h-[4.25rem] bg-slate-700/30 border border-dashed border-slate-600 rounded-md flex items-center justify-center">
                    <span className="text-slate-600 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Middle: Actions / Turn info */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-3 flex-1 min-h-0 flex flex-col">

          {/* Turn info bar */}
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-700/60">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${bs.isPlayerTurn ? 'bg-green-900/60 text-green-300 border border-green-700/60' : 'bg-red-900/60 text-red-300 border border-red-700/60'}`}>
                {bs.isPlayerTurn ? '你的回合' : '對手回合'}
              </span>
              <span className="text-xs text-slate-400">回合 {bs.turn}</span>
              <span className="px-1.5 py-0.5 rounded bg-slate-700 text-[11px] text-slate-300 font-medium">
                {phaseLabels[bs.phase] || bs.phase}
              </span>
            </div>
            <span className="text-[11px] text-slate-500">
              牌庫 {bs.player.deckCount} · 棄牌 {bs.player.discardPile.length}
            </span>
          </div>

          {/* Error display */}
          {error && (
            <div className="mb-2 p-2 bg-red-900/50 border border-red-700 rounded text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Game over */}
          {isOver && (
            <div className="flex-1 flex flex-col items-center justify-center">
              <p className="text-2xl font-bold text-yellow-400 mb-2">
                {bs.winner === 0 ? '你贏了！' : '你輸了！'}
              </p>
              <p className="text-sm text-slate-400 mb-4">{bs.winReason}</p>
              <button
                onClick={handleRetry}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                返回大廳
              </button>
            </div>
          )}

          {/* Waiting for AI */}
          {!isOver && !bs.isPlayerTurn && (
            <div className="flex-1 flex items-center justify-center gap-2 text-slate-400">
              <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
              AI 思考中...
            </div>
          )}

          {/* Player actions */}
          {!isOver && bs.isPlayerTurn && (
            <div className="flex-1 overflow-y-auto min-h-0">

              {/* Draw phase */}
              {bs.phase === 'draw' && (
                <div className="flex items-center justify-center h-full">
                  <button
                    onClick={() => {
                      const drawMove = quickActions.find(m => m.type === 'draw_card');
                      if (drawMove) handleSubmitMove(drawMove);
                    }}
                    className="px-8 py-4 bg-blue-600 text-white rounded-xl text-lg font-medium hover:bg-blue-700 transition-colors"
                  >
                    抽牌
                  </button>
                </div>
              )}

              {/* Main / Attack phase */}
              {(bs.phase === 'main' || bs.phase === 'attack') && (
                <div className="space-y-2">

                  {/* Quick actions section */}
                  <section>
                    <SectionHeader icon="⚡" label="快捷行動" />
                    <div className="flex flex-wrap gap-1.5">
                      {quickActions.filter(m => m.type === 'attack').map((m, i) => {
                        const atkIdx = m.payload?.attackIndex as number;
                        const atk = bs.player.active?.cardData.attacks?.[atkIdx];
                        const btn = (
                          <button
                            key={i}
                            onClick={() => handleSubmitMove(m)}
                            className="px-3 py-1.5 bg-red-700 text-white rounded-lg text-xs font-medium hover:bg-red-600 transition-colors flex items-center gap-1"
                          >
                            <span>⚔</span>
                            {atk?.cost.map((c, ci) => <EnergyIcon key={ci} type={c} />)}
                            <span>{atk?.name || m.description}</span>
                            {atk?.damage && <span className="text-red-200 font-bold">{atk.damage}</span>}
                          </button>
                        );
                        return atk && bs.player.active ? (
                          <HoverPreview key={i} card={bs.player.active.cardData} placement="above">{btn}</HoverPreview>
                        ) : btn;
                      })}
                      {quickActions.filter(m => m.type === 'retreat').map((m, i) => (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          className="px-3 py-1.5 bg-orange-600 text-white rounded-lg text-xs font-medium hover:bg-orange-500 transition-colors"
                        >
                          ↩ {m.description}
                        </button>
                      ))}
                      {quickActions.filter(m => m.type === 'end_turn').map((m, i) => (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          className="px-3 py-1.5 bg-slate-600 text-white rounded-lg text-xs font-medium hover:bg-slate-500 transition-colors ml-auto"
                        >
                          結束回合 →
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Hand card actions */}
                  {handCardActions.length > 0 && (
                    <section>
                      <SectionHeader icon="🎴" label="手牌（點擊卡片選擇動作，滑鼠移入可預覽效果）" />
                      <div className="flex flex-wrap gap-2">
                        {handCardActions.map((hca, idx) => {
                          const isSelected = selectedCardInHand === hca.cardData.id;
                          return (
                            <div key={idx} className="flex flex-col items-center">
                              <HoverPreview card={hca.cardData} placement="above">
                                <img
                                  src={hca.cardData.images.small}
                                  alt={hca.cardData.name}
                                  className={`w-14 h-[4.5rem] rounded-lg cursor-pointer transition-all object-contain border-2
                                    ${isSelected ? 'border-blue-400 -translate-y-1 shadow-lg shadow-blue-500/30' : 'border-slate-600 hover:border-slate-400'}`}
                                  onClick={() => handleCardClick(hca.cardData.id)}
                                />
                              </HoverPreview>
                              <span className="text-[10px] text-slate-400 mt-0.5 truncate max-w-16 text-center">
                                {hca.cardData.name}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {/* Trainer card actions (separate row) */}
                  {trainerActions.length > 0 && handCardActions.length === 0 && (
                    <section>
                      <SectionHeader icon="🧰" label="訓練家卡（點擊使用）" />
                      <div className="flex flex-wrap gap-2">
                        {trainerActions.map((m, i) => {
                          const cardData = bs.player.hand.find(c => c.id === m.payload?.cardId);
                          const btn = (
                            <button
                              onClick={() => handleSubmitMove(m)}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-700 text-white rounded-lg text-xs font-medium hover:bg-indigo-600 transition-colors"
                            >
                              {cardData && <img src={cardData.images.small} alt="" className="w-5 h-7 object-contain rounded-sm" />}
                              {m.description}
                            </button>
                          );
                          return cardData ? <HoverPreview key={i} card={cardData} placement="above">{btn}</HoverPreview> : <div key={i}>{btn}</div>;
                        })}
                      </div>
                    </section>
                  )}

                  {/* Ability actions (separate row) */}
                  {abilityActions.length > 0 && (
                    <section>
                      <SectionHeader icon="✨" label="特性（點擊使用）" />
                      <div className="flex flex-wrap gap-2">
                        {abilityActions.map((m, i) => {
                          const cardId = m.payload?.cardId as string | undefined;
                          const cardData = [bs.player.active, ...bs.player.bench].find(c => c?.id === cardId)?.cardData;
                          const btn = (
                            <button
                              onClick={() => handleSubmitMove(m)}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-700 text-white rounded-lg text-xs font-medium hover:bg-emerald-600 transition-colors"
                            >
                              {cardData && <img src={cardData.images.small} alt="" className="w-5 h-7 object-contain rounded-sm" />}
                              {m.description}
                            </button>
                          );
                          return cardData ? <HoverPreview key={i} card={cardData} placement="above">{btn}</HoverPreview> : <div key={i}>{btn}</div>;
                        })}
                      </div>
                    </section>
                  )}

                  {/* No legal moves indicator */}
                  {battleState.legalMoves.filter(m => m.type !== 'forfeit').length === 0 && (
                    <p className="text-slate-500 text-xs text-center py-8">沒有可行的行動</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Player area */}
        <div className="bg-slate-800/80 border border-slate-700 rounded-xl p-2 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-blue-400">你</span>
              <PrizeDisplay count={bs.player.prizes} label="" />
              <button
                onClick={() => setShowPlayerDiscard(true)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                棄牌 ({bs.player.discardPile.length})
              </button>
              <span className="text-xs text-slate-600">牌庫 {bs.player.deckCount}</span>
            </div>
            <span className="text-xs text-slate-500">手牌 {bs.player.hand.length}</span>
          </div>

          <div className="flex items-center justify-center gap-3 mb-1">
            {bs.player.active ? (
              <PokemonCardView card={bs.player.active} size="normal" showHp={true} />
            ) : (
              <div className="w-32 h-[6.5rem] bg-slate-700/50 border-2 border-dashed border-slate-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <span className="text-slate-600 text-xs">無寶可夢</span>
              </div>
            )}
            <div className="w-px self-stretch bg-slate-700/70 flex-shrink-0" />
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, i) => {
                const c = bs.player.bench[i];
                return c ? (
                  <PokemonCardView key={c.id} card={c} size="small" showHp={false} />
                ) : (
                  <div key={i} className="w-24 h-[4.25rem] bg-slate-700/30 border border-dashed border-slate-600 rounded-md flex items-center justify-center">
                    <span className="text-slate-600 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Player hand row */}
          <div className="flex justify-center gap-1.5 overflow-x-auto pb-1">
            {bs.player.hand.length === 0 ? (
              <div className="text-slate-600 text-xs py-2">手牌為空</div>
            ) : (
              bs.player.hand.map((card, i) => {
                const isSelected = selectedCardInHand === card.id;
                return (
                  <HoverPreview key={i} card={card} placement="above">
                    <div
                      className={`flex-shrink-0 w-14 h-20 bg-slate-700 border-2 rounded-md overflow-hidden
                        ${isSelected ? 'border-blue-400 -translate-y-2' : 'border-slate-600 hover:border-slate-400'}
                        transition-all cursor-pointer shadow-lg`}
                      onClick={() => handleCardClick(card.id)}
                    >
                      <img src={card.images.small} alt={card.name} className="w-full h-full object-contain" />
                    </div>
                  </HoverPreview>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Right column: Turn log */}
      <div className="w-64 flex-shrink-0 bg-slate-800 border border-slate-700 rounded-xl p-3 flex flex-col min-h-0">
        <h3 className="text-sm font-semibold text-slate-300 mb-3">對戰紀錄</h3>
        <div className="flex-1 overflow-y-auto space-y-1">
          {bs.turnLog.length === 0 ? (
            <p className="text-slate-600 text-xs">尚無紀錄</p>
          ) : (
            [...bs.turnLog].reverse().slice(0, 100).map((entry, i) => (
              <div key={i} className="text-xs border-l-2 border-slate-700 pl-2 py-0.5">
                <span className={`font-medium ${entry.player === 0 ? 'text-blue-400' : 'text-red-400'}`}>
                  [{entry.turn}]
                </span>{' '}
                <span className="text-slate-200">{entry.action}</span>
                {entry.details && <p className="text-slate-500 mt-0.5">{entry.details}</p>}
              </div>
            ))
          )}
        </div>
        <div className="mt-2 pt-2 border-t border-slate-700">
          <button
            onClick={leaveGame}
            className="w-full py-1.5 bg-slate-700 text-slate-300 rounded-lg text-xs hover:bg-slate-600 transition-colors"
          >
            離開對戰
          </button>
        </div>
      </div>

      {/* Player discard modal */}
      {showPlayerDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowPlayerDiscard(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">你的棄牌堆</h3>
              <button onClick={() => setShowPlayerDiscard(false)} className="text-slate-400 hover:text-white text-xl">&times;</button>
            </div>
            {bs.player.discardPile.length === 0 ? (
              <p className="text-slate-500 text-sm">暫無棄牌</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {bs.player.discardPile.map((c, i) => (
                  <HoverPreview key={i} card={c.cardData} placement="above">
                    <img src={c.cardData.images.small} alt={c.cardData.name}
                      className="w-16 h-[4.5rem] rounded object-contain bg-slate-700 hover:ring-2 hover:ring-blue-400 transition-all" />
                  </HoverPreview>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Opponent discard modal */}
      {showOpponentDiscard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowOpponentDiscard(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">對手棄牌堆</h3>
              <button onClick={() => setShowOpponentDiscard(false)} className="text-slate-400 hover:text-white text-xl">&times;</button>
            </div>
            <p className="text-slate-500 text-sm">對手棄牌堆（{bs.opponent.discardCount} 張）</p>
          </div>
        </div>
      )}

      {/* Opponent hand modal */}
      {showOpponentHand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowOpponentHand(false)}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">對手手牌</h3>
              <button onClick={() => setShowOpponentHand(false)} className="text-slate-400 hover:text-white text-xl">&times;</button>
            </div>
            <p className="text-slate-500 text-sm">對手有 {bs.opponent.handCount} 張手牌</p>
          </div>
        </div>
      )}
    </div>
  );
}
