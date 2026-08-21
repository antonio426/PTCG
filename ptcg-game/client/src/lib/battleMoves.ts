import type { Card, LegalAction } from '@ptcg/shared';

/**
 * Which UI surface each legal move belongs to.
 *
 * This lives outside Battle.tsx so it can be tested without a browser: the failure mode it guards
 * against is a legal move type that no surface renders, which leaves the player unable to take an
 * action the server is offering. That is invisible in review (the UI looks complete) and invisible
 * to the server's own tests (the move IS legal) — `discard_fossil` sat unsurfaced exactly that way.
 */
export interface HandCardAction {
  cardData: Card;
  moves: LegalAction[];
}

/** Moves attached to a card sitting in hand — rendered on the card itself. */
export const HAND_CARD_MOVE_TYPES = ['play_pokemon', 'evolve_pokemon', 'attach_energy', 'play_trainer', 'choose_active'] as const;
/** Board-level actions rendered in the action bar. */
export const QUICK_MOVE_TYPES = ['draw_card', 'retreat', 'end_turn', 'attack', 'use_stadium_action', 'discard_fossil'] as const;

/**
 * Deliberately not rendered: there is no surrender button by design (the game ends by prizes, decking
 * out or a real board state), and Battle.tsx's "you have no moves left" check excludes it for the
 * same reason. Anything else missing from a surface is a bug.
 */
export const UNSURFACED_BY_DESIGN = ['forfeit'] as const;

export function groupMovesByHandCard(legalMoves: LegalAction[], hand: Card[]): HandCardAction[] {
  const result: HandCardAction[] = [];
  for (const hc of hand) {
    const moves = legalMoves.filter(m =>
      (HAND_CARD_MOVE_TYPES as readonly string[]).includes(m.type) && m.payload?.cardId === hc.id);
    if (moves.length > 0) result.push({ cardData: hc, moves });
  }
  return result;
}

export interface MoveBuckets {
  handCardActions: HandCardAction[];
  quickActions: LegalAction[];
  trainerActions: LegalAction[];
  abilityActions: LegalAction[];
  choiceMoves: LegalAction[];
  setupMoves: LegalAction[];
  /** Anything no surface would render. Should only ever hold UNSURFACED_BY_DESIGN types. */
  unsurfaced: LegalAction[];
}

export function bucketLegalMoves(legalMoves: LegalAction[], hand: Card[]): MoveBuckets {
  const handCardActions = groupMovesByHandCard(legalMoves, hand);
  const surfacedOnACard = new Set(handCardActions.flatMap(a => a.moves));
  const quickActions = legalMoves.filter(m => (QUICK_MOVE_TYPES as readonly string[]).includes(m.type));
  const trainerActions = legalMoves.filter(m => m.type === 'play_trainer');
  // payload.cardId names a Pokémon in play, not a hand card, so groupMovesByHandCard can't reach these.
  const abilityActions = legalMoves.filter(m => m.type === 'use_ability');
  const choiceMoves = legalMoves.filter(m => m.type === 'resolve_choice');
  const setupMoves = legalMoves.filter(m => m.type === 'choose_first' || m.type === 'choose_active');

  const unsurfaced = legalMoves.filter(m =>
    !surfacedOnACard.has(m)
    && !quickActions.includes(m)
    && !trainerActions.includes(m)
    && !abilityActions.includes(m)
    && !choiceMoves.includes(m)
    && !setupMoves.includes(m));

  return { handCardActions, quickActions, trainerActions, abilityActions, choiceMoves, setupMoves, unsurfaced };
}
