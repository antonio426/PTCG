import { Card } from './card';

export interface GameCard {
  id: string;
  cardData: Card;
  owner: 0 | 1;
  damage: number;
  statusConditions: StatusCondition[];
  attachedEnergy: AttachedEnergy[];
  /** At most one Pokémon Tool card may be attached per Pokémon under current rules. */
  attachedTool?: GameCard | null;
  /** Second Tool slot, usable ONLY under 多重轉接 (洛托姆ex: own 洛托姆-named Pokémon may hold
   * 2 Tools). Every zone-moving code path must move/unbundle this alongside `attachedTool`; the
   * moves wrapper discards it when the permission lapses (the ability's printed parenthetical). */
  attachedTool2?: GameCard | null;
  turnedFacedown?: boolean;
  /** 火箭隊的妨礙機器人: a prize card flipped face-up 「在對戰結束前」. Only meaningful while the
   * card sits in a prizes array; cleared if the card leaves the prize zone. */
  revealedPrize?: boolean;
  /** 「因這個【中毒】而放置的傷害指示物的數量改為N個」 — while this Pokémon is Poisoned by such
   * an attack, the between-turns tick places N counters instead of 1. Reset whenever Poison is
   * (re)applied without an override. */
  poisonCounterOverride?: number;
  /** Real rules: evolving does NOT discard the pre-evolution card — it stays stacked underneath
   * the new card as part of the same in-play Pokémon, and the whole stack only goes to the
   * discard pile together when this Pokémon is later Knocked Out (or otherwise permanently
   * leaves play). Ordered oldest-first (e.g. Basic, then Stage 1, for a Stage-2 top card).
   * Entries here always have `attachedEnergy: []`/`attachedTool: null`/`damage: 0` — the current
   * top card is the sole owner of "live" attachments; historical stack entries are inert
   * markers only kept so the discard pile ends up with the right cards. */
  preEvolutions?: GameCard[];
  /** Per-card, single-turn effects set by attack text like "在下個對手的回合，這隻寶可夢不會
   * 受到招式的傷害" (self-protection) or "在下個對手的回合，受到這個招式的寶可夢無法撤退"
   * (inflicted on the defender). `appliesOnTurn` is an absolute GameState.turn number — the
   * effect is active only when the current turn exactly matches it, so no active pruning is
   * needed and no timing edge case can leak into an adjacent turn. */
  timedEffects?: TimedCardEffect[];
}

export interface TimedCardEffect {
  kind: 'cantAttack' | 'cantRetreat' | 'damageImmune' | 'damageReduction' | 'outgoingDamageReduction' | 'outgoingDamageBoost' | 'coinFlipAttackMiss' | 'namedAttackLock' | 'weaknessRemoved' | 'retaliationCounters';
  amount?: number;
  appliesOnTurn: number;
  /** For 'damageImmune': restricts the immunity to attackers of this Subtype only (e.g. "Basic"). */
  vsSubtype?: string;
  /** For 'damageImmune': only attacks whose printed damage is at most this are blocked
   * (「不會受到「60」以下的招式的傷害」); absent = every attack. */
  maxImmuneDamage?: number;
  /** For 'namedAttackLock': only this one named attack is blocked, not all of them. */
  attackName?: string;
}

export interface AttachedEnergy {
  id: string;
  type: string;
  /** The original card, preserved through the hand->attached transition so effects that later
   * discard this energy (retreat cost, attack-effect energy discard) can push a real card into
   * the discard pile instead of the energy silently vanishing from the game entirely. Optional
   * only for backward compatibility with any in-memory game state from before this field existed
   * — never omit it when constructing a new AttachedEnergy. */
  cardData?: Card;
}

export type StatusCondition = 'Asleep' | 'Burned' | 'Confused' | 'Paralyzed' | 'Poisoned';

export interface BenchSlot {
  card: GameCard | null;
}

export interface PlayerState {
  deck: GameCard[];
  hand: GameCard[];
  bench: [BenchSlot, BenchSlot, BenchSlot, BenchSlot, BenchSlot];
  active: GameCard | null;
  discardPile: GameCard[];
  prizes: GameCard[];
  takenPrizes: number;
  energyAttachedThisTurn: number;
  cardsPlayedThisTurn: number;
}

export interface GameState {
  players: [PlayerState, PlayerState];
  turn: number;
  currentPlayer: 0 | 1;
  phase: GamePhase;
  turnStage: TurnStage;
  winner: 0 | 1 | null;
  winReason: string | null;
  turnHistory: TurnAction[];
}

export type GamePhase = 'setup' | 'play' | 'attack' | 'end';

export type TurnStage = 'draw_phase' | 'main_phase' | 'attack_phase' | 'end_phase';

export interface DamageDetail {
  baseDamage: number;
  afterWeakness: number;
  weaknessApplied: boolean;
  resistanceApplied: boolean;
  finalDamage: number;
}

export interface TurnAction {
  player: 0 | 1;
  turn: number;
  action: string;
  details: string;
  timestamp: number;
  /** Structured breakdown for 'attack' actions. This — not `details` — is what consumers must
   * read for the damage number: `details` is human-facing prose in Traditional Chinese and is
   * free to be reworded, so anything parsing it (Battle.tsx's damage floater used to) breaks
   * silently the next time the wording changes. */
  damageDetail?: DamageDetail;
  /** Optional coin-flip summary for actions whose `details` text mentions a coin flip. */
  coinFlipNote?: string;
}

export interface DeckValidation {
  valid: boolean;
  errors: string[];
  cardCount: number;
}

/**
 * Multi-step trainer/ability/attack effects (e.g. Ultra Ball: discard 2, then
 * search 1) can't resolve in a single move. When one is mid-resolution,
 * `pendingChoice` describes what response is needed next; the client must
 * answer it with a `resolve_choice` move (`{ selection: string[] }`) before
 * any other move becomes legal again.
 */
export interface PendingChoice {
  player: 0 | 1;
  /** Effect registry key that owns this choice, e.g. 'trainer:高級球' */
  effectKey: string;
  prompt: string;
  choiceType: 'select_hand_cards' | 'select_pokemon' | 'select_bench_pokemon' | 'select_from_list' | 'select_energy_type' | 'confirm';
  /** Exact required selection count, if fixed. */
  count?: number;
  minCount?: number;
  maxCount?: number;
  /** For select_from_list: the concrete options being chosen from. `cardData` is filled in
   * server-side (see humanBattle.ts's buildResponse) whenever an option's id resolves to a real
   * card in a zone visible to this player — lets the client show actual card art instead of a
   * bare text button. Options that aren't real cards (energy already attached to a Pokémon,
   * abstract numeric choices like "move N counters") are left without it. */
  options?: { id: string; label: string; cardData?: Card }[];
  context: Record<string, unknown>;
  /** The trainer/pokemon/tool instance id that started this effect — restored into EffectContext on resume. */
  sourceCardId?: string;
  /** For deck-search choices only: the rest of the searching player's own deck (beyond `options`),
   * so they can browse what else is in there before picking — same information a physical player
   * would see by fanning out their own deck. Server-side, this is only ever populated for the
   * player whose own deck is being searched (never the opponent's). */
  remainingDeckPreview?: Card[];
}
