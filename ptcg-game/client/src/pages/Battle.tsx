import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDeckStore } from '../stores/deckStore';
import { useSettingsStore, type ZoomMode } from '../stores/settingsStore';
import { playSfx, setSfxEnabled, startBgm, stopBgm, type SfxName } from '../utils/sfx';
import { useCardStore } from '../stores/cardStore';
import { useGameStore, type SanitizedGameCard } from '../stores/gameStore';
import type { Card, LegalAction, PendingChoice, TurnAction } from '@ptcg/shared';
import { exportTurnLogAsJson, exportTurnLogAsText } from '../utils/exportLog';
import { CARD_IMAGE_FALLBACK, handleCardImgError } from '../utils/cardImageFallback';
import HpBar from '../components/HpBar';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import StatBox from '../components/StatBox';
import CardArtDetail from '../components/CardArtDetail';

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
const IconClock = (p: { className?: string }) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></Icon>;
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
        return <Badge key={i} icon={<IconComp className="w-2.5 h-2.5" />} label={style?.label ?? c} className={style?.cls} />;
      })}
    </div>
  );
}

/* ====================================================== */
/*  Card effect preview (hover popover)                    */
/* ====================================================== */

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
          <div className="p-3"><CardArtDetail card={card} variant="compact" /></div>
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
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-400/90 uppercase tracking-wider mb-1.5 pl-2 border-l-2 border-emerald-500/60">
      {icon}
      <span>{label}</span>
    </div>
  );
}

/* ====================================================== */
/*  HP Bar                                                */
/* ====================================================== */

/* ====================================================== */
/*  Helper: group legal moves by hand card                */
/* ====================================================== */

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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

/** Collapsible "查看牌庫剩餘全部" list — only ever populated (server-side) for the searching
 * player's own deck, so showing it here is equivalent to a physical player fanning out their deck. */
function DeckPreviewDisclosure({ cards }: { cards: Card[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-emerald-400/80 hover:text-emerald-300 transition-colors underline decoration-dotted"
      >
        {open ? '收起牌庫其餘內容' : `查看牌庫剩餘全部（${cards.length} 張）`}
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-2 bg-black/20 rounded-lg border border-emerald-900/40">
          {cards.map((c, i) => (
            <HoverPreview key={`${c.id}-${i}`} card={c} placement="above">
              <div className="w-10 h-14 rounded border border-slate-700 overflow-hidden bg-slate-900">
                <img src={c.images.small} alt={c.name} onError={handleCardImgError} className="w-full h-full object-contain" />
              </div>
            </HoverPreview>
          ))}
        </div>
      )}
    </div>
  );
}

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
  // Single-pick-but-optional choices (e.g. Ultra Ball's search step, minCount 0 / maxCount 1)
  // have no pool item to click for "don't take anything" — that's a real, separate legal move
  // with an empty selection, surfaced as its own button below the grid.
  const skipMove = !isMultiSelect
    ? moves.find(m => ((m.payload?.selection as string[] | undefined) || []).length === 0)
    : undefined;

  const countLabel = choice.count !== undefined
    ? `選${choice.count}張`
    : minCount > 0 ? `選${minCount}~${maxCount}張` : `最多選${maxCount}張`;

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {isMultiSelect && <p className="text-xs text-slate-400">{countLabel}・已選{checked.size}張</p>}
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
          {checked.size === 0 && minCount === 0 ? '不選（跳過）' : `確定（${checked.size}張）`}
        </button>
      )}
      {isMultiSelect && checked.size > 0 && countOk && !matchedMove && (
        <p className="text-red-400 text-xs text-center">此組合暫時無法使用，請重新選擇</p>
      )}
      {!isMultiSelect && minCount === 0 && skipMove && (
        <button
          onClick={() => onSubmit(skipMove)}
          disabled={loading}
          className="w-full py-2 bg-slate-700 text-slate-200 rounded-lg text-sm font-medium hover:bg-slate-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
        >
          不選（跳過）
        </button>
      )}
    </div>
  );
}

/** Lets keyboard users (Tab + Enter/Space) drive the same board/hand click targets that mouse
 * users click directly — the whole targeting redesign is built on real elements with onClick,
 * so this is the one addition needed for keyboard parity rather than a separate input path. */
const keyActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
};

/** Was previously defined inside Battle() — a component defined inside another component's
 * render body gets a new function identity every render, which React treats as an entirely
 * different component type, forcing a full unmount/remount (and replaying animate-card-enter)
 * on every Pokémon card every time Battle re-renders — which happens once a second just from
 * the clockNow tick. Hoisting to module scope keeps the type stable across renders. */
function PokemonCardView({
  card, size = 'normal', showHp = true, onClick, targetable, picked, previewPlacement = 'above', shake = false, loading, onShowDetail, side = 'player',
}: {
  card: SanitizedGameCard;
  size?: 'normal' | 'small';
  showHp?: boolean;
  onClick?: () => void;
  /** Tints the card's drop shadow blue (player) or red (opponent) — a cheap, purely decorative
   * way to reinforce whose side a card belongs to at a glance, echoing the same blue/red used for
   * turn indicators and turn-log entries elsewhere on this screen. Never used for anything a
   * player needs to *read* precisely (that's still the "你"/"對手" labels and board position). */
  side?: 'player' | 'opponent';
  /** This Pokémon is a legal click-target for whatever's currently being resolved (attaching
   * energy, evolving, or a server-forced pendingChoice) — gets a pulsing highlight so the
   * valid options read at a glance instead of needing a separate list to cross-reference. */
  targetable?: boolean;
  /** Provisionally selected as part of a multi-pick targeting choice (not yet confirmed). */
  picked?: boolean;
  previewPlacement?: 'above' | 'below';
  shake?: boolean;
  /** Whether a move submission is in flight — disables/dims the card the same way the rest of
   * the board does while waiting on the server. */
  loading: boolean;
  /** Opens the full-detail modal for this card (the "i" button) — passed in since it's
   * `setFullDetailCard` from Battle's own state. */
  onShowDetail: (card: SanitizedGameCard) => void;
}) {
  const cd = card.cardData;
  // Server-computed effective max HP (includes Tool/passive-ability bonuses), NOT the printed
  // cardData.hp — see SanitizedGameCard.maxHp. Falls back to printed HP only for safety.
  const hp = card.maxHp || (cd.hp ? parseInt(cd.hp) : 0);
  const remainingHp = Math.max(0, hp - card.damage);
  const isW = size === 'small';
  // Width scales up across breakpoints (phone -> desktop); height is no longer a separate
  // per-breakpoint class — the image box uses a fixed card aspect-ratio instead, so it can never
  // drift out of sync with the width classes the way two parallel breakpoint lists could.
  const wCls = isW ? 'w-14 sm:w-16 md:w-20 lg:w-24' : 'w-20 sm:w-28 md:w-32 lg:w-36';
  const ring = picked
    ? 'ring-2 ring-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.6)]'
    : targetable
    ? 'ring-2 ring-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.6)] animate-pulse'
    : '';

  return (
    <div
      className={`flex-shrink-0 flex flex-col items-center gap-1 cursor-pointer transition-all animate-card-enter ${wCls} ${ring ? 'rounded-xl' : ''} ${ring}
        ${onClick ? 'hover:-translate-y-1 focus-visible:-translate-y-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 focus-visible:outline-offset-2 rounded-xl' : ''} ${shake ? 'animate-shake' : ''}
        ${onClick && loading ? 'opacity-40 !cursor-not-allowed' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !loading ? 0 : undefined}
      onKeyDown={onClick ? keyActivate(onClick) : undefined}
    >
      <HoverPreview card={cd} placement={previewPlacement}>
        <div className={`relative w-full aspect-[63/88] bg-slate-900 border-2 border-slate-600/80 ring-1 ring-inset ring-white/10 rounded-xl overflow-hidden hover:border-emerald-400 transition-colors shadow-lg ${side === 'opponent' ? 'shadow-red-950/50' : 'shadow-blue-950/50'}`}>
          <img src={cd.images.small} alt={cd.name} onError={handleCardImgError} className="w-full h-full object-contain" />
          <button
            onClick={(e) => { e.stopPropagation(); onShowDetail(card); }}
            aria-label="查看詳情"
            className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-emerald-300 hover:bg-black/80 hover:text-emerald-100 transition-colors text-[10px] font-bold"
          >
            i
          </button>
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

/** TurnAction.action is an internal identifier (draw_card, resolve_choice, ko, …) that the log
 *  panel was rendering straight to screen — English snake_case in an otherwise Chinese UI.
 *  Unknown keys fall through to the raw value so a newly added action is visible rather than
 *  silently blank. */
const ACTION_LABELS: Record<string, string> = {
  coin_flip: '擲硬幣', choose_first: '選擇先後攻', choose_active: '選擇出戰寶可夢',
  mulligan: '重抽', mulligan_reveal: '公開手牌', mulligan_bonus_draw: '重抽補償抽牌',
  mulligan_bonus_bench: '重抽補償上場',
  draw_card: '抽牌', play_pokemon: '放置寶可夢', evolve: '進化', attach_energy: '附加能量',
  play_trainer: '使出訓練家卡', use_ability: '使用特性', ability: '特性',
  resolve_choice: '選擇結算', retreat: '撤退', discard_fossil: '丟棄化石',
  attack: '攻擊', ko: '昏厥', end_turn: '結束回合', forfeit: '投降',
};
function PrizeDisplay({ count, label }: { count: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5" title={`剩餘獎賞卡 ${count}/6`}>
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
    <Modal onClose={onClose} title={<><IconTrash className="w-4 h-4" />{title}（{cards.length} 張）</>}>
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
    </Modal>
  );
}

/** Shared turn-log entry list — used both by the persistent desktop sidebar (`lg` and up) and the
 * mobile/tablet drawer Modal (below `lg`), so the two surfaces render from one place and can
 * never drift out of sync with each other. */
function TurnLogEntries({ turnLog }: { turnLog: TurnAction[] }) {
  if (turnLog.length === 0) return <p className="text-emerald-800 text-xs">尚無紀錄</p>;
  return (
    <div className="space-y-1">
      {[...turnLog].reverse().slice(0, 100).map((entry, i) => (
        <div key={i} className={`text-xs border-l-2 pl-2 py-0.5 pr-1 rounded-r-md hover:bg-white/5 transition-colors ${entry.player === 0 ? 'border-blue-700/60' : 'border-red-700/60'}`}>
          <span className={`font-medium ${entry.player === 0 ? 'text-blue-400' : 'text-red-400'}`}>
            [{entry.turn}]
          </span>{' '}
          <span className="text-emerald-50">{ACTION_LABELS[entry.action] ?? entry.action}</span>
          {entry.details && <p className="text-emerald-700/80 mt-0.5">{entry.details}</p>}
        </div>
      ))}
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
    createBattle, submitMove, undo, leaveGame,
  } = useGameStore();

  const [selectedDeckId, setSelectedDeckId] = useState('');
  const [selectedDeckIdB, setSelectedDeckIdB] = useState('');
  const [battleMode, setBattleMode] = useState<'ai' | 'local'>('ai');
  // Local 2P hotseat: when the acting seat changes, cover the board until the next player
  // confirms they have the device — otherwise their fresh hand is visible to the previous seat.
  const [handoffPending, setHandoffPending] = useState(false);
  const prevViewerRef = useRef<number | null>(null);
  const { zoom, sfx, bgm, setZoom, setSfx, setBgm } = useSettingsStore();
  const [showSettings, setShowSettings] = useState(false);
  const [mulliganRevealDismissed, setMulliganRevealDismissed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);
  useEffect(() => { setSfxEnabled(sfx); }, [sfx]);
  useEffect(() => {
    if (bgm && battleState && battleState.winner === null) startBgm();
    else stopBgm();
    return () => stopBgm();
  }, [bgm, !!battleState, battleState?.winner]);
  // Sounds are driven off turnLog growth (one place, every engine action lands there) instead
  // of per-button handlers. Only the newest few entries fire so a big multi-effect turn (or the
  // AI's whole turn arriving in one response) doesn't queue a long noise burst.
  const sfxLogLenRef = useRef<number | null>(null);
  const prevWinnerRef = useRef<number | null>(null);
  useEffect(() => {
    const log = battleState?.turnLog;
    if (!log) { sfxLogLenRef.current = null; return; }
    const prev = sfxLogLenRef.current;
    sfxLogLenRef.current = log.length;
    if (prev === null || log.length <= prev) return;
    const SOUND_MAP: Record<string, SfxName> = {
      attack: 'attack', ko: 'ko', play_pokemon: 'card', evolve: 'evolve',
      attach_energy: 'energy', play_trainer: 'trainer', ability: 'trainer',
      use_ability: 'trainer', retreat: 'card', coin_flip: 'coin', end_turn: 'turn',
      choose_active: 'card',
    };
    const fresh = log.slice(prev).map(e => SOUND_MAP[e.action]).filter(Boolean).slice(-3);
    fresh.forEach((name, i) => setTimeout(() => playSfx(name), i * 180));
  }, [battleState?.turnLog]);
  useEffect(() => {
    const w = battleState?.winner ?? null;
    if (w !== null && prevWinnerRef.current === null && battleState) {
      const viewerSeat = battleState.mode === 'local' ? battleState.viewerIndex : 0;
      playSfx(w === viewerSeat ? 'victory' : 'defeat');
    }
    prevWinnerRef.current = w;
  }, [battleState?.winner]);

  /* Drag & drop: dragging a hand card highlights every legal destination derived from the
   * same legalMoves the click flow uses — dropping just submits that move, so DnD can never
   * do anything the click path couldn't. Click interaction is fully preserved. */
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const dragMoves = useMemo(() => {
    if (!draggingCardId || !battleState) return [];
    return battleState.legalMoves.filter(m =>
      m.payload?.cardId === draggingCardId &&
      ['play_pokemon', 'evolve_pokemon', 'attach_energy', 'choose_active'].includes(m.type)
    );
  }, [draggingCardId, battleState]);
  const dragTargetIds = useMemo(
    () => new Set(dragMoves.map(m => m.payload?.targetId).filter((t): t is string => typeof t === 'string')),
    [dragMoves],
  );
  const dragBenchMove = dragMoves.find(m => m.type === 'play_pokemon');
  const dragActiveSlotMove = dragMoves.find(m => m.type === 'choose_active');
  const handleDropOn = (key: string) => {
    const move = key === 'bench-empty' ? dragBenchMove
      : key === 'active-slot' ? dragActiveSlotMove
      : dragMoves.find(m => m.payload?.targetId === key);
    setDraggingCardId(null);
    if (move) handleSubmitMove(move);
  };
  const dropZoneProps = (key: string, valid: boolean) => valid ? {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); handleDropOn(key); },
  } : {};
  const dropRing = (valid: boolean) => valid ? ' ring-2 ring-yellow-400 rounded-xl animate-pulse' : '';
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal');
  const [hardModeAvailable, setHardModeAvailable] = useState(false);
  const [showPlayerDiscard, setShowPlayerDiscard] = useState(false);
  const [showOpponentDiscard, setShowOpponentDiscard] = useState(false);
  const [showOpponentHand, setShowOpponentHand] = useState(false);
  const [showTurnLog, setShowTurnLog] = useState(false);
  const [fullDetailCard, setFullDetailCard] = useState<SanitizedGameCard | null>(null);
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
    fetch('/api/ai').then(r => r.json()).then(d => setHardModeAvailable(!!d.hard)).catch(() => {});
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
        // Read the structured breakdown, not the log prose. This used to regex the English
        // sentence ("... for 70 damage to ..."), which silently stopped producing a floater the
        // moment the log was translated — and an attack that visibly does nothing is exactly
        // what a player reports as "the attack dealt no damage".
        const dealt = entry.damageDetail?.finalDamage;
        if (typeof dealt === 'number' && dealt > 0) {
          additions.push({ id: floaterIdRef.current++, side: entry.player === 0 ? 'opponent' : 'player', text: `-${dealt}`, kind: 'damage' });
        }
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
      m.type === 'draw_card' || m.type === 'retreat' || m.type === 'end_turn' || m.type === 'attack' || m.type === 'use_stadium_action'
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

  const viewerIndex = battleState?.viewerIndex ?? 0;
  useEffect(() => {
    if (battleState?.mode !== 'local' || battleState.winner !== null) { prevViewerRef.current = viewerIndex; return; }
    if (prevViewerRef.current !== null && prevViewerRef.current !== viewerIndex) setHandoffPending(true);
    prevViewerRef.current = viewerIndex;
  }, [viewerIndex, battleState?.mode, battleState?.winner]);

  const handleStartBattle = useCallback(async () => {
    if (!selectedDeckId) return;
    const deck = selectableDecks.find(d => d.id === selectedDeckId);
    if (!deck) return;
    const deckB = battleMode === 'local' ? selectableDecks.find(d => d.id === selectedDeckIdB) : undefined;
    if (battleMode === 'local' && !deckB) return;
    prevViewerRef.current = null;
    setHandoffPending(false);
    setMulliganRevealDismissed(false);
    try {
      await createBattle(deck.cards, deckB?.cards, difficulty, battleMode);
    } catch { /* handled by store */ }
  }, [selectedDeckId, selectedDeckIdB, battleMode, selectableDecks, createBattle, difficulty]);

  /** 重新開局: same deck, same difficulty, brand-new session (fresh coin flip and hands).
   * No negotiation needed vs an AI — mid-game it just asks for confirmation first. */
  const handleRematch = useCallback(async (needConfirm: boolean) => {
    if (needConfirm && !window.confirm('重新開局？將捨棄目前的對局，以同一副牌組重新開始。')) return;
    await handleStartBattle();
  }, [handleStartBattle]);

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

  // Purely cosmetic timers — never read by move submission or any legality check, just wall-clock
  // display state local to this component. `clockNow` ticks once a second to force a re-render.
  const battleStartRef = useRef<number | null>(null);
  const turnStartRef = useRef<number>(Date.now());
  const lastSeenTurnRef = useRef<number | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!bs) return;
    if (battleStartRef.current === null) battleStartRef.current = bs.turnLog[0]?.timestamp ?? Date.now();
    if (lastSeenTurnRef.current !== bs.turn) {
      lastSeenTurnRef.current = bs.turn;
      turnStartRef.current = Date.now();
    }
  }, [bs?.turn, bs?.turnLog]);

  const phaseLabels: Record<string, string> = {
    choose_first: '選擇先攻後攻', choose_active: '選擇出戰寶可夢', draw: '抽牌階段', main: '主要階段', attack: '攻擊階段', end: '結束階段',
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
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,theme(colors.battle.felt.from)_0%,theme(colors.battle.felt.via)_55%,theme(colors.battle.felt.to)_100%)]" />
        <div
          className="absolute inset-0 opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        {/* Vignette: darkens the rim so the felt reads as a lit table rather than a flat tint —
            purely decorative, pointer-events-none, layered inside the already-relative/overflow-
            hidden wrapper above. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)' }}
        />
        <div className="relative bg-slate-900/80 backdrop-blur border border-emerald-800/50 ring-1 ring-inset ring-white/10 rounded-2xl p-6 sm:p-8 w-full max-w-md shadow-2xl">
          <div className="flex items-center justify-center gap-2 mb-1">
            <IconSword className="w-5 h-5 text-emerald-400" />
            <h1 className="text-2xl font-bold bg-gradient-to-b from-emerald-200 to-emerald-400 bg-clip-text text-transparent tracking-wide">AI 對戰練習</h1>
          </div>
          <p className="text-center text-emerald-500/70 text-xs mb-6">挑選一副牌組，開始練習對局</p>
          <div className="space-y-4">
            <div className="flex gap-2">
              {([['ai', '🤖 對戰 AI'], ['local', '👥 本機雙人']] as const).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setBattleMode(m)}
                  className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                    battleMode === m ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">{battleMode === 'local' ? '玩家 1 牌組' : '選擇你的牌組'}</label>
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
            {battleMode === 'local' && (
              <div>
                <label className="text-sm text-slate-400 mb-1.5 block">玩家 2 牌組</label>
                <select
                  value={selectedDeckIdB}
                  onChange={(e) => setSelectedDeckIdB(e.target.value)}
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
              </div>
            )}
            {battleMode === 'ai' && (
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">AI 難度</label>
              <select
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as 'easy' | 'normal' | 'hard')}
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-slate-100 focus:outline-none focus:border-emerald-500"
              >
                <option value="easy">簡單（隨機出牌）</option>
                <option value="normal">普通（規則式 AI）</option>
                <option value="hard" disabled={!hardModeAvailable}>
                  困難（Claude AI{hardModeAvailable ? '' : '・伺服器未設定金鑰，暫不可用'}）
                </option>
              </select>
            </div>
            )}
            <button
              onClick={handleStartBattle}
              disabled={!selectedDeckId || (battleMode === 'local' && !selectedDeckIdB) || loading}
              className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-lg shadow-emerald-900/40 ring-1 ring-inset ring-white/15"
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
  /*  Main Battle Layout      */
  /* ======================== */

  const isOver = bs.winner !== null;
  // bs.winner is an absolute seat index; the panels are viewer-relative.
  const viewerWon = bs.winner === (bs.mode === 'local' ? viewerIndex : 0);

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

  const zoomFactor = zoom === 'auto' ? 1 : zoom / 100;
  return (
    <div
      className="flex flex-col lg:flex-row gap-2 lg:gap-3 min-h-0"
      style={{ zoom: zoomFactor, height: `calc((100vh - 7rem) / ${zoomFactor})` }}
    >

      {/* Pending choice modal: only for choices with no on-field/in-hand representation (deck
          search results, "pick an energy type", a bare confirm). Choices that ARE a Pokémon
          already in play or a card already in hand are resolved by clicking the real thing
          directly instead — see boardTargeting/handTargeting and their banner further below. */}
      {!isOver && bs.pendingChoice && !boardTargeting && !handTargeting && (() => {
        const choice = bs.pendingChoice;
        // PendingChoicePicker already renders single-pick choices correctly (card-art tiles,
        // auto-submit on click) — route through it whenever there's a concrete option list to
        // show, not just for multi-pick. The plain description-text list is only a fallback for
        // choices with no candidate list at all (e.g. a bare confirm).
        const hasOptionList = !!choice.options && choice.options.length > 0;
        return (
          <Modal backdropClassName="bg-black/40" title="卡牌效果" maxWidthClassName="max-w-lg">
            <p className="text-emerald-100/90 text-sm mb-4">{choice.prompt}</p>
            {choice.remainingDeckPreview && choice.remainingDeckPreview.length > 0 && (
              <DeckPreviewDisclosure cards={choice.remainingDeckPreview} />
            )}
            {hasOptionList ? (
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
          </Modal>
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
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-2 max-w-[92vw] bg-slate-900/95 border border-sky-500/50 rounded-full pl-4 pr-1.5 py-1.5 shadow-2xl shadow-black/50 animate-result-pop">
          <span className="text-sky-200 text-xs font-medium break-words">{activeTargeting.prompt}</span>
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

      {/* Fixed-position overlays for forced one-shot prompts (game over, device handoff,
          choose-first, choose-active, draw). These must NOT be nested inside the board panel's
          `backdrop-blur-sm` "Middle: Actions" wrapper further below — `backdrop-filter` makes
          that wrapper the containing block AND stacking context for `position: fixed`
          descendants, so a `z-50` Modal nested inside it only outranks siblings *within that
          same wrapper*; a later, unrelated sibling elsewhere in the board (e.g. the Player-area
          panel) still paints on top of the whole thing and silently eats every click. Keeping
          these overlays as direct children of the top-level layout root sidesteps that trap
          entirely — confirmed via a real click landing on the Player-area header div instead of
          the "先攻" button before this was moved out. */}
      {handoffPending && !isOver && (
        <div className="fixed inset-0 z-[70] bg-slate-950 flex flex-col items-center justify-center gap-6">
          <div className="text-6xl">🔄</div>
          <p className="text-xl font-bold text-slate-100">請將裝置交給 玩家 {viewerIndex + 1}</p>
          <p className="text-sm text-slate-400">為避免看到對方手牌，畫面已遮蔽</p>
          <button
            onClick={() => setHandoffPending(false)}
            className="px-8 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg transition-colors"
          >
            我是玩家 {viewerIndex + 1}，繼續
          </button>
        </div>
      )}
      {isOver && (
        <Modal maxWidthClassName="max-w-md">
          <div className="flex flex-col items-center animate-result-pop">
            <div className={`text-6xl mb-2 ${viewerWon ? 'animate-glow-pulse' : 'opacity-60 grayscale'}`}>
              {viewerWon ? '🏆' : '💀'}
            </div>
            <p
              className={`text-3xl font-black tracking-wide mb-1 ${
                viewerWon
                  ? 'bg-gradient-to-b from-yellow-200 to-yellow-500 bg-clip-text text-transparent drop-shadow-[0_2px_16px_rgba(250,204,21,0.45)]'
                  : 'text-slate-400'
              }`}
            >
              {bs.mode === 'local' ? `玩家 ${(bs.winner ?? 0) + 1} 獲勝！` : viewerWon ? '勝利！' : '戰敗'}
            </p>
            <p className="text-xs text-slate-500 mb-5">{(bs.winReason && winReasonLabels[bs.winReason]) || bs.winReason}</p>
            <div className="flex items-center gap-8 mb-6">
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-xs font-medium text-blue-300">{bs.mode === 'local' ? `玩家 ${viewerIndex + 1}` : '你'}</span>
                <PrizeDisplay count={bs.player.prizes} label="" />
                {/* `prizes` is how many are LEFT (that's what the pips show, and what the
                    in-battle board uses); "已奪" is how many were taken, so it has to be the
                    complement. Printing the raw field under this label told a player who took
                    none that they had taken all six. */}
                <span className="text-[10px] text-slate-500">已奪 {6 - bs.player.prizes}/6</span>
              </div>
              <div className="w-px h-10 bg-emerald-900/60" />
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-xs font-medium text-red-300">{bs.mode === 'local' ? `玩家 ${2 - viewerIndex}` : '對手'}</span>
                <PrizeDisplay count={bs.opponent.prizes} label="" />
                <span className="text-[10px] text-slate-500">已奪 {6 - bs.opponent.prizes}/6</span>
              </div>
            </div>
            <button
              onClick={handleRetry}
              className="px-8 py-2.5 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-xl font-medium hover:from-emerald-400 hover:to-emerald-600 transition-colors shadow-lg shadow-emerald-950/50"
            >
              返回大廳
            </button>
            <button
              onClick={() => handleRematch(false)}
              className="mt-2 px-8 py-2.5 bg-gradient-to-b from-sky-500 to-sky-700 text-white rounded-xl font-medium hover:from-sky-400 hover:to-sky-600 transition-colors shadow-lg shadow-sky-950/50"
            >
              🔄 再來一場
            </button>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => exportTurnLogAsText(bs.turnLog)}
                className="px-3 py-1.5 text-xs bg-black/30 border border-emerald-800/60 text-emerald-300 rounded-lg hover:bg-black/50 transition-colors"
              >
                匯出紀錄 (.txt)
              </button>
              <button
                onClick={() => exportTurnLogAsJson(bs.turnLog)}
                className="px-3 py-1.5 text-xs bg-black/30 border border-emerald-800/60 text-emerald-300 rounded-lg hover:bg-black/50 transition-colors"
              >
                匯出紀錄 (.json)
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Coin-flip won by the player: real rules let the winner choose first or second. */}
      {!isOver && bs.isPlayerTurn && bs.phase === 'choose_first' && (
        <Modal maxWidthClassName="max-w-md">
          <div className="flex flex-col items-center gap-4 text-center animate-result-pop">
            <div className="text-5xl">🪙</div>
            <p className="text-lg font-semibold text-white">你贏得擲硬幣！要先攻還是後攻？</p>
            <p className="text-xs text-slate-400 -mt-3">先攻的第一回合不能攻擊、進化、使用支援者</p>
            <div className="flex gap-4">
              {battleState.legalMoves.filter(m => m.type === 'choose_first').map((m, i) => (
                <button
                  key={i}
                  onClick={() => handleSubmitMove(m)}
                  disabled={loading}
                  className="px-8 py-3 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-xl font-bold text-lg hover:from-emerald-400 hover:to-emerald-600 transition-colors shadow-lg shadow-emerald-950/50 disabled:opacity-40"
                >
                  {m.payload?.goFirst ? '⚡ 先攻' : '🛡️ 後攻'}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Opening hand is dealt; pick which Basic Pokémon starts as Active */}
      {!isOver && bs.isPlayerTurn && bs.phase === 'choose_active' && (
        <Modal maxWidthClassName="max-w-lg">
          <div className="flex flex-col items-center gap-4 text-center">
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
                    <div className="w-16 sm:w-20 aspect-[63/88] bg-slate-900 border-2 border-emerald-600/60 rounded-lg overflow-hidden ring-1 ring-inset ring-white/10 group-hover:border-emerald-400 group-hover:-translate-y-1 transition-all shadow-lg shadow-emerald-950/50">
                      <img src={cardData.images.small} alt={cardData.name} onError={handleCardImgError} className="w-full h-full object-contain" />
                    </div>
                    <span className="text-xs text-slate-200 font-medium max-w-20 truncate">{cardData.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Modal>
      )}

      {/* `!bs.pendingChoice` matters here: a KO'd Active is replaced via a same-player
          pendingChoice (`select_bench_pokemon`, see promoteActiveIfNeeded) resolved by clicking
          the bench card directly on the board (the non-blocking `activeTargeting` banner further
          up) — not by a phase change away from 'draw'. Without this guard the draw modal's
          opaque backdrop sat on top of the board and silently blocked that click, even though
          `draw_card` isn't even a legal move yet (the server's getLegalMoves answers a pending
          choice before it ever looks at phase). Pending-choice replacement must resolve first. */}
      {!isOver && bs.isPlayerTurn && bs.phase === 'draw' && !bs.pendingChoice && (
        <Modal maxWidthClassName="max-w-xs">
          <div className="flex items-center justify-center">
            <button
              onClick={() => {
                const drawMove = quickActions.find(m => m.type === 'draw_card');
                if (drawMove) handleSubmitMove(drawMove);
              }}
              disabled={loading}
              className="px-8 py-4 bg-gradient-to-b from-emerald-500 to-emerald-700 text-white rounded-xl text-lg font-medium hover:from-emerald-400 hover:to-emerald-600 transition-colors shadow-lg shadow-emerald-950/50 ring-1 ring-inset ring-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              抽牌
            </button>
          </div>
        </Modal>
      )}

      {/* Left column: battlefield — one continuous felt board instead of stacked boxed panels */}
      <div className="flex-1 flex flex-col min-h-0 rounded-2xl overflow-hidden border border-emerald-900/60 shadow-2xl relative bg-[radial-gradient(ellipse_at_top,theme(colors.battle.felt.from)_0%,theme(colors.battle.felt.via)_55%,theme(colors.battle.felt.to)_100%)]">
        <div
          className="absolute inset-0 opacity-[0.05] pointer-events-none"
          style={{
            backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.45) 100%)' }}
        />

        {/* Inner scroll wrapper: the opponent/player rows are flex-shrink-0 (sized to their
            board-slot content, never compressed) and the outer panel is clamped to exactly the
            viewport height, so on shorter/medium screens the middle actions row (Main/Attack
            phase's attack/retreat/end-turn buttons, hand cards) had nowhere left to go and
            silently collapsed to ~0px — invisible and unclickable, not just cramped. Scrolling
            this inner wrapper instead of clipping via the outer `overflow-hidden` means that
            content degrades to "scroll to see it" instead of "doesn't exist"; kept separate from
            the outer container so the felt gradient/vignette backgrounds above stay pinned
            instead of scrolling away with the content. */}
        <div className="relative flex-1 flex flex-col min-h-0 overflow-y-auto">

        {/* Top status bar: turn/phase + legal-action availability at a glance. `flex-wrap` is a
            safety net (this bar sits inside a board wrapper with `overflow-hidden`, so anything
            that didn't fit used to get silently clipped rather than visibly wrapping); the
            lowest-value info (timers, and hand counts that are already shown as StatBoxes further
            down) hides below `sm` instead of contributing to that overflow. */}
        <div className="relative flex-shrink-0 flex flex-wrap items-center justify-between gap-y-1 px-2 sm:px-3 py-1.5 bg-black/30 backdrop-blur-sm border-b border-emerald-900/50">
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button onClick={leaveGame} className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors mr-0.5 sm:mr-1">
              <IconArrowLeft className="w-3.5 h-3.5" />
              離開
            </button>
            <button
              onClick={() => undo()}
              disabled={loading || !bs.canUndo || bs.winner !== null}
              title="悔棋：回到你上一步行動之前（含其後的 AI 回合）"
              className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors mr-1 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              ↩ 悔棋
            </button>
            <button
              onClick={() => handleRematch(bs.winner === null)}
              disabled={loading}
              title="以同牌組、同難度重新開始一場新對局"
              className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors mr-1 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              🔄 重開
            </button>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${bs.isPlayerTurn ? 'bg-green-900/60 text-green-300 border border-green-700/60 shadow-[0_0_8px_rgba(34,197,94,0.45)]' : 'bg-red-900/60 text-red-300 border border-red-700/60'}`}>
              {bs.mode === 'local' ? `玩家 ${(bs.viewerIndex ?? 0) + 1} 的回合` : bs.isPlayerTurn ? '你的回合' : '對手回合'}
            </span>
            <span className="text-xs text-slate-400">回合 {bs.turn}</span>
            <span className="px-1.5 py-0.5 rounded bg-slate-700/80 text-[11px] text-slate-300 font-medium">
              {phaseLabels[bs.phase] || bs.phase}
            </span>
            {loading && (
              <span className="flex items-center gap-1 text-[11px] text-sky-400/80">
                <span className="w-2.5 h-2.5 rounded-full border-2 border-sky-400/40 border-t-sky-400 animate-spin" />
                <span className="hidden sm:inline">傳送中…</span>
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
          <div className="flex items-center gap-1.5 sm:gap-2">
            <span className="hidden sm:flex text-[11px] text-slate-500 items-center gap-2">
              {!isOver && (
                <span className="flex items-center gap-1 tabular-nums" title="本回合已進行時間（純顯示，不影響回合判定）">
                  <IconClock className="w-3 h-3" />
                  {formatDuration(clockNow - turnStartRef.current)}
                </span>
              )}
              <span className="tabular-nums" title="對戰總時長（純顯示）">總計 {formatDuration(clockNow - (battleStartRef.current ?? clockNow))}</span>
              <span>對手手牌 {bs.opponent.handCount} · 你的手牌 {bs.player.hand.length}</span>
            </span>
            {/* Mobile/tablet-only entry point into the turn log — the persistent sidebar (see the
                right column further down) only exists at `lg` and up. */}
            <button
              onClick={() => setShowSettings(true)}
              aria-label="設定"
              title="設定：畫面縮放／音效"
              className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors"
            >
              ⚙
            </button>
            <button
              onClick={toggleFullscreen}
              aria-label="全螢幕"
              title={isFullscreen ? '離開全螢幕' : '全螢幕'}
              className="flex items-center gap-1 text-emerald-500/70 hover:text-emerald-300 text-xs transition-colors"
            >
              {isFullscreen ? '🡼' : '⛶'}
            </button>
            <button
              onClick={() => setShowTurnLog(true)}
              aria-label="查看對戰紀錄"
              className="lg:hidden flex items-center gap-1 px-1.5 py-1 rounded text-emerald-500/70 hover:text-emerald-300 hover:bg-white/5 transition-colors"
            >
              <IconScroll className="w-3.5 h-3.5" />
            </button>
          </div>
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
            </div>
            <div className="flex items-center gap-1.5">
              <StatBox value={bs.opponent.handCount} label="手牌" icon={<IconCards className="w-3 h-3" />} onClick={() => setShowOpponentHand(true)} colorClassName="bg-red-950/50 border-red-800/50 text-red-200" />
              <StatBox value={bs.opponent.discardCount} label="棄牌" icon={<IconTrash className="w-3 h-3" />} onClick={() => setShowOpponentDiscard(true)} colorClassName="bg-red-950/50 border-red-800/50 text-red-200" />
              <StatBox value={bs.opponent.deckCount} label="牌庫" colorClassName="bg-black/30 border-red-900/40 text-red-300/80" />
            </div>
          </div>

          {/* Active is pinned (flex-shrink-0); the bench strip scrolls horizontally below `sm`
              instead of shrinking 5 cards down to illegible size on a phone, then reverts to a
              normal centered, non-scrolling row at `sm` and up (matches the original desktop
              layout exactly). */}
          <div className="flex items-center gap-2 sm:gap-3 sm:justify-center">
            <div className="relative flex-shrink-0">
              {bs.opponent.active ? (
                <PokemonCardView
                  key="opponent-active"
                  card={bs.opponent.active}
                  size="normal"
                  showHp={true}
                  side="opponent"
                  previewPlacement="below"
                  loading={loading}
                  onShowDetail={setFullDetailCard}
                  shake={floaters.some(f => f.side === 'opponent' && f.kind === 'damage')}
                  {...targetProps(bs.opponent.active.id)}
                />
              ) : (
                <div className="w-20 sm:w-28 md:w-32 lg:w-36 aspect-[63/88] bg-black/20 border-2 border-dashed border-emerald-900/60 rounded-xl flex items-center justify-center flex-shrink-0">
                  <span className="text-emerald-600/80 text-[10px] sm:text-xs">無寶可夢</span>
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
            <div className="flex gap-1.5 sm:gap-2 overflow-x-auto sm:overflow-visible sm:flex-none min-w-0 flex-1 py-0.5">
              {Array.from({ length: Math.max(5, bs.opponent.bench.length) }, (_, i) => {
                const c = bs.opponent.bench[i];
                return c ? (
                  <PokemonCardView key={i} card={c} size="small" showHp={false} side="opponent" previewPlacement="below" loading={loading} onShowDetail={setFullDetailCard} {...targetProps(c.id)} />
                ) : (
                  <div key={i} className="w-14 sm:w-16 md:w-20 lg:w-24 aspect-[63/88] flex-shrink-0 bg-black/10 border border-dashed border-emerald-900/50 rounded-md flex items-center justify-center">
                    <span className="text-emerald-700/80 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Middle: Actions. `min-h-[130px]` guarantees room for at least the quick-action button
            row (attack/retreat/end-turn) even when the opponent/player rows above/below are at
            their full flex-shrink-0 size — the inner scroll wrapper above absorbs whatever
            overflow that reservation causes instead of this panel collapsing to ~0px again. */}
        <div className="relative bg-black/25 backdrop-blur-sm p-3 flex-1 min-h-[130px] flex flex-col">

          {/* Error display */}
          {error && (
            <div className="mb-2 p-2 bg-red-900/50 border border-red-700 rounded text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Waiting for AI */}
          {!isOver && !bs.isPlayerTurn && (
            <div className="flex-1 flex items-center justify-center gap-2 text-slate-400">
              <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-blue-500" />
              AI 思考中...
            </div>
          )}

          {/* Player actions: Main / Attack phase */}
          {!isOver && bs.isPlayerTurn && (bs.phase === 'main' || bs.phase === 'attack') && (
            <div className="flex-1 overflow-y-auto min-h-0">
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
                            className="px-3 py-2 bg-gradient-to-b from-red-600 to-red-800 text-white rounded-lg text-xs font-medium hover:from-red-500 hover:to-red-700 transition-colors flex items-center gap-1.5 shadow-md shadow-red-950/50 border border-red-500/30 ring-1 ring-inset ring-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
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
                      {quickActions.filter(m => m.type === 'use_stadium_action').map((m, i) => (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          disabled={loading}
                          className="px-3 py-2 bg-purple-800 text-white rounded-lg text-xs font-medium hover:bg-purple-700 transition-colors border border-purple-500/30 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <IconBuilding className="w-3.5 h-3.5" />
                          <span>{m.description}</span>
                        </button>
                      ))}
                      {quickActions.filter(m => m.type === 'end_turn').map((m, i) => (
                        <button
                          key={i}
                          onClick={() => handleSubmitMove(m)}
                          disabled={loading}
                          className="px-3 py-2 bg-slate-700 text-white rounded-lg text-xs font-medium hover:bg-slate-600 transition-colors ml-auto border border-slate-500/30 ring-1 ring-inset ring-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
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
                                  className={`w-12 sm:w-14 aspect-[63/88] rounded-lg transition-all object-contain border-2
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
            </div>
          )}
        </div>

        {/* Player area */}
        <div className="relative flex-shrink-0 p-2.5 border-t border-emerald-900/40">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-blue-300">你</span>
              <PrizeDisplay count={bs.player.prizes} label="" />
            </div>
            <div className="flex items-center gap-1.5">
              <StatBox value={bs.player.hand.length} label="手牌" icon={<IconCards className="w-3 h-3" />} colorClassName="bg-blue-950/50 border-blue-800/50 text-blue-200" />
              <StatBox value={bs.player.discardPile.length} label="棄牌" icon={<IconTrash className="w-3 h-3" />} onClick={() => setShowPlayerDiscard(true)} colorClassName="bg-blue-950/50 border-blue-800/50 text-blue-200" />
              <StatBox value={bs.player.deckCount} label="牌庫" colorClassName="bg-black/30 border-blue-900/40 text-blue-300/80" />
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 sm:justify-center mb-1.5">
            <div
              className={`relative flex-shrink-0${dropRing(!!bs.player.active && dragTargetIds.has(bs.player.active.id))}`}
              {...(bs.player.active ? dropZoneProps(bs.player.active.id, dragTargetIds.has(bs.player.active.id)) : dropZoneProps('active-slot', !!dragActiveSlotMove))}
            >
              {bs.player.active ? (
                <PokemonCardView
                  key="player-active"
                  card={bs.player.active}
                  size="normal"
                  showHp={true}
                  side="player"
                  loading={loading}
                  onShowDetail={setFullDetailCard}
                  shake={floaters.some(f => f.side === 'player' && f.kind === 'damage')}
                  {...targetProps(bs.player.active.id)}
                />
              ) : (
                <div
                  className={`w-20 sm:w-28 md:w-32 lg:w-36 aspect-[63/88] bg-black/20 border-2 border-dashed rounded-xl flex items-center justify-center flex-shrink-0${dropRing(!!dragActiveSlotMove)} ${
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
            <div className="flex gap-1.5 sm:gap-2 overflow-x-auto sm:overflow-visible sm:flex-none min-w-0 flex-1 py-0.5">
              {Array.from({ length: Math.max(5, bs.player.bench.length) }, (_, i) => {
                const c = bs.player.bench[i];
                return c ? (
                  <div key={i} className={`flex-shrink-0${dropRing(dragTargetIds.has(c.id))}`} {...dropZoneProps(c.id, dragTargetIds.has(c.id))}>
                    <PokemonCardView card={c} size="small" showHp={false} side="player" loading={loading} onShowDetail={setFullDetailCard} {...targetProps(c.id)} />
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`w-14 sm:w-16 md:w-20 lg:w-24 aspect-[63/88] flex-shrink-0 bg-black/10 border border-dashed border-emerald-900/50 rounded-md flex items-center justify-center${dropRing(!!dragBenchMove)}`}
                    {...dropZoneProps('bench-empty', !!dragBenchMove)}
                  >
                    <span className="text-emerald-700/80 text-xs">?</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Player hand row — doubles as the picker for a select_hand_cards pendingChoice (e.g.
              discarding for Ultra Ball): the actual cards here light up and toggle directly
              instead of a separate modal grid duplicating them. */}
          {/* `justify-start` on mobile, not `justify-center`: centering a flex row that's wider
              than its container clips the start of the overflow instead of just scrolling to it
              in some browsers — left-aligning avoids that gotcha for a hand of 7-8+ cards on a
              phone. Reverts to centered at `sm`+, where a typical hand size fits without scrolling. */}
          <div className="flex justify-start sm:justify-center gap-1.5 overflow-x-auto pb-1">
            {bs.player.hand.length === 0 ? (
              <div className="text-slate-600 text-xs py-2">手牌為空</div>
            ) : (
              bs.player.hand.map((card) => {
                const isTargetingSource = manualTargeting?.sourceCardId === card.id;
                const isHandTarget = !!handTargeting && targetIds.has(card.id);
                const isPicked = isHandTarget && pickedTargets.has(card.id);
                const isCurrentlyPlayable = !handTargeting && !manualTargeting && handCardActions.some(h => h.cardData.id === card.id);
                const ring = isTargetingSource
                  ? 'border-sky-400 -translate-y-2 shadow-lg shadow-sky-500/30'
                  : isPicked
                  ? 'border-emerald-400 -translate-y-1 shadow-lg shadow-emerald-500/40'
                  : isHandTarget
                  ? 'border-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.5)] animate-pulse'
                  : isCurrentlyPlayable
                  ? 'border-yellow-400 ring-2 ring-yellow-400/70'
                  : 'border-slate-600 hover:border-emerald-400';
                return (
                  <HoverPreview key={card.id} card={card} placement="above">
                    <div
                      className={`flex-shrink-0 w-14 sm:w-16 lg:w-[4.5rem] aspect-[63/88] bg-slate-900 border-2 rounded-lg overflow-hidden animate-card-enter ring-1 ring-inset ring-white/10
                        ${ring} transition-all shadow-lg shadow-black/40
                        ${loading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 focus-visible:outline-offset-2`}
                      onClick={() => (handTargeting ? handleTargetClick(card.id) : handleCardClick(card.id))}
                      role="button"
                      tabIndex={loading ? -1 : 0}
                      onKeyDown={keyActivate(() => (handTargeting ? handleTargetClick(card.id) : handleCardClick(card.id)))}
                      draggable={!loading && !handTargeting}
                      onDragStart={(e) => { setDraggingCardId(card.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); }}
                      onDragEnd={() => setDraggingCardId(null)}
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
      </div>

      {/* Right column: Turn log — a persistent sidebar at `lg` (1024px) and up. Below that it's
          secondary information reached via the header's log-icon button instead (rendered as a
          Modal drawer just below), since keeping a fixed 256px column always on-screen would eat
          too much of a phone's vertical space. */}
      <div className="hidden lg:flex lg:flex-col w-64 flex-shrink-0 bg-[radial-gradient(ellipse_at_top,theme(colors.battle.feltFrom)_0%,theme(colors.battle.felt.via)_55%,theme(colors.battle.felt.to)_100%)] border border-emerald-900/50 rounded-2xl p-3 min-h-0 shadow-xl">
        <h3 className="text-sm font-semibold text-emerald-100 mb-3 flex items-center gap-1.5 pb-2 border-b border-emerald-900/50 uppercase tracking-wider text-xs">
          <IconScroll className="w-4 h-4" />
          對戰紀錄
        </h3>
        <div className="flex-1 overflow-y-auto">
          <TurnLogEntries turnLog={bs.turnLog} />
        </div>
      </div>

      {/* Mobile/tablet turn-log drawer — same content as the sidebar above, opened from the
          header's log-icon button (that button is itself `lg:hidden`, so this and the sidebar
          are never both reachable at once). */}
      {showTurnLog && (
        <Modal
          onClose={() => setShowTurnLog(false)}
          title={<><IconScroll className="w-4 h-4" />對戰紀錄</>}
          maxWidthClassName="max-w-sm"
        >
          <TurnLogEntries turnLog={bs.turnLog} />
        </Modal>
      )}

      {showPlayerDiscard && (
        <DiscardModal title="你的棄牌堆" cards={bs.player.discardPile} onClose={() => setShowPlayerDiscard(false)} />
      )}

      {showOpponentDiscard && (
        <DiscardModal title="對手棄牌堆" cards={bs.opponent.discardPile} onClose={() => setShowOpponentDiscard(false)} />
      )}

      {!mulliganRevealDismissed && !isOver && (bs.mulliganReveals?.length ?? 0) > 0 && (bs.phase === 'choose_first' || bs.phase === 'choose_active') && (
        <Modal onClose={() => setMulliganRevealDismissed(true)} title={<>🃏 重抽公開手牌</>} maxWidthClassName="max-w-lg">
          <p className="text-sm text-slate-400 mb-3">起手無基礎寶可夢時必須公開手牌並重抽（正式規則）：</p>
          <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
            {bs.mulliganReveals.map((rv, i) => (
              <div key={i}>
                <p className="text-xs font-medium text-emerald-300 mb-1.5">
                  {bs.mode === 'local' ? `玩家 ${rv.player + 1}` : rv.player === viewerIndex ? '你' : '對手'} 第 {bs.mulliganReveals.slice(0, i + 1).filter(x => x.player === rv.player).length} 次重抽：
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {rv.cards.map((c, j) => (
                    c.image
                      ? <img key={j} src={c.image} alt={c.name} title={c.name} className="w-14 rounded-md border border-slate-600" loading="lazy" />
                      : <span key={j} className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-xs text-slate-300">{c.name}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => setMulliganRevealDismissed(true)}
            className="mt-4 w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors"
          >
            知道了
          </button>
        </Modal>
      )}

      {showSettings && (
        <Modal onClose={() => setShowSettings(false)} title={<>⚙ 設定</>} maxWidthClassName="max-w-sm">
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400 mb-1.5 block">畫面縮放</label>
              <div className="flex flex-wrap gap-1.5">
                {(['auto', 100, 90, 80, 70, 60] as ZoomMode[]).map(z => (
                  <button
                    key={z}
                    onClick={() => setZoom(z)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                      zoom === z ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    {z === 'auto' ? '自動' : `${z}%`}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">遊戲音效</span>
              <button
                onClick={() => setSfx(!sfx)}
                className={`w-11 h-6 rounded-full transition-colors relative ${sfx ? 'bg-emerald-600' : 'bg-slate-700'}`}
                aria-label="遊戲音效開關"
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${sfx ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">背景音樂</span>
              <button
                onClick={() => setBgm(!bgm)}
                className={`w-11 h-6 rounded-full transition-colors relative ${bgm ? 'bg-emerald-600' : 'bg-slate-700'}`}
                aria-label="背景音樂開關"
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${bgm ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Opponent hand modal — hand contents are genuinely hidden info, so this shows face-down
          placeholders (just the count) rather than pretending to reveal anything. */}
      {showOpponentHand && (
        <Modal
          onClose={() => setShowOpponentHand(false)}
          title={<><IconCards className="w-4 h-4" />對手手牌</>}
          maxWidthClassName="max-w-sm"
        >
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Array.from({ length: bs.opponent.handCount }, (_, i) => (
              <div key={i} className="w-10 h-14 rounded-md bg-gradient-to-br from-slate-700 to-slate-900 border border-slate-600 shadow-inner" />
            ))}
          </div>
          <p className="text-emerald-700/70 text-xs">對手有 {bs.opponent.handCount} 張手牌（內容為隱藏資訊）</p>
        </Modal>
      )}

      {fullDetailCard && (
        <Modal onClose={() => setFullDetailCard(null)} maxWidthClassName="max-w-3xl">
          <CardArtDetail
            card={fullDetailCard.cardData}
            variant="full"
            battleStatus={(() => {
              // Same rule as PokemonCardView: prefer the server's effective max HP so Tool /
              // passive-ability bonuses show here too, not the printed cardData.hp.
              const maxHp = fullDetailCard.maxHp || (fullDetailCard.cardData.hp ? parseInt(fullDetailCard.cardData.hp, 10) : 0);
              return maxHp ? {
                currentHp: Math.max(0, maxHp - fullDetailCard.damage),
                maxHp,
                statusNode: <StatusConditionBadges conditions={fullDetailCard.statusConditions} />,
              } : undefined;
            })()}
          />
        </Modal>
      )}
    </div>
  );
}
