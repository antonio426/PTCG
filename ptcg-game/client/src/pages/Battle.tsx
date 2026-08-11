import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type KeyboardEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDeckStore } from '../stores/deckStore';
import { useCardStore } from '../stores/cardStore';
import { useGameStore, type SanitizedGameCard } from '../stores/gameStore';
import type { Card, LegalAction, PendingChoice } from '@ptcg/shared';

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
/*  Card art fallback — some cards in the dataset have no artwork hosted   */
/*  on TCGdex at all (confirmed live: the CDN 404s for both size variants  */
/*  and the card's own detail response has no `image` field), not a URL-  */
/*  construction bug on our side. Swap to a placeholder instead of        */
/*  leaving the browser's broken-image icon on screen.                    */
/* ====================================================== */

const CARD_IMAGE_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">' +
  '<rect width="100" height="140" rx="8" fill="#1e293b"/>' +
  '<rect x="4" y="4" width="92" height="132" rx="6" fill="none" stroke="#475569" stroke-width="2" stroke-dasharray="5 5"/>' +
  '<text x="50" y="80" font-size="40" fill="#64748b" text-anchor="middle" font-family="sans-serif">?</text>' +
  '</svg>'
);

function handleCardImgError(e: SyntheticEvent<HTMLImageElement>) {
  const img = e.currentTarget;
  img.onerror = null; // avoid a loop if the fallback data URI itself somehow fails to render
  img.src = CARD_IMAGE_FALLBACK;
}

/* ====================================================== */
/*  Structural icons — plain SVG rather than emoji: emoji render          */
/*  inconsistently across platforms/fonts and can't be sized, stroked, or */
/*  themed like the rest of the UI. Emoji stay only where they're a       */
/*  one-off decorative payoff (win/loss screen), never as a repeated      */
/*  structural/navigational glyph.                                       */
/* ====================================================== */

function Icon({ children, className = 'w-3.5 h-3.5' }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}

const IconBolt = (p: { className?: string }) => <Icon {...p}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></Icon>;
const IconCards = (p: { className?: string }) => <Icon {...p}><rect x="3" y="7" width="14" height="14" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></Icon>;
const IconWrench = (p: { className?: string }) => <Icon {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8Z" /></Icon>;
const IconSparkle = (p: { className?: string }) => <Icon {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l1.8 1.8M15.7 15.7l1.8 1.8M17.5 6.5l-1.8 1.8M8.3 15.7l-1.8 1.8" /></Icon>;
const IconScroll = (p: { className?: string }) => <Icon {...p}><path d="M8 3h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8" /><path d="M8 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2" /><path d="M8 8h7M8 12h7M8 16h4" /></Icon>;
const IconSword = (p: { className?: string }) => <Icon {...p}><path d="m14.5 3 6.5 6.5-9 9-4-4-2 2 1 3-3-1-2-6 2-2 9-9Z" /></Icon>;
const IconUndo = (p: { className?: string }) => <Icon {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v1" /></Icon>;
const IconArrowLeft = (p: { className?: string }) => <Icon {...p}><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></Icon>;
const IconBuilding = (p: { className?: string }) => <Icon {...p}><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 21v-4h6v4M9 8h.01M15 8h.01M9 12h.01M15 12h.01" /></Icon>;
const IconTrash = (p: { className?: string }) => <Icon {...p}><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" /></Icon>;
const IconX = (p: { className?: string }) => <Icon {...p}><path d="m18 6-12 12M6 6l12 12" /></Icon>;
const IconMoon = (p: { className?: string }) => <Icon {...p}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" /></Icon>;
const IconSwirl = (p: { className?: string }) => <Icon {...p}><path d="M12 12a4 4 0 1 1 4-4 6 6 0 0 1-6 6 8 8 0 1 0 8-8" /></Icon>;
const IconDroplet = (p: { className?: string }) => <Icon {...p}><path d="M12 3s6 7 6 11.5a6 6 0 1 1-12 0C6 10 12 3 12 3Z" /></Icon>;
const IconFlame = (p: { className?: string }) => <Icon {...p}><path d="M12 22c4 0 6-2.5 6-6 0-3-2-5-3-7-.3 2-1.5 3-2.5 2 .5-2.5-1-4.5-2.5-6C10.5 8 6 10 6 14.5 6 18.5 8 22 12 22Z" /></Icon>;

/* ====================================================== */
/*  Status conditions                                      */
/* ====================================================== */

const STATUS_CONDITION_STYLE: Record<string, { label: string; icon: (p: { className?: string }) => ReactNode; cls: string }> = {
  Asleep: { label: '睡眠', icon: IconMoon, cls: 'bg-indigo-900/60 border-indigo-600/60 text-indigo-200' },
  Paralyzed: { label: '麻痺', icon: IconBolt, cls: 'bg-yellow-900/60 border-yellow-600/60 text-yellow-200' },
  Confused: { label: '混亂', icon: IconSwirl, cls: 'bg-fuchsia-900/60 border-fuchsia-600/60 text-fuchsia-200' },
  Poisoned: { label: '中毒', icon: IconDroplet, cls: 'bg-purple-900/60 border-purple-600/60 text-purple-200' },
  Burned: { label: '灼傷', icon: IconFlame, cls: 'bg-orange-900/60 border-orange-600/60 text-orange-200' },
};

function StatusConditionBadges({ conditions }: { conditions: string[] }) {
  if (conditions.length === 0) return null;
  return (
    <div className="flex gap-1 flex-wrap justify-center">
      {conditions.map((c, i) => {
        const style = STATUS_CONDITION_STYLE[c];
        const IconComp = style?.icon ?? IconSparkle;
        return (
          <span key={i} className={`flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-medium ${style?.cls ?? 'bg-yellow-900/50 border-yellow-700/50 text-yellow-300'}`}>
            <IconComp className="w-2.5 h-2.5" />
            {style?.label ?? c}
          </span>
        );
      })}
    </div>
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
          onError={handleCardImgError}
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

// Popovers are portaled to <body> and positioned with `fixed` + measured coordinates
// rather than `absolute` inside the trigger — the battlefield has several
// overflow-hidden/overflow-y-auto ancestors (felt board corners, scrollable action
// panel) that would otherwise clip an absolutely-positioned popover before it's visible.
const PREVIEW_WIDTH = 288; // matches CardDetail's w-72

function HoverPreview({ card, children, placement = 'above' }: { card: Card; children: ReactNode; placement?: 'above' | 'below' }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const wantsAbove = placement === 'above';
    // Flip if there isn't roughly enough room on the preferred side.
    const flipped = wantsAbove ? rect.top < 260 : rect.bottom > window.innerHeight - 260;
    const above = wantsAbove ? !flipped : flipped;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, PREVIEW_WIDTH / 2 + 8),
      window.innerWidth - PREVIEW_WIDTH / 2 - 8
    );
    const top = above ? rect.top - 8 : rect.bottom + 8;
    setPos({ left, top, flipped: above });
  }, [placement]);

  useEffect(() => {
    if (!show) return;
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener('scroll', handle, true);
    window.addEventListener('resize', handle);
    return () => {
      window.removeEventListener('scroll', handle, true);
      window.removeEventListener('resize', handle);
    };
  }, [show, updatePosition]);

  return (
    <div
      ref={triggerRef}
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && pos && createPortal(
        <div
          className="fixed z-[100] pointer-events-none bg-slate-900 border border-slate-600 rounded-xl shadow-2xl"
          style={{
            left: pos.left,
            top: pos.top,
            transform: `translate(-50%, ${pos.flipped ? '-100%' : '0'})`,
          }}
        >
          <CardDetail card={card} />
        </div>,
        document.body
      )}
    </div>
  );
}

/* ====================================================== */
/*  Section header (main-phase action panel)                */
/* ====================================================== */

function SectionHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-500/70 mb-1.5 pb-1 border-b border-emerald-900/40">
      {icon}
      <span>{label}</span>
    </div>
  );
}

/* ====================================================== */
/*  HP Bar                                                */
/* ====================================================== */

function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const color = pct > 50 ? 'from-green-400 to-green-600' : pct > 20 ? 'from-yellow-400 to-yellow-600' : 'from-red-400 to-red-600';
  return (
    <div className="w-full bg-black/40 rounded-full h-2.5 overflow-hidden border border-black/30 shadow-inner">
      <div
        className={`h-full bg-gradient-to-b ${color} transition-all duration-500 ease-out rounded-full`}
        style={{ width: `${pct}%` }}
      />
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
      if (m.type === 'play_pokemon' || m.type === 'evolve_pokemon' || m.type === 'attach_energy' || m.type === 'play_trainer' || m.type === 'choose_active') {
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
/*  Pending-choice picker — for choices with no on-field    */
/*  representation (deck search results, energy type, etc.) */
/* ====================================================== */

/** Server enumerates every legal N-item combination as a separate 'resolve_choice' move (so it
 * can validate whatever gets submitted). Used only for choices that aren't already visible as
 * real objects on the battlefield (deck-search results, "pick an energy type", a bare confirm) —
 * anything that IS a Pokémon already in play, or already sitting in the player's hand, is instead
 * selected by clicking the real thing directly (see the targeting-mode wiring in Battle()).
 * Single-pick options submit on click; multi-pick ones check/uncheck with a confirm button. */
function PendingChoicePicker({
  choice, moves, loading, onSubmit,
}: {
  choice: PendingChoice;
  moves: LegalAction[];
  loading: boolean;
  onSubmit: (move: LegalAction) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const pool: { id: string; label: string; cardData?: Card }[] = (choice.options || []).map(o => ({ id: o.id, label: o.label, cardData: o.cardData }));
  const minCount = choice.count ?? choice.minCount ?? 0;
  const maxCount = choice.count ?? choice.maxCount ?? pool.length;
  const isMultiSelect = maxCount > 1;

  const toggle = (id: string) => {
    if (!isMultiSelect) {
      const move = moves.find(m => {
        const sel = (m.payload?.selection as string[] | undefined) || [];
        return sel.length === 1 && sel[0] === id;
      });
      if (move) onSubmit(move);
      return;
    }
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= maxCount) return prev;
        next.add(id);
      }
      return next;
    });
  };

  const countOk = checked.size >= minCount && checked.size <= maxCount;
  const matchedMove = countOk
    ? moves.find(m => {
        const sel = (m.payload?.selection as string[] | undefined) || [];
        return sel.length === checked.size && sel.every(id => checked.has(id));
      })
    : undefined;

  const countLabel = choice.count !== undefined
    ? `選 ${choice.count} 項`
    : minCount > 0 ? `選 ${minCount}–${maxCount} 項` : `最多選 ${maxCount} 項`;

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {isMultiSelect && <p className="text-xs text-slate-400">{countLabel} · 已選 {checked.size} 項</p>}
      <div className="flex-1 overflow-y-auto">
        {pool.length === 0 ? (
          <p className="text-slate-500 text-sm">沒有可選的項目……</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pool.map(item => {
              const isChecked = checked.has(item.id);
              const btn = (
                <button
                  key={item.id}
                  onClick={() => toggle(item.id)}
                  disabled={loading}
                  className={`relative flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    isChecked ? 'bg-emerald-900/40' : 'hover:bg-slate-700/60'
                  }`}
                >
                  {item.cardData ? (
                    <div className={`w-16 h-[4.5rem] rounded-md border-2 overflow-hidden bg-slate-900 transition-colors ${isChecked ? 'border-emerald-400' : 'border-slate-600'}`}>
                      <img src={item.cardData.images.small} alt={item.label} onError={handleCardImgError} className="w-full h-full object-contain" />
                    </div>
                  ) : (
                    <div className={`px-3 py-2 rounded-md border-2 text-xs text-slate-100 transition-colors ${isChecked ? 'border-emerald-400 bg-emerald-900/30' : 'border-slate-600'}`}>
                      {item.label}
                    </div>
                  )}
                  {item.cardData && (
                    <span className="text-[10px] text-slate-300 max-w-16 truncate">{item.label}</span>
                  )}
                  {isMultiSelect && (
                    <span className={`absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold border transition-colors ${
                      isChecked ? 'bg-emerald-500 border-emerald-300 text-white' : 'bg-slate-800 border-slate-600 text-transparent'
                    }`}>✓</span>
                  )}
                </button>
              );
              return item.cardData ? <HoverPreview key={item.id} card={item.cardData} placement="above">{btn}</HoverPreview> : btn;
            })}
          </div>
        )}
      </div>
      {isMultiSelect && (
        <button
          onClick={() => matchedMove && onSubmit(matchedMove)}
          disabled={!matchedMove || loading}
          className="w-full py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          確認選擇
        </button>
      )}
      {isMultiSelect && checked.size > 0 && countOk && !matchedMove && (
        <p className="text-red-400 text-xs text-center">此組合暫時無法使用，請重新選擇</p>
      )}
    </div>
  );
}

/* ====================================================== */
/*  Main Battle Component                                 */
/* ====================================================== */

export default function Battle() {
  const { decks, presetDecks, fetchPresetDecks } = useDeckStore();
  const { cards, fetchCards } = useCardStore();
  const {
    battleState, loading, error, battlePhase,
    createBattle, submitMove, leaveGame,
  } = useGameStore();

  const [selectedDeckId, setSelectedDeckId] = useState('');
  const [showPlayerDiscard, setShowPlayerDiscard] = useState(false);
  const [showOpponentDiscard, setShowOpponentDiscard] = useState(false);
  const [showOpponentHand, setShowOpponentHand] = useState(false);
  const [floaters, setFloaters] = useState<{ id: number; side: 'player' | 'opponent'; text: string; kind: 'damage' | 'ko' }[]>([]);
  // Hand-card-initiated targeting (e.g. "attach this energy to which of your Pokémon?") — set
  // when a hand card has more than one legal move and every one of them targets a Pokémon
  // already on the board, so the player picks by clicking the real Pokémon instead of reading
  // a list of "Attach X to Y" text buttons. Cleared on submit or by clicking the source card
  // again / the cancel affordance. Pending-choice-driven targeting (server-forced, no cancel)
  // is derived separately below rather than stored here.
  const [manualTargeting, setManualTargeting] = useState<{ sourceCardId: string; prompt: string; moves: LegalAction[] } | null>(null);
  // Provisional selection for any multi-pick targeting (either hand-card-driven or
  // pending-choice-driven) — reset whenever the active prompt changes (see the render-time
  // reset further down, next to where the active prompt is actually known).
  const [pickedTargets, setPickedTargets] = useState<Set<string>>(new Set());
  const targetingPromptRef = useRef<string | null>(null);

  useEffect(() => {
    fetchCards();
    fetchPresetDecks();
  }, [fetchCards, fetchPresetDecks]);

  // Derive transient damage-number/KO floaters from newly appended turnLog entries — the
  // server only ever sends full state snapshots, not per-action events, so this diffs
  // against the previously seen log length instead of listening for a dedicated event.
  const prevLogLenRef = useRef(0);
  const floaterIdRef = useRef(0);
  useEffect(() => {
    const log = battleState?.turnLog;
    if (!log) { prevLogLenRef.current = 0; return; }
    if (log.length < prevLogLenRef.current) prevLogLenRef.current = 0; // new battle started
    const newEntries = log.slice(prevLogLenRef.current);
    prevLogLenRef.current = log.length;
    if (newEntries.length === 0) return;

    const additions: typeof floaters = [];
    for (const entry of newEntries) {
      if (entry.action === 'attack') {
        const m = entry.details.match(/for (\d+) damage to/);
        if (m) additions.push({ id: floaterIdRef.current++, side: entry.player === 0 ? 'opponent' : 'player', text: `-${m[1]}`, kind: 'damage' });
      } else if (entry.action === 'ko') {
        additions.push({ id: floaterIdRef.current++, side: entry.player === 0 ? 'opponent' : 'player', text: 'KO!', kind: 'ko' });
      }
    }
    if (additions.length === 0) return;
    setFloaters(prev => [...prev, ...additions]);
    const ids = additions.map(a => a.id);
    const timer = setTimeout(() => {
      setFloaters(prev => prev.filter(f => !ids.includes(f.id)));
    }, 1150);
    return () => clearTimeout(timer);
  }, [battleState]);

  // Preset decks let a tester jump straight into a battle without building a deck first.
  const selectableDecks = useMemo(
    () => [...decks, ...presetDecks],
    [decks, presetDecks]
  );

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
    const deck = selectableDecks.find(d => d.id === selectedDeckId);
    if (!deck) return;
    try {
      await createBattle(deck.cards);
    } catch { /* handled by store */ }
  }, [selectedDeckId, selectableDecks, createBattle]);

  // Every interactive surface (quick actions, hand cards, board targets, pending-choice picks)
  // funnels through this handler or the two below — guarding `loading` here once, rather than on
  // every individual button, is what keeps a slow response from letting a rapid double-click
  // submit a second move before the first one's result comes back.
  const handleSubmitMove = useCallback((move: LegalAction) => {
    if (loading) return;
    setManualTargeting(null);
    setPickedTargets(new Set());
    submitMove(move.type, move.payload);
  }, [submitMove, loading]);

  // A hand card with exactly one legal move (playing a Basic, playing a Trainer, or evolving/
  // attaching when there's only one valid target anyway) just does it — nothing to pick, so
  // asking first would only add a click. One with several targets — attaching energy or
  // evolving when more than one of your own Pokémon qualifies — enters targeting mode instead
  // of opening a list: the real Pokémon it could go to light up on the board itself.
  const handleCardClick = useCallback((cardId: string) => {
    if (loading) return;
    if (manualTargeting?.sourceCardId === cardId) { setManualTargeting(null); return; }
    const hca = handCardActions.find(h => h.cardData.id === cardId);
    if (!hca) return;
    if (hca.moves.length === 1) { handleSubmitMove(hca.moves[0]); return; }
    if (hca.moves.every(m => typeof m.payload?.targetId === 'string')) {
      setManualTargeting({ sourceCardId: cardId, prompt: `選擇要對哪隻寶可夢使用「${hca.cardData.name}」`, moves: hca.moves });
    }
  }, [handCardActions, manualTargeting, handleSubmitMove, loading]);

  const handleRetry = useCallback(() => {
    leaveGame();
  }, [leaveGame]);

  const bs = battleState;
  const phaseLabels: Record<string, string> = {
    choose_active: '選擇出戰寶可夢', draw: '抽牌階段', main: '主要階段', attack: '攻擊階段', end: '結束階段',
  };
  const winReasonLabels: Record<string, string> = {
    'took all prizes': '奪得所有獎賞卡',
    'opponent has no pokemon': '對手場上沒有寶可夢',
    'deck empty at draw': '牌庫已抽完',
    'no legal moves': '沒有可行的行動',
  };

  /* ======================== */
  /*  Phase: Select Deck (no server battle active)     */
  /* ======================== */
  if (battlePhase === 'select') {
    return (
      <div className="flex items-center justify-center min-h-[70vh] relative overflow-hidden rounded-2xl">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,#14532d_0%,#052e16_55%,#031f0f_100%)]" />
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div className="relative bg-slate-900/80 backdrop-blur border border-emerald-800/50 rounded-2xl p-8 w-full max-w-md shadow-2xl">
          <h1 className="text-2xl font-bold text-white text-center mb-1">⚔ AI 對戰練習</h1>
          <p className="text-center text-emerald-500/70 text-xs mb-6">挑選一副牌組，開始練習對局</p>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">選擇你的牌組</label>
              {selectableDecks.length === 0 ? (
                <p className="text-slate-500 text-sm bg-slate-700/50 rounded-lg p-3 text-center">
                  尚無可用牌組，請先到牌組構築建立牌組
                </p>
              ) : (
                <select
                  value={selectedDeckId}
                  onChange={(e) => setSelectedDeckId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="">選擇牌組...</option>
                  {decks.length > 0 && (
                    <optgroup label="我的牌組">
                      {decks.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}（{d.cards.length} 張）</option>
                      ))}
                    </optgroup>
                  )}
                  {presetDecks.length > 0 && (
                    <optgroup label="預組牌組">
                      {presetDecks.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}（{d.cards.length} 張）</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
            </div>
            <button
              onClick={handleStartBattle}
              disabled={!selectedDeckId || loading}
              className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-lg shadow-emerald-900/40"
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
    card, size = 'normal', showHp = true, onClick, targetable, picked, previewPlacement = 'above', shake = false,
  }: {
    card: SanitizedGameCard;
    size?: 'normal' | 'small';
    showHp?: boolean;
    onClick?: () => void;
    /** This Pokémon is a legal click-target for whatever's currently being resolved (attaching
     * energy, evolving, or a server-forced pendingChoice) — gets a pulsing highlight so the
     * valid options read at a glance instead of needing a separate list to cross-reference. */
    targetable?: boolean;
    /** Provisionally selected as part of a multi-pick targeting choice (not yet confirmed). */
    picked?: boolean;
    previewPlacement?: 'above' | 'below';
    shake?: boolean;
  }) {
    const cd = card.cardData;
    const hp = cd.hp ? parseInt(cd.hp) : 0;
    const remainingHp = Math.max(0, hp - card.damage);
    const isW = size === 'small';
    const wCls = isW ? 'w-24' : 'w-36';
    const imgH = isW ? 'h-[4.5rem]' : 'h-[7.5rem]';
    const ring = picked
      ? 'ring-2 ring-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.6)]'
      : targetable
      ? 'ring-2 ring-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.6)] animate-pulse'
      : '';

    return (
      <div
        className={`flex flex-col items-center gap-1 cursor-pointer transition-all animate-card-enter ${ring ? 'rounded-xl' : ''} ${ring}
          ${onClick ? 'hover:-translate-y-1 focus-visible:-translate-y-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 focus-visible:outline-offset-2 rounded-xl' : ''} ${shake ? 'animate-shake' : ''}
          ${onClick && loading ? 'opacity-40 !cursor-not-allowed' : ''}`}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick && !loading ? 0 : undefined}
        onKeyDown={onClick ? keyActivate(onClick) : undefined}
      >
        <HoverPreview card={cd} placement={previewPlacement}>
          <div className={`${wCls} ${imgH} bg-slate-900 border-2 border-slate-600/80 rounded-xl overflow-hidden hover:border-emerald-400 transition-colors shadow-lg shadow-black/40`}>
            <img src={cd.images.small} alt={cd.name} onError={handleCardImgError} className="w-full h-full object-contain" />
          </div>
        </HoverPreview>
        {showHp && hp > 0 && (
          <div className="w-full px-0.5">
            <div className="flex justify-between items-baseline text-[10px] mb-0.5">
              <span className="truncate max-w-[60%] text-slate-100 font-medium">{cd.name}</span>
              <span className="text-slate-300 font-semibold tabular-nums">{remainingHp}/{hp}</span>
            </div>
            <HpBar current={remainingHp} max={hp} />
          </div>
        )}
        {!showHp && (
          <span className="text-[10px] text-slate-300 truncate max-w-[90%] font-medium">{cd.name}</span>
        )}
        {(card.attachedEnergy.length > 0 || card.attachedTool) && (
          <div className="flex gap-0.5 flex-wrap justify-center items-center mt-0.5">
            {card.attachedEnergy.map((e) => (
              <span key={e.id} className="animate-card-enter inline-flex">
                <EnergyIcon type={e.type} size={isW ? 'sm' : 'sm'} />
              </span>
            ))}
            {card.attachedTool && (
              <HoverPreview card={card.attachedTool.cardData} placement={previewPlacement}>
                <span className="animate-card-enter inline-flex w-4 h-4 rounded overflow-hidden border border-amber-400/70 shadow-[0_0_4px_rgba(251,191,36,0.5)]">
                  <img src={card.attachedTool.cardData.images.small} alt={card.attachedTool.cardData.name} onError={handleCardImgError} className="w-full h-full object-cover" />
                </span>
              </HoverPreview>
            )}
          </div>
        )}
        {card.damage > 0 && (
          <span className="text-[10px] text-red-400 font-bold">-{card.damage}</span>
        )}
        <StatusConditionBadges conditions={card.statusConditions} />
      </div>
    );
  }

  function PrizeDisplay({ count, label }: { count: number; label: string }) {
    return (
      <div className="flex items-center gap-1.5" title={`獎賞卡 ${count}/6`}>
        {label && <span className="text-xs text-slate-400">{label}</span>}
        <div className="flex gap-0.5">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className={`w-2 h-2.5 rounded-[2px] border ${
                i < count
                  ? 'bg-gradient-to-b from-yellow-300 to-yellow-500 border-yellow-200/60 shadow-[0_0_3px_rgba(250,204,21,0.6)]'
                  : 'bg-slate-800 border-slate-700'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  /** Shared modal for either side's discard pile — real rules treat both piles as public
   * information (either player may look through either at any time), so both render the
   * actual cards rather than just a count. */
  function DiscardModal({ title, cards, onClose }: { title: string; cards: SanitizedGameCard[]; onClose: () => void }) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
        <div
          className="relative bg-[radial-gradient(ellipse_at_top,#14532d_0%,#052e16_60%,#031f0f_100%)] border border-emerald-800/60 rounded-2xl p-5 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold flex items-center gap-1.5">
              <IconTrash className="w-4 h-4" />
              {title}（{cards.length} 張）
            </h3>
            <button
              onClick={onClose}
              aria-label="關閉"
              className="w-11 h-11 -m-2 flex items-center justify-center rounded-full text-emerald-500/70 hover:text-emerald-200 hover:bg-white/5 transition-colors"
            >
              <IconX className="w-4 h-4" />
            </button>
          </div>
          {cards.length === 0 ? (
            <p className="text-emerald-700/70 text-sm">暫無棄牌</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {cards.map((c, i) => (
                <HoverPreview key={c.id ?? i} card={c.cardData} placement="above">
                  <img src={c.cardData.images.small} alt={c.cardData.name} onError={handleCardImgError}
                    className="w-16 h-[4.5rem] rounded-lg object-contain bg-slate-900 border border-slate-700 hover:ring-2 hover:ring-emerald-400 hover:border-emerald-400 transition-all" />
                </HoverPreview>
              ))}
            </div>
          )}
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

  // --- Targeting: click a real Pokémon (on the board) or a real card (in hand) instead of
  // reading a list of text options. Driven either by a hand-card click (manualTargeting, always
  // cancelable) or by the server forcing a choice whose options are Pokémon already in play or
  // cards already in hand (bs.pendingChoice with a matching choiceType — never cancelable, since
  // the effect is already mid-resolution). The two are mutually exclusive at any given moment. */
  const boardTargeting = manualTargeting
    ? { prompt: manualTargeting.prompt, moves: manualTargeting.moves, minCount: 1, maxCount: 1 }
    : bs.pendingChoice && (bs.pendingChoice.choiceType === 'select_pokemon' || bs.pendingChoice.choiceType === 'select_bench_pokemon')
    ? {
        prompt: bs.pendingChoice.prompt,
        moves: pendingChoiceMoves,
        minCount: bs.pendingChoice.minCount ?? bs.pendingChoice.count ?? 1,
        maxCount: bs.pendingChoice.maxCount ?? bs.pendingChoice.count ?? 1,
      }
    : null;
  const handTargeting = (!manualTargeting && bs.pendingChoice?.choiceType === 'select_hand_cards')
    ? {
        prompt: bs.pendingChoice.prompt,
        moves: pendingChoiceMoves,
        minCount: bs.pendingChoice.minCount ?? bs.pendingChoice.count ?? 0,
        maxCount: bs.pendingChoice.maxCount ?? bs.pendingChoice.count ?? bs.player.hand.length,
      }
    : null;
  const activeTargeting = boardTargeting ?? handTargeting;

  // Reset the provisional multi-pick selection whenever which prompt is active changes — done
  // during render (React's documented pattern for "state that depends on changing props/derived
  // values") rather than a useEffect, since a new hook can't be added this deep without breaking
  // the rules of hooks (this code runs after the early returns above).
  const activeTargetingPrompt = activeTargeting?.prompt ?? null;
  if (targetingPromptRef.current !== activeTargetingPrompt) {
    targetingPromptRef.current = activeTargetingPrompt;
    if (pickedTargets.size > 0) setPickedTargets(new Set());
  }

  const targetIds = new Set<string>();
  if (activeTargeting) {
    for (const m of activeTargeting.moves) {
      if (typeof m.payload?.targetId === 'string') { targetIds.add(m.payload.targetId as string); continue; }
      const sel = m.payload?.selection as string[] | undefined;
      if (sel) for (const id of sel) targetIds.add(id);
    }
  }
  const isMultiTarget = !!activeTargeting && activeTargeting.maxCount > 1;
  const matchedTargetMove = (isMultiTarget && activeTargeting && pickedTargets.size >= activeTargeting.minCount && pickedTargets.size <= activeTargeting.maxCount)
    ? activeTargeting.moves.find(m => {
        const sel = (m.payload?.selection as string[] | undefined) ?? (typeof m.payload?.targetId === 'string' ? [m.payload.targetId as string] : []);
        return sel.length === pickedTargets.size && sel.every(id => pickedTargets.has(id));
      })
    : undefined;

  /** Spreads targeting props onto whichever PokemonCardView is rendering `id` — a no-op object
   * when nothing is currently targetable, so this is safe to spread unconditionally everywhere
   * a Pokémon is rendered. */
  const targetProps = (id: string) => targetIds.has(id)
    ? { targetable: true, picked: pickedTargets.has(id), onClick: () => handleTargetClick(id) }
    : {};

  const handleTargetClick = (targetId: string) => {
    if (loading) return;
    if (!activeTargeting || !targetIds.has(targetId)) return;
    if (!isMultiTarget) {
      const move = activeTargeting.moves.find(m =>
        m.payload?.targetId === targetId || (Array.isArray(m.payload?.selection) && (m.payload!.selection as string[])[0] === targetId)
      );
      if (move) handleSubmitMove(move);
      return;
    }
    setPickedTargets(prev => {
      const next = new Set(prev);
      if (next.has(targetId)) next.delete(targetId);
      else if (next.size < activeTargeting.maxCount) next.add(targetId);
      return next;
    });
  };

  /** Lets keyboard users (Tab + Enter/Space) drive the same board/hand click targets that mouse
   * users click directly — the whole targeting redesign is built on real elements with onClick,
   * so this is the one addition needed for keyboard parity rather than a separate input path. */
  const keyActivate = (fn: () => void) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  };

  return (
    <div className="flex gap-3 h-[calc(100vh-7rem)] min-h-0">

      {/* Pending choice modal: only for choices with no on-field/in-hand representation (deck
          search results, "pick an energy type", a bare confirm). Choices that ARE a Pokémon
          already in play or a card already in hand are resolved by clicking the real thing
          directly instead — see boardTargeting/handTargeting and their banner further below. */}
      {!isOver && bs.pendingChoice && !boardTargeting && !handTargeting && (() => {
        const choice = bs.pendingChoice;
        const effectiveMax = choice.count ?? choice.maxCount ?? 1;
        const isMultiSelect = effectiveMax > 1;
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
            <div className="bg-slate-800 border border-blue-500/50 rounded-2xl p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
              <h3 className="text-white font-semibold mb-1">卡牌效果</h3>
              <p className="text-slate-300 text-sm mb-4">{choice.prompt}</p>
              {isMultiSelect ? (
                <PendingChoicePicker
                  key={choice.prompt}
                  choice={choice}
                  moves={pendingChoiceMoves}
                  loading={loading}
                  onSubmit={handleSubmitMove}
                />
              ) : (
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
              )}
            </div>
          </div>
        );
      })()}

      {/* Targeting banner: replaces the old "list of text buttons" modal for anything whose
          options are Pokémon already on the board or cards already in hand — those light up
          directly (see targetProps/handTargeting below) and this banner just carries the
          prompt, an optional cancel (only for a hand-card-initiated pick, never for a
          server-forced pendingChoice), and — for multi-pick choices — a floating confirm button
          once enough targets are picked. Non-blocking (no backdrop) since the player needs to
          see the board to click on it. */}
      {!isOver && activeTargeting && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-2 bg-slate-900/95 border border-sky-500/50 rounded-full pl-4 pr-1.5 py-1.5 shadow-2xl shadow-black/50 animate-result-pop">
          <span className="text-sky-200 text-xs font-medium">{activeTargeting.prompt}</span>
          {isMultiTarget && (
            <span className="text-sky-400/70 text-[10px]">已選 {pickedTargets.size}/{activeTargeting.maxCount}</span>
          )}
          {isMultiTarget && matchedTargetMove && (
            <button
              onClick={() => handleSubmitMove(matchedTargetMove)}
              disabled={loading}
              className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-full transition-colors"
            >
              確認
            </button>
          )}
          {manualTargeting && (
            <button
              onClick={() => setManualTargeting(null)}
              aria-label="取消"
              className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              <IconX className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Left column: battlefield — one continuous felt board instead of stacked boxed panels */}
      <div className="flex-1 flex flex-col min-h-0 rounded-2xl overflow-hidden border border-emerald-900/60 shadow-2xl relative bg-[radial-gradient(ellipse_at_top,#14532d_0%,#052e16_55%,#031f0f_100%)]">
        <div
          className="absolute inset-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />

        {/* Top status bar: turn/phase + legal-action availability at a glance */}
        <div className="relative flex-shrink-0 flex items-center justify-between px-3 py-1.5 bg-black/30 backdrop-blur-sm border-b border-emerald-900/50">
          <div className="flex items-center gap-2">
            <button onClick={leaveGame} className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors mr-1">
              <IconArrowLeft className="w-3.5 h-3.5" />
              離開
            </button>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${bs.isPlayerTurn ? 'bg-green-900/60 text-green-300 border border-green-700/60' : 'bg-red-900/60 text-red-300 border border-red-700/60'}`}>
              {bs.isPlayerTurn ? '你的回合' : '對手回合'}
            </span>
            <span className="text-xs text-slate-400">回合 {bs.turn}</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-700/80 text-[11px] text-slate-300 font-medium">
              {phaseLabels[bs.phase] || bs.phase}
            </span>
            {loading && (
              <span className="flex items-center gap-1 text-[11px] text-sky-400/80">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-sky-400/40 border-t-sky-400 animate-spin" />
                傳送中…
              </span>
            )}
          </div>
          {!isOver && bs.isPlayerTurn && (bs.phase === 'main' || bs.phase === 'attack') && (
            <div className="hidden sm:flex items-center gap-1">
              {[
                { label: '攻擊', ok: quickActions.some(m => m.type === 'attack') },
                { label: '撤退', ok: quickActions.some(m => m.type === 'retreat') },
                { label: '訓練家', ok: trainerActions.length > 0 },
                { label: '特性', ok: abilityActions.length > 0 },
              ].map((p) => (
                <span
                  key={p.label}
                  className={`px-1.5 py-0.5 rounded text-[10px] border ${
                    p.ok
                      ? 'bg-emerald-900/50 border-emerald-700/60 text-emerald-300'
                      : 'bg-black/20 border-slate-800 text-slate-600'
                  }`}
                >
                  {p.label}{p.ok ? '可用' : ''}
                </span>
              ))}
            </div>
          )}
          <span className="text-[11px] text-slate-500">
            對手手牌 {bs.opponent.handCount} · 你的手牌 {bs.player.hand.length}
          </span>
        </div>

        {/* Active Stadium: shared, board-wide effect — sits between both sides rather than
            belonging to either player's area. */}
        {bs.activeStadium && (
          <div className="relative flex-shrink-0 flex items-center justify-center gap-2 px-3 py-1 bg-amber-950/30 border-b border-amber-700/30">
            <HoverPreview card={bs.activeStadium.cardData} placement="below">
              <div className="flex items-center gap-1.5 cursor-default">
                <img src={bs.activeStadium.cardData.images.small} alt={bs.activeStadium.cardData.name} onError={handleCardImgError} className="w-4 h-5 object-contain rounded-sm" />
                <IconBuilding className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] text-amber-300 font-medium">{bs.activeStadium.cardData.name}</span>
              </div>
            </HoverPreview>
          </div>
        )}

        {/* Opponent area */}
        <div className="relative flex-shrink-0 p-2.5 border-b border-emerald-900/40">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-red-300">對手</span>
              <PrizeDisplay count={bs.opponent.prizes} label="" />
              <button
                onClick={() => setShowOpponentHand(true)}
                className="text-xs text-emerald-500/60 hover:text-emerald-300 transition-colors"
              >
                手牌 ({bs.opponent.handCount})
              </button>
              <button
                onClick={() => setShowOpponentDiscard(true)}
                className="text-xs text-emerald-500/60 hover:text-emerald-300 transition-colors"
              >
                棄牌 ({bs.opponent.discardCount})
              </button>
              <span className="text-xs text-emerald-700/60">牌庫 {bs.opponent.deckCount}</span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-3">
            <div className="relative">
              {bs.opponent.active ? (
                <PokemonCardView
                  key={bs.opponent.active.id}
                  card={bs.opponent.active}
                  size="normal"
                  showHp={true}
                  previewPlacement="below"
                  shake={floaters.some(f => f.side === 'opponent' && f.kind === 'damage')}
                  {...targetProps(bs.opponent.active.id)}
                />
              ) : (
                <div className="w-36 h-[7.5rem] bg-black/20 border-2 border-dashed border-emerald-900/60 rounded-xl flex items-center justify-center flex-shrink-0">
                  <span className="text-emerald-600/80 text-xs">無寶可夢</span>
                </div>
              )}
              <div className="absolute inset-x-0 top-0 flex flex-col items-center pointer-events-none z-20">
                {floaters.filter(f => f.side === 'opponent').map(f => (
                  <span key={f.id} className={`absolute font-black drop-shadow-lg animate-float-up ${f.kind === 'ko' ? 'text-red-400 text-2xl' : 'text-yellow-300 text-lg'}`}>
                    {f.text}
                  </span>
                ))}
              </div>
            </div>
            <div className="w-px self-stretch bg-emerald-900/40 flex-shrink-0" />
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, i) => {
                const c = bs.opponent.bench[i];
                return c ? (
                  <PokemonCardView key={c.id} card={c} size="small" showHp={false} previewPlacement="below" {...targetProps(c.id)} />
                ) : (
                  <div key={i} className="w-24 h-[4.5rem] bg-black/10 border border-dashed border-emerald-900/50 rounded-md flex items-center justify-center">
                    <span className="text-emerald-700/80 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Middle: Actions */}
        <div className="relative bg-black/25 backdrop-blur-sm p-3 flex-1 min-h-0 flex flex-col">

          {/* Error display */}
          {error && (
            <div className="mb-2 p-2 bg-red-900/50 border border-red-700 rounded text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Game over */}
          {isOver && (
            <div className="flex-1 flex flex-col items-center justify-center animate-result-pop">
              <div className={`text-6xl mb-2 ${bs.winner === 0 ? 'animate-glow-pulse' : 'opacity-60 grayscale'}`}>
                {bs.winner === 0 ? '🏆' : '💀'}
              </div>
              <p
                className={`text-3xl font-black tracking-wide mb-1 ${
                  bs.winner === 0
                    ? 'bg-gradient-to-b from-yellow-200 to-yellow-500 bg-clip-text text-transparent drop-shadow-[0_2px_16px_rgba(250,204,21,0.45)]'
                    : 'text-slate-400'
                }`}
              >
                {bs.winner === 0 ? '勝利！' : '戰敗'}
              </p>
              <p className="text-xs text-slate-500 mb-5">{(bs.winReason && winReasonLabels[bs.winReason]) || bs.winReason}</p>
              <div className="flex items-center gap-8 mb-6">
                <div className="flex flex-col items-center gap-1.5">
                  <span className="text-xs font-medium text-blue-300">你</span>
                  <PrizeDisplay count={bs.player.prizes} label="" />
                  <span className="text-[10px] text-slate-500">已奪 {bs.player.prizes}/6</span>
                </div>
                <div className="w-px h-10 bg-emerald-900/60" />
                <div className="flex flex-col items-center gap-1.5">
                  <span className="text-xs font-medium text-red-300">對手</span>
                  <PrizeDisplay count={bs.opponent.prizes} label="" />
                  <span className="text-[10px] text-slate-500">已奪 {bs.opponent.prizes}/6</span>
                </div>
              </div>
              <button
                onClick={handleRetry}
                className="px-8 py-2.5 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-xl font-medium hover:from-emerald-400 hover:to-emerald-600 transition-colors shadow-lg shadow-emerald-950/50"
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

              {/* Choose-active phase: opening hand is dealt, pick which Basic Pokémon starts as Active */}
              {bs.phase === 'choose_active' && (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
                  <p className="text-lg font-semibold text-white">請選擇一張基礎寶可夢作為你的出戰寶可夢</p>
                  <p className="text-xs text-slate-400 -mt-3">點擊下方卡片即可上場（其餘的基礎寶可夢之後可在主要階段放上備戰區）</p>
                  <div className="flex flex-wrap justify-center gap-3">
                    {battleState.legalMoves.filter(m => m.type === 'choose_active').map((m, i) => {
                      const cardData = bs.player.hand.find(c => c.id === m.payload?.cardId);
                      if (!cardData) return null;
                      return (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          disabled={loading}
                          className="flex flex-col items-center gap-1 group animate-card-enter disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <div className="w-20 h-[6.75rem] bg-slate-900 border-2 border-emerald-600/60 rounded-lg overflow-hidden group-hover:border-emerald-400 group-hover:-translate-y-1 transition-all shadow-lg shadow-emerald-950/50">
                            <img src={cardData.images.small} alt={cardData.name} onError={handleCardImgError} className="w-full h-full object-contain" />
                          </div>
                          <span className="text-xs text-slate-200 font-medium max-w-20 truncate">{cardData.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Draw phase */}
              {bs.phase === 'draw' && (
                <div className="flex items-center justify-center h-full">
                  <button
                    onClick={() => {
                      const drawMove = quickActions.find(m => m.type === 'draw_card');
                      if (drawMove) handleSubmitMove(drawMove);
                    }}
                    disabled={loading}
                    className="px-8 py-4 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-xl text-lg font-medium hover:from-emerald-400 hover:to-emerald-600 transition-colors shadow-lg shadow-emerald-950/50 disabled:opacity-40 disabled:cursor-not-allowed"
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
                    <SectionHeader icon={<IconBolt className="w-3.5 h-3.5" />} label="快捷行動" />
                    <div className="flex flex-wrap gap-1.5">
                      {quickActions.filter(m => m.type === 'attack').map((m, i) => {
                        const atkIdx = m.payload?.attackIndex as number;
                        const atk = bs.player.active?.cardData.attacks?.[atkIdx];
                        const btn = (
                          <button
                            key={i}
                            onClick={() => handleSubmitMove(m)}
                            disabled={loading}
                            className="px-3 py-2 bg-gradient-to-b from-red-600 to-red-800 text-white rounded-lg text-xs font-medium hover:from-red-500 hover:to-red-700 transition-colors flex items-center gap-1.5 shadow-md shadow-red-950/50 border border-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <IconSword className="w-3.5 h-3.5" />
                            {atk?.cost.map((c, ci) => <EnergyIcon key={ci} type={c} />)}
                            <span>{atk?.name || m.description}</span>
                            {atk?.damage && <span className="text-yellow-300 font-bold">{atk.damage}</span>}
                          </button>
                        );
                        return atk && bs.player.active ? (
                          <HoverPreview key={i} card={bs.player.active.cardData} placement="above">{btn}</HoverPreview>
                        ) : btn;
                      })}
                      {quickActions.filter(m => m.type === 'retreat').map((m, i) => {
                        const cost = (m.payload?.retreatCost as number) ?? 0;
                        return (
                          <button
                            key={i}
                            onClick={() => handleSubmitMove(m)}
                            disabled={loading}
                            className="px-3 py-2 bg-orange-700 text-white rounded-lg text-xs font-medium hover:bg-orange-600 transition-colors border border-orange-500/30 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            <IconUndo className="w-3.5 h-3.5" />
                            <span>撤退</span>
                            {cost > 0 && (
                              <span className="flex gap-0.5">
                                {Array.from({ length: cost }, (_, ci) => <EnergyIcon key={ci} type="Colorless" />)}
                              </span>
                            )}
                          </button>
                        );
                      })}
                      {quickActions.filter(m => m.type === 'end_turn').map((m, i) => (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          disabled={loading}
                          className="px-3 py-2 bg-slate-700 text-white rounded-lg text-xs font-medium hover:bg-slate-600 transition-colors ml-auto border border-slate-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          結束回合 →
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Hand card actions */}
                  {handCardActions.length > 0 && (
                    <section>
                      <SectionHeader icon={<IconCards className="w-3.5 h-3.5" />} label="手牌（點擊卡片選擇動作，滑鼠移入可預覽效果）" />
                      <div className="flex flex-wrap gap-2">
                        {handCardActions.map((hca) => {
                          const isTargetingSource = manualTargeting?.sourceCardId === hca.cardData.id;
                          return (
                            <div key={hca.cardData.id} className="flex flex-col items-center animate-card-enter">
                              <HoverPreview card={hca.cardData} placement="above">
                                <img
                                  src={hca.cardData.images.small}
                                  alt={hca.cardData.name}
                                  onError={handleCardImgError}
                                  className={`w-14 h-[4.5rem] rounded-lg transition-all object-contain border-2
                                    ${isTargetingSource ? 'border-sky-400 -translate-y-1 shadow-lg shadow-sky-500/30' : 'border-slate-600 hover:border-slate-400'}
                                    ${loading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 focus-visible:outline-offset-2`}
                                  onClick={() => handleCardClick(hca.cardData.id)}
                                  role="button"
                                  tabIndex={loading ? -1 : 0}
                                  onKeyDown={keyActivate(() => handleCardClick(hca.cardData.id))}
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
                      <SectionHeader icon={<IconWrench className="w-3.5 h-3.5" />} label="訓練家卡（點擊使用）" />
                      <div className="flex flex-wrap gap-2">
                        {trainerActions.map((m, i) => {
                          const cardData = bs.player.hand.find(c => c.id === m.payload?.cardId);
                          const btn = (
                            <button
                              onClick={() => handleSubmitMove(m)}
                              disabled={loading}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-indigo-700 text-white rounded-lg text-xs font-medium hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {cardData && <img src={cardData.images.small} alt="" onError={handleCardImgError} className="w-5 h-7 object-contain rounded-sm" />}
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
                      <SectionHeader icon={<IconSparkle className="w-3.5 h-3.5" />} label="特性（點擊使用）" />
                      <div className="flex flex-wrap gap-2">
                        {abilityActions.map((m, i) => {
                          const cardId = m.payload?.cardId as string | undefined;
                          const cardData = [bs.player.active, ...bs.player.bench].find(c => c?.id === cardId)?.cardData;
                          const btn = (
                            <button
                              onClick={() => handleSubmitMove(m)}
                              disabled={loading}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-700 text-white rounded-lg text-xs font-medium hover:bg-emerald-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {cardData && <img src={cardData.images.small} alt="" onError={handleCardImgError} className="w-5 h-7 object-contain rounded-sm" />}
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
        <div className="relative flex-shrink-0 p-2.5 border-t border-emerald-900/40">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-blue-300">你</span>
              <PrizeDisplay count={bs.player.prizes} label="" />
              <button
                onClick={() => setShowPlayerDiscard(true)}
                className="text-xs text-emerald-500/60 hover:text-emerald-300 transition-colors"
              >
                棄牌 ({bs.player.discardPile.length})
              </button>
              <span className="text-xs text-emerald-700/60">牌庫 {bs.player.deckCount}</span>
            </div>
            <span className="text-xs text-emerald-700/60">手牌 {bs.player.hand.length}</span>
          </div>

          <div className="flex items-center justify-center gap-3 mb-1.5">
            <div className="relative">
              {bs.player.active ? (
                <PokemonCardView
                  key={bs.player.active.id}
                  card={bs.player.active}
                  size="normal"
                  showHp={true}
                  shake={floaters.some(f => f.side === 'player' && f.kind === 'damage')}
                  {...targetProps(bs.player.active.id)}
                />
              ) : (
                <div
                  className={`w-36 h-[7.5rem] bg-black/20 border-2 border-dashed rounded-xl flex items-center justify-center flex-shrink-0 ${
                    bs.phase === 'choose_active'
                      ? 'border-emerald-400 animate-pulse shadow-[0_0_16px_rgba(52,211,153,0.35)]'
                      : 'border-emerald-900/60'
                  }`}
                >
                  <span className={bs.phase === 'choose_active' ? 'text-emerald-400 text-xs' : 'text-emerald-600/80 text-xs'}>
                    {bs.phase === 'choose_active' ? '選擇出戰寶可夢' : '無寶可夢'}
                  </span>
                </div>
              )}
              <div className="absolute inset-x-0 top-0 flex flex-col items-center pointer-events-none z-20">
                {floaters.filter(f => f.side === 'player').map(f => (
                  <span key={f.id} className={`absolute font-black drop-shadow-lg animate-float-up ${f.kind === 'ko' ? 'text-red-400 text-2xl' : 'text-yellow-300 text-lg'}`}>
                    {f.text}
                  </span>
                ))}
              </div>
            </div>
            <div className="w-px self-stretch bg-emerald-900/40 flex-shrink-0" />
            <div className="flex gap-2">
              {Array.from({ length: 5 }, (_, i) => {
                const c = bs.player.bench[i];
                return c ? (
                  <PokemonCardView key={c.id} card={c} size="small" showHp={false} {...targetProps(c.id)} />
                ) : (
                  <div key={i} className="w-24 h-[4.5rem] bg-black/10 border border-dashed border-emerald-900/50 rounded-md flex items-center justify-center">
                    <span className="text-emerald-700/80 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Player hand row — doubles as the picker for a select_hand_cards pendingChoice (e.g.
              discarding for Ultra Ball): the actual cards here light up and toggle directly
              instead of a separate modal grid duplicating them. */}
          <div className="flex justify-center gap-1.5 overflow-x-auto pb-1">
            {bs.player.hand.length === 0 ? (
              <div className="text-slate-600 text-xs py-2">手牌為空</div>
            ) : (
              bs.player.hand.map((card) => {
                const isTargetingSource = manualTargeting?.sourceCardId === card.id;
                const isHandTarget = !!handTargeting && targetIds.has(card.id);
                const isPicked = isHandTarget && pickedTargets.has(card.id);
                const ring = isTargetingSource
                  ? 'border-sky-400 -translate-y-2 shadow-lg shadow-sky-500/30'
                  : isPicked
                  ? 'border-emerald-400 -translate-y-1 shadow-lg shadow-emerald-500/40'
                  : isHandTarget
                  ? 'border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.5)] animate-pulse'
                  : 'border-slate-600 hover:border-emerald-400';
                return (
                  <HoverPreview key={card.id} card={card} placement="above">
                    <div
                      className={`flex-shrink-0 w-16 h-[5.75rem] bg-slate-900 border-2 rounded-lg overflow-hidden animate-card-enter
                        ${ring} transition-all shadow-lg shadow-black/40
                        ${loading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 focus-visible:outline-offset-2`}
                      onClick={() => (handTargeting ? handleTargetClick(card.id) : handleCardClick(card.id))}
                      role="button"
                      tabIndex={loading ? -1 : 0}
                      onKeyDown={keyActivate(() => (handTargeting ? handleTargetClick(card.id) : handleCardClick(card.id)))}
                    >
                      <img src={card.images.small} alt={card.name} onError={handleCardImgError} className="w-full h-full object-contain" />
                    </div>
                  </HoverPreview>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Right column: Turn log */}
      <div className="w-64 flex-shrink-0 bg-[radial-gradient(ellipse_at_top,#0f2e1c_0%,#052e16_55%,#031f0f_100%)] border border-emerald-900/50 rounded-2xl p-3 flex flex-col min-h-0 shadow-xl">
        <h3 className="text-sm font-semibold text-emerald-100 mb-3 flex items-center gap-1.5 pb-2 border-b border-emerald-900/50">
          <IconScroll className="w-4 h-4" />
          對戰紀錄
        </h3>
        <div className="flex-1 overflow-y-auto space-y-1">
          {bs.turnLog.length === 0 ? (
            <p className="text-emerald-800 text-xs">尚無紀錄</p>
          ) : (
            [...bs.turnLog].reverse().slice(0, 100).map((entry, i) => (
              <div key={i} className={`text-xs border-l-2 pl-2 py-0.5 ${entry.player === 0 ? 'border-blue-700/60' : 'border-red-700/60'}`}>
                <span className={`font-medium ${entry.player === 0 ? 'text-blue-400' : 'text-red-400'}`}>
                  [{entry.turn}]
                </span>{' '}
                <span className="text-emerald-50">{entry.action}</span>
                {entry.details && <p className="text-emerald-700/80 mt-0.5">{entry.details}</p>}
              </div>
            ))
          )}
        </div>
      </div>

      {showPlayerDiscard && (
        <DiscardModal title="你的棄牌堆" cards={bs.player.discardPile} onClose={() => setShowPlayerDiscard(false)} />
      )}

      {showOpponentDiscard && (
        <DiscardModal title="對手棄牌堆" cards={bs.opponent.discardPile} onClose={() => setShowOpponentDiscard(false)} />
      )}

      {/* Opponent hand modal — hand contents are genuinely hidden info, so this shows face-down
          placeholders (just the count) rather than pretending to reveal anything. */}
      {showOpponentHand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setShowOpponentHand(false)}>
          <div
            className="bg-[radial-gradient(ellipse_at_top,#14532d_0%,#052e16_60%,#031f0f_100%)] border border-emerald-800/60 rounded-2xl p-5 max-w-sm w-full mx-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold flex items-center gap-1.5">
                <IconCards className="w-4 h-4" />
                對手手牌
              </h3>
              <button
                onClick={() => setShowOpponentHand(false)}
                aria-label="關閉"
                className="w-11 h-11 -m-2 flex items-center justify-center rounded-full text-emerald-500/70 hover:text-emerald-200 hover:bg-white/5 transition-colors"
              >
                <IconX className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {Array.from({ length: bs.opponent.handCount }, (_, i) => (
                <div key={i} className="w-10 h-14 rounded-md bg-gradient-to-br from-slate-700 to-slate-900 border border-slate-600 shadow-inner" />
              ))}
            </div>
            <p className="text-emerald-700/70 text-xs">對手有 {bs.opponent.handCount} 張手牌（內容為隱藏資訊）</p>
          </div>
        </div>
      )}
    </div>
  );
}
