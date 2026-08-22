import { PtcgGameState } from './GameState';
import { moves } from './moves';

/**
 * The one place a legal move is turned into a call on `moves`.
 *
 * There are three drivers of the shared engine that submit moves — `ai/battleRunner.ts`,
 * `routes/humanBattle.ts` and `routes/battles.ts` — and each used to carry its own copy of this
 * switch. They drifted: `getLegalMoves` produces 15 move types, humanBattle dispatched all 15,
 * battleRunner 13, and battles.ts (BattleLab's AI-vs-AI engine) only 11. An unrecognised move is a
 * silent no-op — the AI picks it, the state doesn't change, and the loop grinds on to its safety
 * cap — so BattleLab measured win rates with 化石丟棄 and the Stadium action quietly missing.
 *
 * Same resolution as the turn-begin block (see `turnLifecycle.ts`): one implementation, every
 * engine calls it, and `tests/move-dispatch.test.ts` fails if a new move type is added without it
 * or if an engine grows a switch of its own again.
 *
 * `ctx` stays the caller's: the three engines legitimately differ in what ending a turn means
 * (battleRunner flips a local flag it returns, the routes set `G.phase = 'end'`), and
 * `moves.resolveChoice` reads `ctx.playerID` to decide whether the seat answering a choice is
 * allowed to.
 */
export interface MoveCtx {
  currentPlayer: string;
  /** The seat actually acting — set where the caller is untrusted (see moves.resolveChoice). */
  playerID?: string;
  turn?: number;
  events?: { endTurn?: () => void };
}

export function applyMove(
  G: PtcgGameState,
  action: { type: string; payload?: Record<string, any> },
  ctx: MoveCtx,
): void {
  const p = (action.payload ?? {}) as Record<string, any>;
  switch (action.type) {
    case 'choose_first': moves.chooseFirst({ G, ctx }, p.goFirst as boolean); break;
    case 'choose_active': moves.chooseActive({ G, ctx }, p.cardId as string); break;
    case 'draw_card': moves.drawCard({ G, ctx }); break;
    case 'play_pokemon': moves.playPokemon({ G, ctx }, p.cardId as string, p.benchPosition as number); break;
    case 'evolve_pokemon': moves.evolvePokemon({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'attach_energy': moves.attachEnergy({ G, ctx }, p.cardId as string, p.targetId as string); break;
    case 'play_trainer': moves.playTrainer({ G, ctx }, p.cardId as string); break;
    case 'use_ability': moves.useAbility({ G, ctx }, p.cardId as string); break;
    case 'resolve_choice': moves.resolveChoice({ G, ctx }, p.selection as string[]); break;
    case 'retreat': moves.retreat({ G, ctx }, p.targetBenchPosition as number, p.discardEnergyIds as string[]); break;
    case 'discard_fossil': moves.discardFossil({ G, ctx }, p.cardId as string); break;
    case 'attack': moves.attack({ G, ctx }, p.attackIndex as number); break;
    case 'use_stadium_action': moves.useStadiumAction({ G, ctx }, p.effectKey as string); break;
    case 'end_turn': moves.endTurn({ G, ctx }); break;
    case 'forfeit': moves.forfeit({ G, ctx }); break;
  }
}
