import { GameCard, EnergyType, LegalAction } from '@ptcg/shared';
import { PtcgGameState, GamePhase, PendingChoice } from './GameState';
import { hasAbilityEffect } from './effects/abilities';
import { canPlayTrainer } from './effects/trainers';
import { getRetreatCostReduction, getColorlessCostReduction } from './effects/tools';
import { canAttackOnFirstTurn, canEvolveOnFirstTurnOrJustPlayed, canEvolveViaPassive, canUsePassiveGatedAttack, getPassiveAttackCostReduction, getPassiveRetreatCostIncrease, getPassiveRetreatCostReduction, getPassiveRetreatWaiver, hasPassiveColorlessCostWaiver, isAbilityPokemonPlayBlocked, isAceSpecPlayBlocked, areAbilitiesNegated, isAttackLockedByTimedEffect, isItemAndToolPlayBlocked, isItemLockedByTimedEffect, isItemPlayBlocked, isNamedAttackLockedByTimedEffect, isRetreatLockedByTimedEffect } from './effects/passiveAbilities';
import { normalizeAbilityName, normalizeCardName } from './effects/types';
import { hasEvolvesFrom, evolvesFromMatches, inferEvolvesFromSpecies } from './evolutionChains';
import { isFossilCard } from './fossils';

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

export function canPayEnergyCost(attachedEnergy: { type: string }[], cost: EnergyType[], colorlessReduction = 0): boolean {
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
  return Math.max(0, base - reduction - getPassiveRetreatCostReduction(G, card) + getPassiveRetreatCostIncrease(G, card));
}

export function canPlayPokemon(G: PtcgGameState, playerIndex: number, cardId: string): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  // Fossils ("陳舊的○○化石") are printed as Trainer/Item cards but real rules let them be
  // played straight to the bench as a Basic Pokémon instead — see fossils.ts.
  const isFossil = isFossilCard(card.cardData);
  if (!isFossil) {
    if (card.cardData.supertype !== 'Pokémon') return false;
    if (!card.cardData.subtypes.includes('Basic')) return false;
  }

  const benchCount = player.bench.filter(s => s !== null).length;
  if (benchCount >= 5) return false;

  // 瞪眼效用: the opponent's Active may block this player from playing ability-holding Pokémon.
  if (isAbilityPokemonPlayBlocked(G, playerIndex as 0 | 1, card)) return false;

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

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  if (card.cardData.supertype !== 'Pokémon') return false;

  // TCGdex's zh-tw locale never populates `evolvesFrom` (confirmed: every Stage 1/Stage 2/VMAX/
  // VSTAR card in the dataset is missing it, not just some) — hasEvolvesFrom/evolvesFromMatches
  // fall back to a static species-chain table built from PokeAPI (see evolutionChains.ts) so
  // evolution isn't silently blocked for effectively every evolution card in the game.
  if (!hasEvolvesFrom(card.cardData)) return false;

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;
  if (!target) return false;
  // 提升進化: this specific Pokémon is exempt from the first-turn / just-played restrictions below.
  const bypassTiming = canEvolveOnFirstTurnOrJustPlayed(G, target);
  if (!bypassTiming && isFirstTurnOfGame(G)) return false;
  const nameMatches = evolvesFromMatches(card.cardData, target.cardData.name);
  const effectiveEvolvesFrom = card.cardData.evolvesFrom || inferEvolvesFromSpecies(card.cardData.name);
  if (!nameMatches && !canEvolveViaPassive(G, target, effectiveEvolvesFrom)) return false;
  if (!bypassTiming && player.pokemonPlayedThisTurn.includes(target.id)) return false;

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
  // Real rules: at most one retreat per turn. Without this, an AI whose active and bench
  // Pokémon can each afford to pay their own retreat cost will ping-pong between them forever
  // (retreat is high in MockAI's priority list, above draw_card/end_turn) until the turn-safety
  // cap fires and the game falsely ends with the human declared the winner.
  if (player.retreatedThisTurn) return false;
  if (!player.bench.some(s => s !== null)) return false;
  if (player.active.statusConditions.includes('Asleep') || player.active.statusConditions.includes('Paralyzed')) return false;
  // Fossils ("陳舊的○○化石" played as a Basic Pokémon): real rules say they can never retreat,
  // regardless of retreat cost (which is 0 for them, so the cost check below wouldn't catch it).
  if (player.active.cardData.isFossil) return false;
  if (isRetreatLockedByTimedEffect(G, player.active)) return false;
  // 霍米加的演奏: Poisoned Pokémon (including newly-poisoned ones) can't retreat this turn.
  if (player.active.statusConditions.includes('Poisoned') && player.poisonedCantRetreatUntilTurn === G.turn) return false;

  const retreatCost = effectiveRetreatCost(G, player.active);
  const attachedEnergyCount = player.active.attachedEnergy.length;

  return attachedEnergyCount >= retreatCost;
}

export function canAttack(G: PtcgGameState, playerIndex: number, attackIndex: number): boolean {
  const player = playerState(G, playerIndex, ['main', 'attack']);
  if (!player) return false;
  if (!player.active) return false;
  // KO-promotion is deferred to the start of the KO'd player's own next turn (see
  // promoteActiveIfNeeded's comment) — that assumed the only way to empty an opponent's Active
  // is an attack, which always ends the attacker's turn immediately. Between-turns damage
  // (Poison/Burn/passive abilities) can also do it, and that runs at the START of THIS player's
  // turn, so the opponent can sit with active === null for this entire turn. Without this guard,
  // attacking then silently no-ops (moves.attack's own `!opponent.active` check) and leaves
  // G.phase stuck at 'attack' — end_turn is never offered again since it's gated to 'main' only,
  // so the AI just retries 'attack' every iteration until the turn-safety cap fires and the
  // human is declared the winner even though the opponent never actually lost.
  const opponent = G.players[(1 - playerIndex) as 0 | 1];
  if (!opponent.active) return false;
  // 出道演出: this specific Pokémon is exempt from the first-turn attack restriction.
  if (isFirstTurnOfGame(G) && !canAttackOnFirstTurn(G, player.active)) return false;
  if (player.active.statusConditions.includes('Asleep') || player.active.statusConditions.includes('Paralyzed')) return false;
  if (isAttackLockedByTimedEffect(G, player.active)) return false;

  const attack = player.active.cardData.attacks?.[attackIndex];
  if (!attack) return false;
  // Old-scraper residue stored ability text as `[特性]`-prefixed pseudo-ATTACKS with an empty
  // cost — always payable, so selecting one silently wasted the turn's attack. The data has
  // been cleaned (46 entries), but keep this guard against a future scrape regression.
  // NOTE: raw regex on purpose — normalizeCardName/normalizeAbilityName strip the [特性]
  // marker, so the normalized name can't be used to DETECT it.
  if (/^[‌​\s]*\[特性\]/.test(attack.name)) return false;
  if (isNamedAttackLockedByTimedEffect(G, player.active, attack.name)) return false;
  if (!canUsePassiveGatedAttack(G, player.active)) return false;

  // 化身團結 waives only the Colorless portion of the cost — specific-type requirements remain.
  const colorlessInCost = attack.cost.filter(c => c === 'Colorless').length;
  const colorlessReduction = hasPassiveColorlessCostWaiver(G, player.active)
    ? colorlessInCost
    : getColorlessCostReduction(G, player.active, playerIndex as 0 | 1)
      + getPassiveAttackCostReduction(G, playerIndex as 0 | 1, player.active, attack.name);
  return canPayEnergyCost(player.active.attachedEnergy, attack.cost, colorlessReduction);
}

export function getLegalMoves(G: PtcgGameState, playerIndex: number): LegalAction[] {
  const legalMoves: LegalAction[] = [];
  const player = G.players[playerIndex as 0 | 1];

  if (G.currentPlayer !== playerIndex) return legalMoves;

  if (G.phase === 'choose_first') {
    if (G.coinWinner === playerIndex) {
      legalMoves.push({ type: 'choose_first', description: '你贏得擲硬幣：選擇先攻', payload: { goFirst: true } });
      legalMoves.push({ type: 'choose_first', description: '你贏得擲硬幣：選擇後攻', payload: { goFirst: false } });
    }
    legalMoves.push({ type: 'forfeit', description: 'Forfeit the game' });
    return legalMoves;
  }

  if (G.phase === 'choose_active') {
    for (const card of player.hand) {
      if (card.cardData.supertype === 'Pokémon' && card.cardData.subtypes.includes('Basic')) {
        legalMoves.push({
          type: 'choose_active',
          description: `Set ${card.cardData.name} as your Active Pokémon`,
          payload: { cardId: card.id },
        });
      }
    }
    legalMoves.push({ type: 'forfeit', description: 'Forfeit the game' });
    return legalMoves;
  }

  // A multi-step trainer/ability effect is mid-resolution — nothing else is legal until it's answered.
  if (G.pendingChoice) {
    return [...legalMovesForPendingChoice(G, playerIndex, G.pendingChoice), { type: 'forfeit', description: 'Forfeit the game' }];
  }

  if (G.phase === 'main') {
    for (const pokemon of [player.active, ...player.bench].filter((c): c is GameCard => c !== null)) {
      // 暗夜羽擊: an Active facing the opponent's 暗夜羽擊 Active has all its abilities negated.
      if (areAbilitiesNegated(G, pokemon)) continue;
      const ability = pokemon.cardData.abilities?.find(a => hasAbilityEffect(normalizeAbilityName(a.name)));
      if (ability) {
        const name = normalizeAbilityName(ability.name);
        // abilitiesUsedThisTurn is only ever populated for an unlimited-use ability when a use
        // resolved to an immediate no-op (see moves.ts's useAbility) — a genuinely successful
        // multi-step use never adds it, so it's safe to respect the flag uniformly here rather
        // than exempting unlimited-use abilities from it entirely.
        const alreadyUsed = player.abilitiesUsedThisTurn.includes(pokemon.id);
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
      if ((card.cardData.supertype === 'Pokémon' || isFossilCard(card.cardData)) && canPlayPokemon(G, playerIndex, card.id)) {
        legalMoves.push({
          type: 'play_pokemon',
          description: `Play ${card.cardData.name} to bench`,
          payload: { cardId: card.id },
        });
      }

      if (card.cardData.supertype === 'Pokémon' && hasEvolvesFrom(card.cardData)) {
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

      // Fossils are printed as Trainer/Item cards but their ONLY legal play is "as a Basic
      // Pokémon" (offered above via canPlayPokemon) — they have no trainerEffects registration
      // (nothing for them to search/discard/draw for), so falling through to the generic
      // play_trainer path below would crash startTrainerEffect on a missing handler.
      if (card.cardData.supertype === 'Trainer' && !isFossilCard(card.cardData)) {
        const isSupporter = card.cardData.subtypes.includes('Supporter');
        const blockedFirstTurn = isSupporter && isFirstTurnOfGame(G) && !FIRST_TURN_SUPPORTER_EXCEPTIONS.has(card.cardData.name);
        const blockedAlreadyPlayed = isSupporter && player.supporterPlayedThisTurn;
        // 海之詛咒: while the opponent's Active holds this ability, this player can't play
        // Item cards from hand or attach Pokémon Tool cards at all.
        const isItem = card.cardData.subtypes.includes('Item');
        const blockedByOpponentAbility = ((isItem || card.cardData.subtypes.includes('Pokémon Tool')) && isItemAndToolPlayBlocked(G, playerIndex as 0 | 1))
          || (isItem && (isItemPlayBlocked(G, playerIndex as 0 | 1) || isItemLockedByTimedEffect(G, playerIndex as 0 | 1)))
          || (card.cardData.rarity === 'ACE' && isAceSpecPlayBlocked(G, playerIndex as 0 | 1));
        // Per-handler canPlay gate (EffectHandler.canPlay, co-located with each trainer's own
        // effect logic in effects/trainers.ts): a Trainer whose effect could not do anything
        // right now is not offered as a move at all — otherwise the generic trainer-play flow
        // discards the card even though its handler bailed out immediately, i.e. the item
        // "failed" but still cost the card.
        const blockedByGate = !canPlayTrainer(card.cardData.name, { G, playerIndex: playerIndex as 0 | 1, sourceCardId: card.id });
        if (!blockedFirstTurn && !blockedAlreadyPlayed && !blockedByOpponentAbility && !blockedByGate) {
          legalMoves.push({
            type: 'play_trainer',
            description: `Play ${card.cardData.name}`,
            payload: { cardId: card.id },
          });
        }
      }
    }

    if (canRetreat(G, playerIndex) && player.active) {
      legalMoves.push({
        type: 'retreat',
        description: 'Retreat active pokemon',
        // Display-only metadata (the retreat move handler doesn't read this) — lets the client
        // show the true, post-reduction cost (e.g. 氣球) as energy icons without duplicating
        // the reduction math client-side.
        payload: { retreatCost: effectiveRetreatCost(G, player.active) },
      });
    }

    // Fossils ("陳舊的○○化石"): voluntary, no-cost discard from play on the owner's own turn —
    // offered for every one currently in play (Active or Bench), independent of retreat/KO.
    for (const fossil of [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !!c.cardData.isFossil)) {
      legalMoves.push({
        type: 'discard_fossil',
        description: `Discard ${fossil.cardData.name} from play`,
        payload: { cardId: fossil.id },
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
