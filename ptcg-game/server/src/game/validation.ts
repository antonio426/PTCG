import { GameCard, EnergyType, LegalAction } from '@ptcg/shared';
import { PtcgGameState, GamePhase, PendingChoice } from './GameState';
import { hasAbilityEffect, isAbilityUnlimitedUse } from './effects/abilities';
import { getRetreatCostReduction, getColorlessCostReduction } from './effects/tools';
import { canEvolveViaPassive, canUsePassiveGatedAttack, getPassiveAttackCostReduction, getPassiveRetreatWaiver } from './effects/passiveAbilities';
import { normalizeAbilityName } from './effects/types';

/** All k-sized combinations of `items`, capped so huge hands can't explode the move list. */
function combinations<T>(items: T[], k: number, cap = 40): T[][] {
  const result: T[][] = [];
  function go(start: number, chosen: T[]) {
    if (result.length >= cap) return;
    if (chosen.length === k) { result.push([...chosen]); return; }
    for (let i = start; i < items.length && result.length < cap; i++) {
      chosen.push(items[i]);
      go(i + 1, chosen);
      chosen.pop();
    }
  }
  go(0, []);
  return result;
}

function legalMovesForPendingChoice(G: PtcgGameState, playerIndex: number, choice: PendingChoice): LegalAction[] {
  if (choice.player !== playerIndex) return [];
  const player = G.players[playerIndex as 0 | 1];
  const labelById = new Map<string, string>();
  if (choice.choiceType === 'select_hand_cards') {
    for (const c of player.hand) labelById.set(c.id, c.cardData.name);
  } else {
    for (const o of choice.options || []) labelById.set(o.id, o.label);
  }
  const pool = [...labelById.keys()];

  const counts: number[] = [];
  if (choice.count !== undefined) counts.push(choice.count);
  else {
    const min = choice.minCount ?? 0;
    const max = choice.maxCount ?? pool.length;
    for (let n = min; n <= max; n++) counts.push(n);
  }

  const moves: LegalAction[] = [];
  for (const n of counts) {
    for (const combo of combinations(pool, n)) {
      const names = combo.map(id => labelById.get(id) ?? id);
      moves.push({
        type: 'resolve_choice',
        description: `${choice.prompt} → ${names.length === 0 ? '(不選)' : names.join('、')}`,
        payload: { selection: combo },
      });
    }
  }
  return moves;
}

function playerState(G: PtcgGameState, playerIndex: number, allowedPhases: GamePhase[]) {
  if (G.currentPlayer !== playerIndex) return null;
  if (!allowedPhases.includes(G.phase)) return null;
  return G.players[playerIndex as 0 | 1];
}

function findPokemon(player: ReturnType<typeof playerState>, targetId: string): GameCard | null {
  if (!player) return null;
  if (player.active?.id === targetId) return player.active;
  return player.bench.find(c => c?.id === targetId) || null;
}

function getEnergyCounts(attachedEnergy: { type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of attachedEnergy) {
    counts[e.type] = (counts[e.type] || 0) + 1;
  }
  return counts;
}

function canPayEnergyCost(attachedEnergy: { type: string }[], cost: EnergyType[], colorlessReduction = 0): boolean {
  if (cost.length === 0) return true;

  const counts = getEnergyCounts(attachedEnergy);
  const specificCosts = cost.filter(c => c !== 'Colorless');
  const colorlessCount = Math.max(0, cost.filter(c => c === 'Colorless').length - colorlessReduction);

  const remaining = { ...counts };

  for (const requiredType of specificCosts) {
    if (!remaining[requiredType] || remaining[requiredType] <= 0) return false;
    remaining[requiredType]--;
  }

  const totalRemaining = Object.values(remaining).reduce((a, b) => a + b, 0);
  return totalRemaining >= colorlessCount;
}

/** Retreat cost after Tool-based reductions (e.g. 氣球 -2, 緊急滑板 -1 or waived when low HP). */
export function effectiveRetreatCost(G: PtcgGameState, card: GameCard): number {
  const base = card.cardData.retreatCost?.length ?? 0;
  const { reduction, waived } = getRetreatCostReduction(G, card);
  if (waived || getPassiveRetreatWaiver(G, card.owner, card)) return 0;
  return Math.max(0, base - reduction);
}

export function canPlayPokemon(G: PtcgGameState, playerIndex: number, cardId: string): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  if (card.cardData.supertype !== 'Pokémon') return false;
  if (!card.cardData.subtypes.includes('Basic')) return false;

  const benchCount = player.bench.filter(s => s !== null).length;
  if (benchCount >= 5) return false;

  return true;
}

/** A small number of real Supporter cards explicitly say they CAN be played on the first player's first turn, overriding the general restriction below. */
export const FIRST_TURN_SUPPORTER_EXCEPTIONS = new Set(['丹瑜', '火箭隊的蘭斯']);

/** Real-rules restriction: the player taking the game's first turn can't attack, evolve, or play a Supporter. */
function isFirstTurnOfGame(G: PtcgGameState): boolean {
  return G.turn === 1;
}

export function canEvolve(G: PtcgGameState, playerIndex: number, cardId: string, targetId: string): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;
  if (isFirstTurnOfGame(G)) return false;

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  if (card.cardData.supertype !== 'Pokémon') return false;

  const evolvesFrom = card.cardData.evolvesFrom;
  if (!evolvesFrom) return false;

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;
  if (!target) return false;
  if (target.cardData.name !== evolvesFrom && !canEvolveViaPassive(target, card.cardData)) return false;
  if (player.pokemonPlayedThisTurn.includes(target.id)) return false;

  return true;
}

export function canAttachEnergy(G: PtcgGameState, playerIndex: number, cardId: string, targetId: string): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;
  if (player.energyAttachedThisTurn >= 1) return false;

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  if (card.cardData.supertype !== 'Energy') return false;

  const target = findPokemon(player, targetId);
  if (!target) return false;

  return true;
}

export function canRetreat(G: PtcgGameState, playerIndex: number): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;
  if (!player.active) return false;
  if (!player.bench.some(s => s !== null)) return false;
  if (player.active.statusConditions.includes('Asleep') || player.active.statusConditions.includes('Paralyzed')) return false;

  const retreatCost = effectiveRetreatCost(G, player.active);
  const attachedEnergyCount = player.active.attachedEnergy.length;

  return attachedEnergyCount >= retreatCost;
}

export function canAttack(G: PtcgGameState, playerIndex: number, attackIndex: number): boolean {
  const player = playerState(G, playerIndex, ['main', 'attack']);
  if (!player) return false;
  if (isFirstTurnOfGame(G)) return false;
  if (!player.active) return false;
  if (player.active.statusConditions.includes('Asleep') || player.active.statusConditions.includes('Paralyzed')) return false;

  const attack = player.active.cardData.attacks?.[attackIndex];
  if (!attack) return false;
  if (!canUsePassiveGatedAttack(G, player.active)) return false;

  const colorlessReduction = getColorlessCostReduction(G, player.active, playerIndex as 0 | 1)
    + getPassiveAttackCostReduction(G, playerIndex as 0 | 1, player.active, attack.name);
  return canPayEnergyCost(player.active.attachedEnergy, attack.cost, colorlessReduction);
}

export function getLegalMoves(G: PtcgGameState, playerIndex: number): LegalAction[] {
  const legalMoves: LegalAction[] = [];
  const player = G.players[playerIndex as 0 | 1];

  if (G.currentPlayer !== playerIndex) return legalMoves;

  // A multi-step trainer/ability effect is mid-resolution — nothing else is legal until it's answered.
  if (G.pendingChoice) {
    return [...legalMovesForPendingChoice(G, playerIndex, G.pendingChoice), { type: 'forfeit', description: 'Forfeit the game' }];
  }

  if (G.phase === 'main') {
    for (const pokemon of [player.active, ...player.bench].filter((c): c is GameCard => c !== null)) {
      const ability = pokemon.cardData.abilities?.find(a => hasAbilityEffect(normalizeAbilityName(a.name)));
      if (ability) {
        const name = normalizeAbilityName(ability.name);
        const alreadyUsed = player.abilitiesUsedThisTurn.includes(pokemon.id) && !isAbilityUnlimitedUse(name);
        if (!alreadyUsed) {
          legalMoves.push({
            type: 'use_ability',
            description: `Use ${pokemon.cardData.name}'s ability "${ability.name}"`,
            payload: { cardId: pokemon.id },
          });
        }
      }
    }
  }

  if (G.phase === 'draw') {
    legalMoves.push({ type: 'draw_card', description: 'Draw a card' });
  }

  if (G.phase === 'main') {
    for (const card of player.hand) {
      if (card.cardData.supertype === 'Pokémon' && canPlayPokemon(G, playerIndex, card.id)) {
        legalMoves.push({
          type: 'play_pokemon',
          description: `Play ${card.cardData.name} to bench`,
          payload: { cardId: card.id },
        });
      }

      if (card.cardData.supertype === 'Pokémon' && card.cardData.evolvesFrom) {
        const targets = [player.active, ...player.bench.filter((s): s is GameCard => s !== null)];
        for (const target of targets) {
          if (target && canEvolve(G, playerIndex, card.id, target.id)) {
            legalMoves.push({
              type: 'evolve_pokemon',
              description: `Evolve ${target.cardData.name} into ${card.cardData.name}`,
              payload: { cardId: card.id, targetId: target.id },
            });
          }
        }
      }

      if (card.cardData.supertype === 'Energy' && player.energyAttachedThisTurn < 1) {
        const targets = [player.active, ...player.bench.filter((s): s is GameCard => s !== null)];
        for (const target of targets) {
          if (target) {
            legalMoves.push({
              type: 'attach_energy',
              description: `Attach ${card.cardData.name} to ${target.cardData.name}`,
              payload: { cardId: card.id, targetId: target.id },
            });
          }
        }
      }

      if (card.cardData.supertype === 'Trainer') {
        const isSupporter = card.cardData.subtypes.includes('Supporter');
        const blockedFirstTurn = isSupporter && isFirstTurnOfGame(G) && !FIRST_TURN_SUPPORTER_EXCEPTIONS.has(card.cardData.name);
        const blockedAlreadyPlayed = isSupporter && player.supporterPlayedThisTurn;
        if (!blockedFirstTurn && !blockedAlreadyPlayed) {
          legalMoves.push({
            type: 'play_trainer',
            description: `Play ${card.cardData.name}`,
            payload: { cardId: card.id },
          });
        }
      }
    }

    if (canRetreat(G, playerIndex)) {
      legalMoves.push({
        type: 'retreat',
        description: 'Retreat active pokemon',
      });
    }

    legalMoves.push({
      type: 'end_turn',
      description: 'End turn',
    });
  }

  if (G.phase === 'main' || G.phase === 'attack') {
    if (player.active && player.active.cardData.attacks) {
      for (let i = 0; i < player.active.cardData.attacks.length; i++) {
        if (canAttack(G, playerIndex, i)) {
          legalMoves.push({
            type: 'attack',
            description: player.active.cardData.attacks[i].name,
            payload: { attackIndex: i },
          });
        }
      }
    }
  }

  legalMoves.push({
    type: 'forfeit',
    description: 'Forfeit the game',
  });

  return legalMoves;
}
