import { GameCard } from '@ptcg/shared';
import { PendingChoice, PtcgGameState } from '../GameState';

export interface EffectContext {
  G: PtcgGameState;
  playerIndex: 0 | 1;
  /** The instance id of the trainer/pokemon/tool card that triggered this effect */
  sourceCardId: string;
}

/** Result of starting or resuming an effect: either it's fully resolved, or it needs another player choice. */
export type EffectStep = 'done' | Omit<PendingChoice, 'player' | 'effectKey'>;

export interface EffectHandler {
  /** Begin resolving the effect. Called once when the card/ability is used. */
  start(ctx: EffectContext): EffectStep;
  /**
   * Continue resolving after the player answered `choice` with `selection`.
   * `context` is whatever this handler previously stashed on the PendingChoice.
   */
  resume(ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep;
  /**
   * Abilities only: most real abilities are "once per turn" (the default, false/undefined).
   * A handful (e.g. 金屬轉移) are explicitly unlimited-use — set true to skip the
   * once-per-turn tracking in abilitiesUsedThisTurn.
   */
  unlimitedUse?: boolean;
}

export function player(G: PtcgGameState, idx: 0 | 1) {
  return G.players[idx];
}

export function opponent(G: PtcgGameState, idx: 0 | 1) {
  return G.players[(1 - idx) as 0 | 1];
}

/** Find a Pokémon (active or benched) belonging to `idx` by instance id. */
export function findOwnPokemon(G: PtcgGameState, idx: 0 | 1, id: string): GameCard | null {
  const p = player(G, idx);
  if (p.active?.id === id) return p.active;
  return p.bench.find(c => c?.id === id) || null;
}

/** Every Pokémon (active + bench, non-null) belonging to `idx`. */
export function allPokemon(G: PtcgGameState, idx: 0 | 1): GameCard[] {
  const p = player(G, idx);
  return [p.active, ...p.bench].filter((c): c is GameCard => c !== null);
}

/**
 * Some scraped card names carry a stray leading zero-width char (e.g. "‌寶可夢中心的姐姐"
 * instead of "寶可夢中心的姐姐"), and ability names specifically can also carry a literal
 * "[特性]" baked into the text. Every place that matches a card/ability name against a
 * registry key must normalize through this first, or lookups for those specific cards
 * silently fail — invisible in testing since the stray character doesn't print.
 */
export function normalizeCardName(name: string | undefined | null): string {
  // At least one real card (S5R-059 爆炸頭水牛) has an ability entry scraped with no `name` at
  // all (just empty text) — guard here, at the one shared root, rather than at every call site
  // that assumes a string.
  if (!name) return '';
  // Zero-width chars are sometimes followed by a literal space before the real name
  // (e.g. "‌ 天空徑線"), so strip whitespace together with them, not separately —
  // otherwise the leftover leading space breaks equality against the clean registry key.
  return name.replace(/^[‌​\s]+/, '').replace(/^\[特性\]\s*/, '').trim();
}

/** Alias kept for call-site clarity where the value is specifically an ability name. */
export const normalizeAbilityName = normalizeCardName;

export function shuffleDeck(deck: GameCard[]): void {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}
