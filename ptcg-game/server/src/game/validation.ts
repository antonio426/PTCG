import { GameCard, EnergyType, LegalAction, isAceSpec } from '@ptcg/shared';
import { PtcgGameState, GamePhase, PendingChoice } from './GameState';
import { hasAbilityEffect, canUseAbility, FROM_HAND_ABILITY_NAMES } from './effects/abilities';
import { canPlayTrainer, hasTrainerEffect } from './effects/trainers';
import { getRetreatCostReduction, getColorlessCostReduction } from './effects/tools';
import { canAttackOnFirstTurn, canEvolveOnFirstTurnOrJustPlayed, canEvolveViaPassive, canUsePassiveGatedAttack, getPassiveAttackCostOverride, getPassiveAttackCostReduction, getPassiveRetreatCostIncrease, getPassiveRetreatCostReduction, getPassiveRetreatWaiver, hasPassiveColorlessCostWaiver, isAbilityPokemonPlayBlocked, isAceSpecPlayBlocked, areAbilitiesNegated, isAttackLockedByTimedEffect, isItemAndToolPlayBlocked, isItemLockedByTimedEffect, isItemPlayBlocked, isNamedAttackLockedByTimedEffect, isStadiumPlayBlocked, isRetreatLockedByTimedEffect, isProtectedFromOpponentTrainer, hasPassiveAbilityNamed, canHoldSecondTool } from './effects/passiveAbilities';
import { normalizeAbilityName, normalizeCardName } from './effects/types';
import { hasEvolvesFrom, evolvesFromMatches, inferEvolvesFromSpecies } from './evolutionChains';
import { isFossilCard } from './fossils';
import { canOpenAsSetupActive } from './setup';
import { benchLimit, isStadiumActive } from './effects/stadiums';
import { energyUnitsProvided } from './effects/specialEnergy';

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

  // Clamp every requested count to what's actually selectable. combinations(pool, n) returns []
  // for n > pool.length, so an unclamped fixed count produced ZERO legal moves while a
  // pendingChoice was still standing — no move could resolve it and the match soft-locked behind
  // a modal with nothing to click. Asking for "as many as you can" is the least-bad reading when
  // a handler raises a choice its own board can't satisfy, and with an empty pool it degrades to
  // the single "(不選)" move, which always clears the choice.
  const counts: number[] = [];
  if (choice.count !== undefined) counts.push(Math.min(choice.count, pool.length));
  else {
    const min = Math.min(choice.minCount ?? 0, pool.length);
    const max = Math.min(choice.maxCount ?? pool.length, pool.length);
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

/**
 * `holder` is optional only so the existing callers that pass a bare attachment list keep working;
 * pass it whenever the Pokémon is known. Without it, Special Energy falls back to its flat
 * `type`, which is one Colorless for most of them — 火箭隊能量's two units, 古舊能量's wildcard and
 * the holder-dependent ones (稜鏡能量, 新衝天能量, 燃火能量) all need the card to be resolved.
 */
export function canPayEnergyCost(
  attachedEnergy: { type: string; cardData?: GameCard['cardData'] }[],
  cost: EnergyType[],
  colorlessReduction = 0,
  holder?: GameCard,
): boolean {
  if (cost.length === 0) return true;

  const units = holder
    ? attachedEnergy.flatMap(e => energyUnitsProvided(e, holder))
    : attachedEnergy.map(e => ({ types: [e.type] }));

  const specificCosts = cost.filter(c => c !== 'Colorless');
  const colorlessCount = Math.max(0, cost.filter(c => c === 'Colorless').length - colorlessReduction);

  // Assign the specific symbols first, spending the LEAST flexible unit that can cover each one.
  // Spending a wildcard on a symbol an exact-type unit could have paid would wrongly report a
  // cost as unpayable — with 古舊能量 (every type) plus one Fire, a 【火】【無】 cost is payable,
  // but only if the Fire pays the 【火】 and the wildcard covers the 【無】.
  const pool = units.map(u => ({ types: new Set(u.types), spent: false }));
  for (const required of specificCosts) {
    const candidates = pool.filter(u => !u.spent && u.types.has(required));
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => a.types.size - b.types.size)[0].spent = true;
  }

  return pool.filter(u => !u.spent).length >= colorlessCount;
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

  // 零之大空洞 raises this to 8 for a player who has a 太晶 Pokémon in play.
  const benchCount = player.bench.filter(s => s !== null).length;
  if (benchCount >= benchLimit(G, playerIndex as 0 | 1)) return false;

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

  // 全能靈魂 (海豚俠ex): 「這張卡只可依據…『全能變身』的效果放置於場上」 — it can never be
  // played by evolving; the only door is the 全能變身 deck swap in moves.resolveChoice.
  if (card.cardData.abilities?.some(a => a.text && normalizeAbilityName(a.name) === '全能靈魂')) return false;

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
  // 活力森林 Stadium: a Grass Pokémon may evolve into a Grass Pokémon even the turn it was
  // played — printed text explicitly still excludes the player's OWN first turn of the game, so
  // this only bypasses the "just played" check above, never the isFirstTurnOfGame one.
  const bypassJustPlayed = bypassTiming || (isStadiumActive(G, '活力森林')
    && (target.cardData.types || []).includes('Grass') && (card.cardData.types || []).includes('Grass'));
  if (!bypassJustPlayed && player.pokemonPlayedThisTurn.includes(target.id)) return false;

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
  // The lock is a Supporter's continuous effect, so a Pokémon shielded from opponent Supporter
  // effects (融合為雪/緊張感/廣域堡壘) retreats through it — checked here at consult time, since
  // the flag itself is player-wide and protection can appear/disappear after the play.
  if (player.active.statusConditions.includes('Poisoned') && player.poisonedCantRetreatUntilTurn === G.turn
    && !isProtectedFromOpponentTrainer(G, player.active, 'Supporter')) return false;

  const retreatCost = effectiveRetreatCost(G, player.active);
  const attachedEnergyCount = player.active.attachedEnergy.length;

  return attachedEnergyCount >= retreatCost;
}

/**
 * 潛入記憶 (古空棘魚): while a holder is in play on `card`'s side, every own EVOLVED Pokémon may
 * also use the attacks printed on the Stages stacked underneath it (energy still required).
 * The list is index-stable — printed attacks first, then pre-evolution attacks oldest-stage
 * first — and getLegalMoves, canAttack and moves.attack all resolve an attackIndex against THIS
 * list, so the three can't disagree about which attack an index names.
 */
export function usableAttacks(G: PtcgGameState, card: GameCard): NonNullable<GameCard['cardData']['attacks']> {
  const printed = card.cardData.attacks || [];
  if (!card.preEvolutions?.length) return printed;
  const team = G.players[card.owner];
  if (![team.active, ...team.bench].some(c => c && hasPassiveAbilityNamed(G, c, '潛入記憶'))) return printed;
  return [...printed, ...card.preEvolutions.flatMap(p => p.cardData.attacks || [])];
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

  const attack = usableAttacks(G, player.active)[attackIndex];
  if (!attack) return false;
  // Old-scraper residue stored ability text as `[特性]`-prefixed pseudo-ATTACKS with an empty
  // cost — always payable, so selecting one silently wasted the turn's attack. The data has
  // been cleaned (46 entries), but keep this guard against a future scrape regression.
  // NOTE: raw regex on purpose — normalizeCardName/normalizeAbilityName strip the [特性]
  // marker, so the normalized name can't be used to DETECT it.
  if (/^[‌​\s]*\[特性\]/.test(attack.name)) return false;
  if (isNamedAttackLockedByTimedEffect(G, player.active, attack.name)) return false;
  if (!canUsePassiveGatedAttack(G, player.active)) return false;

  // 反等離子 replaces the printed cost outright, so it has to resolve before any reduction is
  // applied to it — the reductions below all shave Colorless pips off whatever cost is in force.
  const cost = getPassiveAttackCostOverride(G, playerIndex as 0 | 1, player.active, attack.name) ?? attack.cost;

  // 化身團結 waives only the Colorless portion of the cost — specific-type requirements remain.
  const colorlessInCost = cost.filter(c => c === 'Colorless').length;
  const colorlessReduction = hasPassiveColorlessCostWaiver(G, player.active)
    ? colorlessInCost
    : getColorlessCostReduction(G, player.active, playerIndex as 0 | 1)
      + getPassiveAttackCostReduction(G, playerIndex as 0 | 1, player.active, attack.name);
  return canPayEnergyCost(player.active.attachedEnergy, cost, colorlessReduction, player.active);
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
      // canOpenAsSetupActive = Basic, plus 瞬間爆發力 (see setup.ts).
      if (canOpenAsSetupActive(card)) {
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
        // Per-handler gate, same contract as the Trainer canPlay gate below: an ability whose
        // printed condition isn't met right now isn't offered, instead of being offered and then
        // silently burning its once-per-turn use on a no-op.
        const gated = !canUseAbility(name, { G, playerIndex: playerIndex as 0 | 1, sourceCardId: pokemon.id });
        if (!alreadyUsed && !gated) {
          legalMoves.push({
            type: 'use_ability',
            description: `Use ${pokemon.cardData.name}'s ability "${ability.name}"`,
            payload: { cardId: pokemon.id },
          });
        }
      }
    }
    // 緊急迴轉/激動俯衝: abilities used FROM HAND (「若手牌有這張卡…」) — the board loop above
    // can't see them. In-play negation is deliberately not consulted: 暗夜羽擊/初始化 read 場上.
    for (const card of player.hand) {
      const ability = card.cardData.abilities?.find(a => a.text && FROM_HAND_ABILITY_NAMES.has(normalizeAbilityName(a.name)));
      if (!ability) continue;
      const name = normalizeAbilityName(ability.name);
      if (player.abilitiesUsedThisTurn.includes(card.id)) continue;
      if (!canUseAbility(name, { G, playerIndex: playerIndex as 0 | 1, sourceCardId: card.id })) continue;
      legalMoves.push({
        type: 'use_ability',
        description: `Use ${card.cardData.name}'s ability "${ability.name}" from hand`,
        payload: { cardId: card.id },
      });
    }
  }

  // 稜鏡塔-style once-per-own-turn Stadium actions — a field effect, not tied to any specific
  // Pokémon/hand card, so it needs its own legal-move entry rather than piggybacking on
  // use_ability/play_trainer. `effectKey` is a discriminator so future once-per-turn Stadiums
  // (夜間學院, 神秘花園, 尖釘鎮道館, 化石採掘場, … — see stadiums.ts) can share this same move
  // type instead of each inventing their own.
  if (G.phase === 'main' && !player.stadiumActionUsedThisTurn) {
    if (isStadiumActive(G, '稜鏡塔') && player.hand.length >= 2) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '稜鏡塔：丟棄2張手牌，抽1張卡',
        payload: { effectKey: 'prism_tower_draw' },
      });
    }
    if (isStadiumActive(G, '神秘花園') && player.hand.some(c => c.cardData.supertype === 'Energy')) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '神秘花園：丟棄1張能量卡，抽卡至手牌與場上【超】寶可夢數量相同',
        payload: { effectKey: 'mystery_garden_draw' },
      });
    }
    if (isStadiumActive(G, '尖釘鎮道館') && player.deck.some(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('瑪俐的'))) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '尖釘鎮道館：從牌庫選1張「瑪俐的寶可夢」加入手牌',
        payload: { effectKey: 'spike_town_gym_search' },
      });
    }
    if (isStadiumActive(G, '夜間學院') && player.hand.length >= 1) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '夜間學院：選1張手牌放回牌庫上方',
        payload: { effectKey: 'night_school_topdeck' },
      });
    }
    if (isStadiumActive(G, '衝浪海灘') && player.active && (player.active.cardData.types || []).includes('Water')
      && player.bench.some(c => c !== null && (c.cardData.types || []).includes('Water'))) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '衝浪海灘：將戰鬥場的【水】寶可夢與備戰區的【水】寶可夢互換',
        payload: { effectKey: 'surf_beach_swap' },
      });
    }
    if (isStadiumActive(G, '火箭隊的工廠') && player.supporterNamesPlayedThisTurn.some(n => n.includes('火箭隊'))) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '火箭隊的工廠：抽2張卡',
        payload: { effectKey: 'rocket_factory_draw' },
      });
    }
    if (isStadiumActive(G, '居民會館') && player.supporterPlayedThisTurn) {
      legalMoves.push({
        type: 'use_stadium_action',
        description: '居民會館：自己的所有寶可夢各恢復10 HP',
        payload: { effectKey: 'resident_hall_heal' },
      });
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
          || (isAceSpec(card.cardData) && isAceSpecPlayBlocked(G, playerIndex as 0 | 1))
          // 爆大身軀: no Stadium plays while it sits in the opponent's Active Spot.
          || (card.cardData.subtypes.includes('Stadium') && isStadiumPlayBlocked(G, playerIndex as 0 | 1));
        // Per-handler canPlay gate (EffectHandler.canPlay, co-located with each trainer's own
        // effect logic in effects/trainers.ts): a Trainer whose effect could not do anything
        // right now is not offered as a move at all — otherwise the generic trainer-play flow
        // discards the card even though its handler bailed out immediately, i.e. the item
        // "failed" but still cost the card.
        const blockedByGate = !canPlayTrainer(card.cardData.name, { G, playerIndex: playerIndex as 0 | 1, sourceCardId: card.id });
        // A Pokémon Tool with no registered trainerEffects entry takes moves.ts's generic
        // attach path, which refunds the card to hand when every Pokémon already holds one —
        // so the move was offered, changed nothing, and could be picked again immediately. An
        // AI re-picking it spins until the turn safety cap (playtest-soak caught one game
        // burning all 2000 moves on 竹蘭的力量負重), and a human could click it forever.
        // `canPlayTrainer` can't cover this: these cards have no handler to carry a canPlay.
        const isGenericTool = card.cardData.subtypes.includes('Pokémon Tool') && !hasTrainerEffect(card.cardData.name);
        const noToolTarget = isGenericTool
          && ![player.active, ...player.bench].some(c => c !== null
            && (!c.attachedTool || (!c.attachedTool2 && canHoldSecondTool(G, c))));
        if (!blockedFirstTurn && !blockedAlreadyPlayed && !blockedByOpponentAbility && !blockedByGate && !noToolTarget) {
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
    if (player.active) {
      const attacks = usableAttacks(G, player.active);
      for (let i = 0; i < attacks.length; i++) {
        if (canAttack(G, playerIndex, i)) {
          legalMoves.push({
            type: 'attack',
            description: attacks[i].name,
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
