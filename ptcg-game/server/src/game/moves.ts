import { DamageDetail, GameCard } from '@ptcg/shared';
import { PtcgGameState, PendingChoice } from './GameState';
import { canPlayPokemon, canEvolve, canAttachEnergy, canRetreat, canAttack, effectiveRetreatCost, FIRST_TURN_SUPPORTER_EXCEPTIONS } from './validation';
import { clearStatusConditionsOnLeaveActive } from './statusConditions';
import { calculateDamageBreakdown, effectiveMaxHp, flushPreEvolutionsToDiscard, handleKo, prizesForKo, promoteActiveIfNeeded, stackAsPreEvolution } from './damage';
import { areAbilitiesNegated, getBonusPrizesForAttackKo, getEvolveCountersFromOpponent, getGrudgeVortexRetaliation, getLethalOnlyRetaliation, getRetreatPunishmentCounters, getScaledRetaliation, hasCoinFlipAttackMissDebuff, hasPassiveAbilityNamed, isRetreatBlockedByOpponent, onEnergyAttachedFromHand, shouldBurnOnOpponentRetreat, shouldConfuseOnOpponentRetreat, shouldDiscardAttackerEnergy } from './effects/passiveAbilities';
import { isStadiumActive } from './effects/stadiums';
import { getToolRetaliationDamage } from './effects/tools';
import { applyStatusCondition, discardAttachedEnergy, drawCards, drawUpTo, shuffleDeck } from './effects/primitives';
import { resolveGenericAttackEffect } from './effects/genericAttacks';
import { inferEvolvesFromSpecies, evolvesFromMatches } from './evolutionChains';
import {
  EffectContext, EffectStep,
  hasTrainerEffect, canPlayTrainer, startTrainerEffect, resumeTrainerEffect,
  hasAbilityEffect, startAbilityEffect, resumeAbilityEffect, isAbilityUnlimitedUse,
  hasAttackEffect, startAttackEffect, resumeAttackEffect,
  normalizeAbilityName,
} from './effects';

function applyEffectStep(G: PtcgGameState, player: 0 | 1, effectKey: string, step: EffectStep, sourceCardId?: string): void {
  if (step === 'done') {
    G.pendingChoice = null;
  } else {
    G.pendingChoice = { player, effectKey, sourceCardId, ...step };
  }
}

function addLog(G: PtcgGameState, player: number, action: string, details: string, damageDetail?: DamageDetail, coinFlipNote?: string) {
  G.turnLog.push({
    player: player as 0 | 1,
    turn: G.turn,
    action,
    details,
    timestamp: Date.now(),
    damageDetail,
    coinFlipNote,
  });
}

const ENERGY_TYPE_ZH_LABEL: Record<string, string> = {
  Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超',
  Fighting: '鬥', Darkness: '惡', Metal: '鋼', Fairy: '妖', Dragon: '龍', Colorless: '無',
};

/** Executes an already-decided retreat: pays the energy cost (specific ids if given, else the
 * first `retreatCost` attached) and swaps in the given (or first available) bench Pokémon. */
function performRetreat(G: PtcgGameState, targetBenchPosition: number | undefined, discardEnergyIds: string[] | undefined): void {
  const player = G.players[G.currentPlayer];
  const activePokemon = player.active;
  if (!activePokemon) return;

  const retreatCost = effectiveRetreatCost(G, activePokemon);
  if (discardEnergyIds && discardEnergyIds.length > 0) {
    for (const id of discardEnergyIds.slice(0, retreatCost)) {
      const idx = activePokemon.attachedEnergy.findIndex(e => e.id === id);
      if (idx >= 0) discardAttachedEnergy(G, G.currentPlayer as 0 | 1, activePokemon.attachedEnergy.splice(idx, 1)[0]);
    }
  } else {
    for (const energy of activePokemon.attachedEnergy.splice(0, retreatCost)) {
      discardAttachedEnergy(G, G.currentPlayer as 0 | 1, energy);
    }
  }

  let benchIdx = targetBenchPosition ?? -1;
  if (benchIdx < 0 || benchIdx >= 5 || player.bench[benchIdx] === null) {
    benchIdx = player.bench.findIndex(s => s !== null);
  }
  if (benchIdx < 0) return;

  const benchPokemon = player.bench[benchIdx];
  clearStatusConditionsOnLeaveActive(activePokemon);
  player.bench[benchIdx] = player.active;
  player.active = benchPokemon;
  player.retreatedThisTurn = true;
  addLog(G, G.currentPlayer, 'retreat', `Retreated to ${benchPokemon!.cardData.name}`);

  // 凹洞: 2 damage counters land on the Pokémon that just retreated (now benched).
  const punishCounters = getRetreatPunishmentCounters(G, G.currentPlayer as 0 | 1);
  if (punishCounters > 0) {
    activePokemon.damage += punishCounters * 10;
    const hp = effectiveMaxHp(G, activePokemon);
    if (hp > 0 && activePokemon.damage >= hp) handleKo(G, G.currentPlayer, activePokemon.id);
  }
  // 漩渦言靈: the newly promoted Pokémon gets Confused.
  if (shouldConfuseOnOpponentRetreat(G, G.currentPlayer as 0 | 1) && player.active) {
    applyStatusCondition(player.active, 'Confused');
  }
  // 熔岩地域: the newly promoted Pokémon gets Burned.
  if (shouldBurnOnOpponentRetreat(G, G.currentPlayer as 0 | 1) && player.active) {
    applyStatusCondition(player.active, 'Burned');
  }
}

export const moves = {
  /** The coin-flip winner (an interactive player — AI winners decide in setup) picks first/second. */
  chooseFirst: ({ G, ctx }: { G: PtcgGameState; ctx: any }, goFirst: boolean) => {
    if (G.phase !== 'choose_first') return;
    const chooser = parseInt(ctx.currentPlayer) as 0 | 1;
    if (G.coinWinner !== chooser) return;
    G.firstPlayer = goFirst ? chooser : ((1 - chooser) as 0 | 1);
    G.phase = 'choose_active';
    addLog(G, chooser, 'choose_first', goFirst ? '選擇先攻' : '選擇後攻');
  },

  chooseActive: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    if (G.phase !== 'choose_active') return;
    const player = G.players[parseInt(ctx.currentPlayer) as 0 | 1];
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const card = player.hand[idx];
    if (card.cardData.supertype !== 'Pokémon' || !card.cardData.subtypes.includes('Basic')) return;

    player.hand.splice(idx, 1);
    player.active = card;
    G.phase = 'draw';
    // Setup is complete — the coin flip's decided first player takes over turn 1 now (during the
    // choose_first/choose_active phases currentPlayer was pinned to the interactive player so
    // getLegalMoves kept working). When that's the AI, humanBattle's move endpoint sees
    // currentPlayer === 1 after this move and runs the AI's (restricted) first turn.
    if (G.firstPlayer !== undefined) G.currentPlayer = G.firstPlayer;
    addLog(G, parseInt(ctx.currentPlayer), 'choose_active', `Set ${card.cardData.name} as Active Pokémon`);
  },

  drawCard: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    if (G.phase !== 'draw') return;
    if (G.currentPlayer !== parseInt(ctx.currentPlayer)) return;

    const player = G.players[G.currentPlayer];

    if (player.deck.length === 0) {
      // Deck-out: one of the three standard ways to lose. This must be decided HERE, not left
      // for a caller to notice afterward — every engine's post-move win-check only ever looks
      // at G.winner directly (all four gate on `if (G.winner !== null) return true/G.winner`
      // as their first line), and none of them re-derive "was this a failed draw" from G.phase,
      // since by the time any of them run, G.phase has already moved on to 'main' below.
      G.winner = (1 - G.currentPlayer) as 0 | 1;
      G.winReason = 'deck empty at draw';
      addLog(G, G.currentPlayer, 'draw_card', 'Deck is empty — cannot draw');
      G.phase = 'main';
      return;
    }

    const card = player.deck.pop()!;
    player.hand.push(card);
    G.phase = 'main';
    addLog(G, G.currentPlayer, 'draw_card', `Drew ${card.cardData.name}`);
  },

  playPokemon: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, benchPosition?: number) => {
    if (!canPlayPokemon(G, G.currentPlayer, cardId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const card = player.hand.splice(cardIndex, 1)[0];
    let pos = benchPosition;
    if (pos === undefined || pos < 0 || pos >= 5 || player.bench[pos] !== null) {
      pos = player.bench.findIndex(s => s === null);
    }
    if (pos === -1 || pos >= 5) {
      player.hand.push(card);
      return;
    }

    player.bench[pos] = card;
    player.cardsPlayedThisTurn++;
    player.basicPokemonPlayedThisTurn++;
    player.pokemonPlayedThisTurn.push(card.id);
    addLog(G, G.currentPlayer, 'play_pokemon', `Played ${card.cardData.name} to bench`);
  },

  evolvePokemon: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, targetId: string) => {
    if (!canEvolve(G, G.currentPlayer, cardId, targetId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const evolution = player.hand.splice(cardIndex, 1)[0];

    const isActive = player.active?.id === targetId;
    const benchIdx = isActive ? -1 : player.bench.findIndex(c => c?.id === targetId);
    if (!isActive && benchIdx === -1) {
      player.hand.push(evolution);
      return;
    }

    const oldCard = isActive ? player.active! : player.bench[benchIdx]!;
    const savedEnergy = oldCard.attachedEnergy;
    const savedDamage = oldCard.damage;
    const savedTool = oldCard.attachedTool;
    // Note: status conditions (Asleep/Paralyzed/Confused/Poisoned/Burned) are cured on evolution per real rules, not carried over.

    stackAsPreEvolution(evolution, oldCard);

    if (isActive) {
      player.active = evolution;
    } else {
      player.bench[benchIdx] = evolution;
    }

    evolution.attachedEnergy = savedEnergy;
    evolution.damage = savedDamage;
    evolution.attachedTool = savedTool;
    player.cardsPlayedThisTurn++;
    // Without this, canEvolve()'s "already evolved/played this turn" check never sees the new
    // card's id, so a Pokémon that just evolved could illegally evolve again the same turn
    // (e.g. Basic -> Stage 1 -> Stage 2 in one turn) whenever the next evolution card was in hand.
    player.pokemonPlayedThisTurn.push(evolution.id);
    addLog(G, G.currentPlayer, 'evolve', `Evolved into ${evolution.cardData.name}`);

    // 黑暗脈衝: the opponent's ability may place 4 damage counters on the newly evolved Pokémon.
    const evolveCounters = getEvolveCountersFromOpponent(G, G.currentPlayer as 0 | 1);
    if (evolveCounters > 0) {
      evolution.damage += evolveCounters * 10;
      const hp = effectiveMaxHp(G, evolution);
      if (hp > 0 && evolution.damage >= hp) handleKo(G, G.currentPlayer, evolution.id);
    }
  },

  attachEnergy: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, targetId: string) => {
    if (!canAttachEnergy(G, G.currentPlayer, cardId, targetId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const energyCard = player.hand.splice(cardIndex, 1)[0];

    const target = player.active?.id === targetId
      ? player.active
      : player.bench.find(c => c?.id === targetId);
    if (!target) {
      player.hand.push(energyCard);
      return;
    }

    const energyType = energyCard.cardData.types?.[0] || 'Colorless';
    target.attachedEnergy.push({
      id: energyCard.id,
      type: energyType,
      cardData: energyCard.cardData,
    });
    onEnergyAttachedFromHand(G, G.currentPlayer as 0 | 1, target);

    player.energyAttachedThisTurn++;
    player.cardsPlayedThisTurn++;
    addLog(G, G.currentPlayer, 'attach_energy', `Attached ${energyCard.cardData.name} to ${target.cardData.name}`);
  },

  playTrainer: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    const player = G.players[G.currentPlayer];
    if (G.phase !== 'main') return;
    if (G.currentPlayer !== parseInt(ctx.currentPlayer)) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const trainerCard = player.hand.splice(cardIndex, 1)[0];
    if (trainerCard.cardData.supertype !== 'Trainer') {
      player.hand.push(trainerCard);
      return;
    }

    const isSupporter = trainerCard.cardData.subtypes.includes('Supporter');
    const firstTurnBlocked = G.turn === 1 && !FIRST_TURN_SUPPORTER_EXCEPTIONS.has(trainerCard.cardData.name);
    if (isSupporter && (player.supporterPlayedThisTurn || firstTurnBlocked)) {
      player.hand.push(trainerCard);
      return;
    }
    if (G.pendingChoice) {
      player.hand.push(trainerCard);
      return;
    }

    const cardName = trainerCard.cardData.name;
    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: trainerCard.id };

    // Belt-and-braces re-check of the handler's canPlay gate — getLegalMoves already filters
    // these out, but playTrainer is reachable from paths that never consulted it. An unplayable
    // card goes straight back to hand consuming nothing: no discard, no cardsPlayedThisTurn,
    // and (returning before the isSupporter bookkeeping below) no supporter slot.
    if (!canPlayTrainer(cardName, ctxInfo)) {
      player.hand.push(trainerCard);
      return;
    }

    // Stadium cards enter a shared field slot instead of the discard pile; only one is in play
    // at a time — playing a new one discards whichever was there (to its own owner's pile).
    if (trainerCard.cardData.subtypes.includes('Stadium') && !hasTrainerEffect(cardName)) {
      if (G.activeStadium) {
        const ownerIdx = G.activeStadium.owner;
        G.players[ownerIdx].discardPile.push(G.activeStadium);
      }
      G.activeStadium = trainerCard;
      player.cardsPlayedThisTurn++;
      addLog(G, G.currentPlayer, 'play_trainer', `Played ${cardName} (stadium)`);
      return;
    }

    // Pokémon Tool cards attach persistently instead of resolving once and going to discard.
    if (trainerCard.cardData.subtypes.includes('Pokémon Tool') && !hasTrainerEffect(cardName)) {
      const targets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !c.attachedTool);
      if (targets.length === 0) { player.hand.push(trainerCard); return; }
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'tool_attach',
        prompt: `選擇要附加 ${cardName} 的寶可夢`,
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { toolCard: trainerCard },
      };
      player.cardsPlayedThisTurn++;
      addLog(G, G.currentPlayer, 'play_trainer', `Played ${cardName} (attaching)`);
      return;
    }

    if (hasTrainerEffect(cardName)) {
      const step = startTrainerEffect(cardName, ctxInfo);
      applyEffectStep(G, G.currentPlayer as 0 | 1, `trainer:${cardName}`, step, trainerCard.id);
    } else if (cardName.includes('Professor') && cardName.includes('Research')) {
      player.discardPile.push(...player.hand);
      player.hand = [];
      for (let i = 0; i < 7; i++) {
        if (player.deck.length === 0) break;
        player.hand.push(player.deck.pop()!);
      }
    } else if (cardName === 'Switch') {
      if (!player.active || !player.bench.some(s => s !== null)) {
        player.hand.push(trainerCard);
        return;
      }
      const benchIdx = player.bench.findIndex(s => s !== null);
      const benchPokemon = player.bench[benchIdx];
      clearStatusConditionsOnLeaveActive(player.active);
      player.bench[benchIdx] = player.active;
      player.active = benchPokemon;
    }

    player.discardPile.push(trainerCard);
    player.cardsPlayedThisTurn++;
    if (isSupporter) player.supporterPlayedThisTurn = true;
    addLog(G, G.currentPlayer, 'play_trainer', `Played ${cardName}`);
  },

  useAbility: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    if (G.pendingChoice) return;
    const player = G.players[G.currentPlayer];
    const source = player.active?.id === cardId ? player.active : player.bench.find(c => c?.id === cardId);
    if (!source) return;
    const ability = source.cardData.abilities?.find(a => hasAbilityEffect(normalizeAbilityName(a.name)));
    if (!ability) return;
    // 暗夜羽擊: an Active facing the opponent's 暗夜羽擊 Active has all its abilities negated.
    if (areAbilitiesNegated(G, source)) return;
    const name = normalizeAbilityName(ability.name);
    if (player.abilitiesUsedThisTurn.includes(source.id) && !isAbilityUnlimitedUse(name)) return;

    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: source.id };
    const step = startAbilityEffect(name, ctxInfo);
    applyEffectStep(G, G.currentPlayer as 0 | 1, `ability:${name}`, step, source.id);
    // An unlimited-use ability that immediately resolves to 'done' (no interactive step at all)
    // had nothing left to do this call — e.g. excitedTurbine with no energy/targets left. Without
    // marking it used here too, getLegalMoves keeps offering the same always-legal no-op move
    // forever, since alreadyUsed is never true for unlimited-use abilities otherwise. Left
    // unguarded, an AI whose heuristic keeps re-picking that no-op spins until the turn-level
    // safety cap in humanBattle.ts/battleRunner.ts — for ClaudeAI that's hundreds of sequential
    // API calls, which reads to the human opponent as the game just hanging/timing out.
    if (!isAbilityUnlimitedUse(name) || step === 'done') player.abilitiesUsedThisTurn.push(source.id);
    addLog(G, G.currentPlayer, 'use_ability', `Used ability "${ability.name}" on ${source.cardData.name}`);
  },

  resolveChoice: ({ G, ctx }: { G: PtcgGameState; ctx: any }, selection: string[]) => {
    if (!G.pendingChoice) return;
    if (G.pendingChoice.player !== G.currentPlayer) return;

    const { effectKey, context } = G.pendingChoice;

    if (effectKey === 'tool_attach') {
      const player = G.players[G.currentPlayer];
      const toolCard = context.toolCard as GameCard;
      const target = player.active?.id === selection[0] ? player.active : player.bench.find(c => c?.id === selection[0]);
      if (target && !target.attachedTool) target.attachedTool = toolCard;
      else player.hand.push(toolCard);
      G.pendingChoice = null;
      addLog(G, G.currentPlayer, 'resolve_choice', `Attached ${toolCard.cardData.name} to ${target?.cardData.name ?? '?'}`);
      return;
    }

    if (effectKey === 'retreat') {
      const player = G.players[G.currentPlayer];
      if (context.step === 'pick_bench') {
        const benchIdx = player.bench.findIndex(c => c?.id === selection[0]);
        if (context.needsEnergyChoice && player.active) {
          const retreatCost = effectiveRetreatCost(G, player.active);
          G.pendingChoice = {
            player: G.currentPlayer as 0 | 1,
            effectKey: 'retreat',
            prompt: `選擇 ${retreatCost} 張要棄置的能量（撤退費用）`,
            choiceType: 'select_from_list',
            count: retreatCost,
            options: player.active.attachedEnergy.map(e => ({ id: e.id, label: ENERGY_TYPE_ZH_LABEL[e.type] || e.type })),
            context: { step: 'pick_energy', benchIdx },
          };
          addLog(G, G.currentPlayer, 'resolve_choice', 'Retreat: selected bench Pokémon');
        } else {
          G.pendingChoice = null;
          performRetreat(G, benchIdx, undefined);
        }
        return;
      }
      if (context.step === 'pick_energy') {
        const benchIdx = context.benchIdx as number | undefined;
        G.pendingChoice = null;
        performRetreat(G, benchIdx, selection);
        return;
      }
      G.pendingChoice = null;
      return;
    }

    if (effectKey === 'ko_promotion') {
      const player = G.players[G.currentPlayer];
      const idx = player.bench.findIndex(c => c?.id === selection[0]);
      if (idx >= 0) {
        player.active = player.bench[idx];
        player.bench[idx] = null;
      }
      G.pendingChoice = null;
      addLog(G, G.currentPlayer, 'resolve_choice', `Set ${player.active?.cardData.name ?? '?'} as new Active Pokémon`);
      return;
    }

    const colonIdx = effectKey.indexOf(':');
    const kind = effectKey.slice(0, colonIdx);
    const name = effectKey.slice(colonIdx + 1);
    // Restore the same sourceCardId the effect started with — several handlers' resume()
    // need it (e.g. to re-find the Pokémon that triggered the effect).
    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: G.pendingChoice.sourceCardId || '' };

    let step: EffectStep;
    if (kind === 'trainer') step = resumeTrainerEffect(name, ctxInfo, context, selection);
    else if (kind === 'ability') step = resumeAbilityEffect(name, ctxInfo, context, selection);
    else {
      const [pokemonName, attackName] = name.split('::');
      step = resumeAttackEffect(pokemonName, attackName, ctxInfo, context, selection);
    }
    applyEffectStep(G, G.currentPlayer as 0 | 1, effectKey, step, ctxInfo.sourceCardId);
    addLog(G, G.currentPlayer, 'resolve_choice', `Resolved ${effectKey}: ${selection.join(', ') || '(none)'}`);

    // An attack's pending choices (e.g. distributing damage counters) block the rest of the
    // turn; once they're all resolved, finish the turn exactly like a normal attack would.
    if (kind === 'attack' && !G.pendingChoice) {
      G.phase = 'end';
      ctx.events?.endTurn?.();
    }
  },

  retreat: ({ G, ctx }: { G: PtcgGameState; ctx: any }, targetBenchPosition?: number, discardEnergyIds?: string[]) => {
    if (!canRetreat(G, G.currentPlayer)) return;
    // 黏滑失足: opponent's ability may cancel this retreat outright on a coin flip.
    if (isRetreatBlockedByOpponent(G, G.currentPlayer as 0 | 1)) {
      addLog(G, G.currentPlayer, 'retreat', "Retreat was cancelled by the opponent's 黏滑失足");
      return;
    }

    const player = G.players[G.currentPlayer];
    const activePokemon = player.active;
    if (!activePokemon) return;

    // Explicit args mean the caller already made its choice (resuming below via resolveChoice,
    // or a direct legacy call) — skip straight to execution.
    if (targetBenchPosition !== undefined || discardEnergyIds !== undefined) {
      performRetreat(G, targetBenchPosition, discardEnergyIds);
      return;
    }

    // A player is entitled to choose BOTH which Benched Pokémon comes up AND which attached
    // energy pays the retreat cost — auto-picking "first bench slot" / "first N energies
    // attached" (the old behavior) silently took that choice away whenever more than one
    // option existed. Only ask when there's a real choice to make; otherwise resolve instantly
    // to keep the common case (one bench Pokémon, cost fully covered) a single click.
    const retreatCost = effectiveRetreatCost(G, activePokemon);
    const benchSlots: number[] = [];
    player.bench.forEach((c, i) => { if (c) benchSlots.push(i); });
    const needsBenchChoice = benchSlots.length > 1;
    const needsEnergyChoice = retreatCost > 0 && activePokemon.attachedEnergy.length > retreatCost;

    if (!needsBenchChoice && !needsEnergyChoice) {
      performRetreat(G, benchSlots[0], undefined);
      return;
    }

    if (needsBenchChoice) {
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'retreat',
        prompt: '選擇要換上場的備戰寶可夢',
        choiceType: 'select_bench_pokemon',
        count: 1,
        options: benchSlots.map(i => ({ id: player.bench[i]!.id, label: player.bench[i]!.cardData.name })),
        context: { step: 'pick_bench', needsEnergyChoice },
      };
    } else {
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'retreat',
        prompt: `選擇 ${retreatCost} 張要棄置的能量（撤退費用）`,
        choiceType: 'select_from_list',
        count: retreatCost,
        options: activePokemon.attachedEnergy.map(e => ({ id: e.id, label: ENERGY_TYPE_ZH_LABEL[e.type] || e.type })),
        context: { step: 'pick_energy', benchIdx: benchSlots[0] },
      };
    }
  },

  attack: ({ G, ctx }: { G: PtcgGameState; ctx: any }, attackIndex: number) => {
    if (G.phase !== 'main' && G.phase !== 'attack') return;
    if (!canAttack(G, G.currentPlayer, attackIndex)) return;

    G.phase = 'attack';
    const player = G.players[G.currentPlayer];
    const opponent = G.players[1 - G.currentPlayer];
    if (!player.active || !opponent.active) return;

    const attacker = player.active;
    const attack = attacker.cardData.attacks![attackIndex];
    const defender = opponent.active;

    // Confused: flip a coin before the attack connects. Tails = it fails and hits its own user for 30 instead.
    if (attacker.statusConditions.includes('Confused') && Math.random() < 0.5) {
      attacker.damage += 30;
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} is Confused and hurt itself for 30 damage!`);
      const selfHp = effectiveMaxHp(G, attacker);
      if (selfHp > 0 && attacker.damage >= selfHp) handleKo(G, G.currentPlayer, attacker.id);
      G.phase = 'end';
      ctx.events?.endTurn?.();
      return;
    }

    // Timed "next attack has a 50% chance to fail" debuff (e.g. from an opponent's earlier
    // attack) — consumed (removed) the moment it's checked, whether it fires or not, since it
    // only ever covers exactly one attack attempt.
    if (hasCoinFlipAttackMissDebuff(G, attacker)) {
      attacker.timedEffects = (attacker.timedEffects || []).filter(e => !(e.kind === 'coinFlipAttackMiss' && e.appliesOnTurn === G.turn));
      if (Math.random() < 0.5) {
        addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name}'s attack failed!`);
        G.phase = 'end';
        ctx.events?.endTurn?.();
        return;
      }
    }

    if (hasAttackEffect(attacker.cardData.name, attack.name)) {
      const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: attacker.id };
      const step = startAttackEffect(attacker.cardData.name, attack.name, ctxInfo);
      applyEffectStep(G, G.currentPlayer as 0 | 1, `attack:${attacker.cardData.name}::${attack.name}`, step, attacker.id);
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} used "${attack.name}"!`);
    } else {
      // Generic attack-text templates (coin-flip-scaled damage, status infliction, self-heal,
      // draw, energy discard, board-scaled damage, timed self-protection/lockout) — resolved
      // from the printed text/damage string directly, no per-card registration needed. See
      // genericAttacks.ts for what is and isn't covered by this.
      const ownBench = player.bench.filter((c): c is GameCard => c !== null);
      const attackBoard = {
        ownFieldPokemonCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).length,
        ownToolCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !!c.attachedTool).length,
        selfDamageCounters: attacker.damage / 10,
        opponentEnergyCount: defender.attachedEnergy.length,
        opponentDamageCounters: defender.damage / 10,
        ownBenchCount: ownBench.length,
        opponentBenchCount: opponent.bench.filter(c => c !== null).length,
        ownRemainingPrizes: player.prizes.length,
        opponentRemainingPrizes: opponent.prizes.length,
        defenderStatusConditionCount: defender.statusConditions.length,
        defenderIsBurned: defender.statusConditions.includes('Burned'),
        defenderIsEx: defender.cardData.subtypes.includes('ex'),
        attackerEnergyCounts: attacker.attachedEnergy.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
        ownBenchTypes: ownBench.flatMap(c => c.cardData.types || []),
        attackerTotalEnergyCount: attacker.attachedEnergy.length,
        bothActiveEnergyCount: attacker.attachedEnergy.length + defender.attachedEnergy.length,
        ownDiscardCardNames: player.discardPile.map(c => c.cardData.name),
        attackerEvolvesFrom: attacker.cardData.evolvesFrom || inferEvolvesFromSpecies(attacker.cardData.name),
        ownBenchNames: ownBench.map(c => c.cardData.name),
        opponentDiscardBasicEnergyCount: opponent.discardPile.filter(c => c.cardData.subtypes.includes('Basic Energy')).length,
        ownDeckCount: player.deck.length,
        ownFieldTotalEnergyCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).reduce((sum, c) => sum + c.attachedEnergy.length, 0),
        ownFieldEnergyCounts: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.attachedEnergy).reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
        defenderTypes: defender.cardData.types || [],
        defenderSubtypes: defender.cardData.subtypes || [],
        defenderEvolvesFrom: defender.cardData.evolvesFrom || inferEvolvesFromSpecies(defender.cardData.name),
        defenderIsConfused: defender.statusConditions.includes('Confused'),
        defenderRetreatCost: effectiveRetreatCost(G, defender),
        opponentFieldTypes: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.cardData.types || []),
        opponentHasFutureSubtype: [opponent.active, ...opponent.bench].some(c => c?.cardData.subtypes.includes('Future')),
        opponentHandCount: opponent.hand.length,
        ownFieldBasicCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('Basic')).length,
        hasActiveStadium: !!G.activeStadium,
        ownFieldTypeCounts: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).reduce((acc, c) => {
          for (const ty of c.cardData.types || []) acc[ty] = (acc[ty] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        opponentFieldEnergyCounts: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.attachedEnergy).reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
        opponentFieldTotalEnergyCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).reduce((sum, c) => sum + c.attachedEnergy.length, 0),
        opponentExCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('ex')).length,
        opponentExOrVCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && (c.cardData.subtypes.includes('ex') || c.cardData.subtypes.includes('V'))).length,
        ownDamagedBenchCount: ownBench.filter(c => c.damage > 0).length,
        ownFieldDamagedCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.damage > 0).length,
        ownBenchStage2Count: ownBench.filter(c => c.cardData.subtypes.includes('Stage 2')).length,
        ownBenchEnergyHolderCounts: ownBench.reduce((acc, c) => {
          for (const ty of new Set(c.attachedEnergy.map(e => e.type))) acc[ty] = (acc[ty] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        attackCostCount: attack.cost.length,
        attackerPromotedFromBenchThisTurn: player.activeIdAtTurnStart !== undefined && player.activeIdAtTurnStart !== attacker.id,
        ownDiscardEnergyCounts: player.discardPile.reduce((acc, c) => {
          if (!c.cardData.subtypes.includes('Basic Energy')) return acc;
          for (const ty of c.cardData.types || []) acc[ty] = (acc[ty] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        opponentTakenPrizes: 6 - opponent.prizes.length,
        ownBenchDamageCountersByName: ownBench.map(c => ({ name: c.cardData.name, counters: c.damage / 10 })),
        ownDiscardAbilityCounts: player.discardPile.reduce((acc, c) => {
          for (const a of c.cardData.abilities || []) {
            const n = normalizeAbilityName(a.name);
            acc[n] = (acc[n] || 0) + 1;
          }
          return acc;
        }, {} as Record<string, number>),
      };
      const genericOutcome = attack.text ? resolveGenericAttackEffect(attack.text, attack.damage, attackBoard) : undefined;
      if (genericOutcome?.familyScaledDamage) {
        const { name, amount } = genericOutcome.familyScaledDamage;
        const familyCount = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.cardData.name.includes(name)).length;
        genericOutcome.baseDamage = familyCount * amount;
      }
      // Must run here, in the pre-breakdown baseDamage phase: the cost IS the damage source, so
      // the Energy has to be discarded before calculateDamageBreakdown reads baseDamage below.
      if (genericOutcome?.discardOwnFieldTypedEnergyForDamage) {
        const { type, per } = genericOutcome.discardOwnFieldTypedEnergyForDamage;
        let discarded = 0;
        for (const c of [player.active, ...player.bench].filter((x): x is GameCard => x !== null)) {
          for (let i = c.attachedEnergy.length - 1; i >= 0; i--) {
            if (c.attachedEnergy[i].type !== type) continue;
            discardAttachedEnergy(G, G.currentPlayer as 0 | 1, c.attachedEnergy.splice(i, 1)[0]);
            discarded++;
          }
        }
        genericOutcome.baseDamage = discarded * per;
      }
      if (genericOutcome?.discardPileAttackScaledDamage) {
        const { attackName, amount } = genericOutcome.discardPileAttackScaledDamage;
        const matchCount = player.discardPile.filter(c => c.cardData.attacks?.some(a => a.name === attackName)).length;
        genericOutcome.baseDamage = matchCount * amount;
      }
      if (genericOutcome?.ownFieldAttackScaledDamage) {
        const { attackName, amount } = genericOutcome.ownFieldAttackScaledDamage;
        const matchCount = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !!c.cardData.attacks?.some(a => a.name === attackName)).length;
        genericOutcome.baseDamage = matchCount * amount;
      }
      if (genericOutcome?.ownBenchFamilyScaledDamage) {
        const { name, amount } = genericOutcome.ownBenchFamilyScaledDamage;
        const matchCount = ownBench.filter(c => c.cardData.name.includes(name)).length;
        genericOutcome.baseDamage = matchCount * amount;
      }
      if (genericOutcome?.selfMillFamilyScaledDamage) {
        const { millCount, name, amount } = genericOutcome.selfMillFamilyScaledDamage;
        let matches = 0;
        for (let i = 0; i < millCount && player.deck.length > 0; i++) {
          const milled = player.deck.pop()!;
          if (milled.cardData.name.includes(name)) matches++;
          player.discardPile.push(milled);
        }
        genericOutcome.baseDamage = matches * amount;
      }
      // The real card leaves "how many/which" up to the player; auto-maximize (discard every
      // matching Energy available, up to any printed cap) rather than opening a PendingChoice —
      // same documented simplification as the rest of this file's choice-requiring templates.
      if (genericOutcome?.selfEnergyDiscardScaledDamage) {
        const { type, max, amount } = genericOutcome.selfEnergyDiscardScaledDamage;
        const eligible = attacker.attachedEnergy.filter(e => !type || e.type === type);
        const toDiscard = eligible.slice(0, max ?? eligible.length);
        for (const e of toDiscard) {
          const idx = attacker.attachedEnergy.findIndex(x => x.id === e.id);
          if (idx >= 0) discardAttachedEnergy(G, attacker.owner, attacker.attachedEnergy.splice(idx, 1)[0]);
        }
        genericOutcome.baseDamage = toDiscard.length * amount;
      }
      if (genericOutcome?.ownFieldEnergyDiscardScaledDamage) {
        const { type, max, amount } = genericOutcome.ownFieldEnergyDiscardScaledDamage;
        let remaining = max ?? Infinity;
        let discarded = 0;
        for (const c of [player.active, ...player.bench]) {
          if (!c || remaining <= 0) continue;
          const eligible = c.attachedEnergy.filter(e => !type || e.type === type).slice(0, remaining);
          for (const e of eligible) {
            const idx = c.attachedEnergy.findIndex(x => x.id === e.id);
            if (idx >= 0) { discardAttachedEnergy(G, c.owner, c.attachedEnergy.splice(idx, 1)[0]); discarded++; remaining--; }
          }
        }
        genericOutcome.baseDamage = discarded * genericOutcome.ownFieldEnergyDiscardScaledDamage.amount;
      }
      if (genericOutcome?.handDiscardScaledDamage) {
        const { filter, max, amount } = genericOutcome.handDiscardScaledDamage;
        const matchesFilter = (c: GameCard) => {
          if (filter.kind === 'anyEnergy') return c.cardData.supertype === 'Energy';
          if (filter.kind === 'energyType') return c.cardData.supertype === 'Energy' && (c.cardData.types || []).includes(filter.type as any);
          return c.cardData.name.includes(filter.name);
        };
        const eligible = player.hand.filter(matchesFilter);
        const toDiscard = eligible.slice(0, max ?? eligible.length);
        for (const c of toDiscard) {
          const idx = player.hand.findIndex(x => x.id === c.id);
          if (idx >= 0) player.discardPile.push(player.hand.splice(idx, 1)[0]);
        }
        genericOutcome.baseDamage = toDiscard.length * amount;
      }
      if (genericOutcome?.selfRevealTopMatchDiscardRestReshuffle) {
        const { revealCount, name, amount } = genericOutcome.selfRevealTopMatchDiscardRestReshuffle;
        const revealed: typeof player.deck = [];
        for (let i = 0; i < revealCount && player.deck.length > 0; i++) revealed.push(player.deck.pop()!);
        let matches = 0;
        for (const c of revealed) {
          if (c.cardData.name.includes(name)) { matches++; player.discardPile.push(c); }
          else player.deck.push(c);
        }
        shuffleDeck(player.deck);
        genericOutcome.baseDamage = matches * amount;
      }
      const effectiveAttack = genericOutcome ? { ...attack, damage: String(genericOutcome.baseDamage) } : attack;
      const damageBreakdown = calculateDamageBreakdown(G, G.currentPlayer as 0 | 1, attacker, effectiveAttack, defender, genericOutcome?.ignoreResistance, genericOutcome?.ignoreWeakness);
      const damage = damageBreakdown.finalDamage;
      const defenderWasFullHp = defender.damage === 0;
      defender.damage += damage;
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} used ${attack.name} for ${damage} damage to ${defender.cardData.name}`, damageBreakdown, genericOutcome?.coinFlipNote);

      // 龐克頭盔-style retaliation Tool: damages the attacker back when its holder is hit,
      // regardless of whether the hit also knocked the holder out.
      let retaliation = getToolRetaliationDamage(G, defender);
      if (damage > 0 && hasPassiveAbilityNamed(G, defender, '反擊雞冠')) retaliation += 5;
      if (damage > 0 && (hasPassiveAbilityNamed(G, defender, '自動用武') || hasPassiveAbilityNamed(G, defender, '反擊') || hasPassiveAbilityNamed(G, defender, '反擊針'))) retaliation += 3;
      if (damage > 0) retaliation += getScaledRetaliation(G, defender);
      retaliation += getGrudgeVortexRetaliation(G, defender);
      if (retaliation > 0) {
        attacker.damage += retaliation * 10;
      }
      // 甲殼刺: being hit while Active discards 1 Energy attached to the attacker.
      if (damage > 0 && shouldDiscardAttackerEnergy(G, defender) && attacker.attachedEnergy.length > 0) {
        const removed = attacker.attachedEnergy.splice(Math.floor(Math.random() * attacker.attachedEnergy.length), 1)[0];
        discardAttachedEnergy(G, attacker.owner, removed);
      }
      // 炸裂針: only fires if this hit is what KOs the holder.
      if (damage > 0) {
        const defenderHpBefore = effectiveMaxHp(G, defender);
        if (defenderHpBefore > 0 && defender.damage >= defenderHpBefore) {
          const lethalRetaliation = getLethalOnlyRetaliation(G, defender);
          if (lethalRetaliation > 0) attacker.damage += lethalRetaliation * 10;
        }
      }
      // 毒刺 / 灼熱之軀-style retaliation: being hit while Active poisons/burns the attacker.
      if (damage > 0 && hasPassiveAbilityNamed(G, defender, '毒刺')) {
        attacker.statusConditions = attacker.statusConditions.filter(c => c !== 'Poisoned');
        attacker.statusConditions.push('Poisoned');
      }
      if (damage > 0 && hasPassiveAbilityNamed(G, defender, '灼熱之軀')) {
        attacker.statusConditions = attacker.statusConditions.filter(c => c !== 'Burned');
        attacker.statusConditions.push('Burned');
      }
      // 堅忍之軀: a coin flip may let a Pokémon that would be KO'd by this attack survive at 10 HP instead.
      if (hasPassiveAbilityNamed(G, defender, '堅忍之軀') || hasPassiveAbilityNamed(G, defender, '不朽身軀')) {
        const wouldBeLethal = effectiveMaxHp(G, defender) > 0 && defender.damage >= effectiveMaxHp(G, defender);
        if (wouldBeLethal) {
          const survived = Math.random() < 0.5;
          if (survived) defender.damage = effectiveMaxHp(G, defender) - 10;
          addLog(G, G.currentPlayer, 'ability', `${defender.cardData.name} 擲硬幣${survived ? '正面，以 10 HP 生還' : '反面，未能生還'}`, undefined, survived ? '正面' : '反面');
        }
      }
      // 勤奮之心 / 結實: unconditionally (no coin flip) survives a would-be-lethal hit at 10 HP,
      // but only if it entered this hit at full HP (same text, different cards).
      if ((hasPassiveAbilityNamed(G, defender, '勤奮之心') || hasPassiveAbilityNamed(G, defender, '結實')) && defenderWasFullHp) {
        const wouldBeLethal = effectiveMaxHp(G, defender) > 0 && defender.damage >= effectiveMaxHp(G, defender);
        if (wouldBeLethal) {
          defender.damage = effectiveMaxHp(G, defender) - 10;
          addLog(G, G.currentPlayer, 'ability', `${defender.cardData.name} 特性發動，以 10 HP 生還`);
        }
      }

      const defenderHp = effectiveMaxHp(G, defender);
      if (defender.damage >= defenderHp && defenderHp > 0) {
        handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
        addLog(G, G.currentPlayer, 'ko', `Knocked out ${defender.cardData.name}`);
        // 貪婪食客: this Pokémon's own attack KOing an opponent's Basic Pokémon awards 1 extra prize.
        const bonus = getBonusPrizesForAttackKo(G, G.currentPlayer as 0 | 1, attacker, defender);
        for (let i = 0; i < bonus; i++) {
          const prize = player.prizes.pop();
          if (prize) { player.hand.push(prize); player.takenPrizes++; }
        }
      }
      if (retaliation > 0) {
        const attackerHp = effectiveMaxHp(G, attacker);
        if (attacker.damage >= attackerHp && attackerHp > 0) handleKo(G, G.currentPlayer, attacker.id);
      }
      // Generic attack-text side effects: status infliction / opponent-targeted effects are
      // gated on the hit actually landing (damage > 0), matching real rules for "flip a coin, if
      // heads..."-style effects; self-targeted effects (heal, draw, recoil, self-lockout,
      // self-protection) apply regardless, matching their printed text having no damage gate.
      if (genericOutcome) {
        if (damage > 0 && genericOutcome.statusToInflict) {
          for (const status of genericOutcome.statusToInflict) applyStatusCondition(defender, status);
        }
        if (genericOutcome.selfStatusToInflict) {
          for (const status of genericOutcome.selfStatusToInflict) applyStatusCondition(attacker, status);
        }
        if (genericOutcome.healSelfAmount) attacker.damage = Math.max(0, attacker.damage - genericOutcome.healSelfAmount);
        if (genericOutcome.drawCards) drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.drawCards);
        if (genericOutcome.selfDamage) {
          attacker.damage += genericOutcome.selfDamage;
          const selfHp = effectiveMaxHp(G, attacker);
          if (selfHp > 0 && attacker.damage >= selfHp) handleKo(G, G.currentPlayer, attacker.id);
        }
        if (genericOutcome.discardAllSelfEnergy) {
          for (const energy of attacker.attachedEnergy.splice(0)) discardAttachedEnergy(G, attacker.owner, energy);
        } else if (genericOutcome.discardSelfEnergyCount) {
          for (let i = 0; i < genericOutcome.discardSelfEnergyCount && attacker.attachedEnergy.length > 0; i++) {
            const removed = attacker.attachedEnergy.splice(Math.floor(Math.random() * attacker.attachedEnergy.length), 1)[0];
            discardAttachedEnergy(G, attacker.owner, removed);
          }
        }
        if (damage > 0 && genericOutcome.discardOpponentEnergyCount) {
          for (let i = 0; i < genericOutcome.discardOpponentEnergyCount && defender.attachedEnergy.length > 0; i++) {
            const removed = defender.attachedEnergy.splice(Math.floor(Math.random() * defender.attachedEnergy.length), 1)[0];
            discardAttachedEnergy(G, defender.owner, removed);
          }
        }
        if (genericOutcome.discardOpponentTool && defender.attachedTool) {
          opponent.discardPile.push(defender.attachedTool);
          defender.attachedTool = null;
        }
        if (genericOutcome.selfTimedEffect) {
          const e = genericOutcome.selfTimedEffect;
          attacker.timedEffects = [...(attacker.timedEffects || []), { kind: e.kind, amount: e.amount, vsSubtype: e.vsSubtype, attackName: e.attackName, appliesOnTurn: G.turn + e.turnOffset }];
        }
        if (damage > 0 && genericOutcome.opponentTimedEffect) {
          const e = genericOutcome.opponentTimedEffect;
          defender.timedEffects = [...(defender.timedEffects || []), { kind: e.kind, amount: e.amount, vsSubtype: e.vsSubtype, attackName: e.attackName, appliesOnTurn: G.turn + e.turnOffset }];
        }
        // Choice-requiring generic effects (deck search, switches) auto-pick randomly among
        // the valid options — see genericAttacks.ts's file header for why.
        if (genericOutcome.deckSearchBasicPokemonToBenchCount) {
          const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
          let remaining = genericOutcome.deckSearchBasicPokemonToBenchCount;
          while (remaining > 0 && matches.length > 0) {
            const slot = player.bench.findIndex(s => s === null);
            if (slot === -1) break;
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.bench[slot] = player.deck.splice(deckIdx, 1)[0];
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchBasicEnergyToHandCount) {
          const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy'));
          let remaining = genericOutcome.deckSearchBasicEnergyToHandCount;
          while (remaining > 0 && matches.length > 0) {
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchSupertypeToHand) {
          const matches = player.deck.filter(c => c.cardData.supertype === genericOutcome!.deckSearchSupertypeToHand);
          if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.millOpponentDeckCount) {
          for (let i = 0; i < genericOutcome.millOpponentDeckCount && opponent.deck.length > 0; i++) {
            opponent.discardPile.push(opponent.deck.pop()!);
          }
        }
        if (genericOutcome.discardRandomOpponentHandCount) {
          for (let i = 0; i < genericOutcome.discardRandomOpponentHandCount && opponent.hand.length > 0; i++) {
            opponent.discardPile.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
          }
        }
        if (genericOutcome.shuffleRandomOpponentHandCardIntoDeck && opponent.hand.length > 0) {
          opponent.deck.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
          shuffleDeck(opponent.deck);
        }
        if (genericOutcome.discardActiveStadium && G.activeStadium) {
          G.players[G.activeStadium.owner].discardPile.push(G.activeStadium);
          G.activeStadium = null;
        }
        // 喵喵ex::夾尾巴逃跑 — the attacker itself bounces to hand after dealing damage. Only
        // meaningful while it is still the Active (a KO from recoil already removed it), and the
        // stacked pre-evolution history does NOT ride along into hand — same rule as handleKo's
        // 無限之影 path, so reuse flushPreEvolutionsToDiscard rather than losing the stack.
        if (genericOutcome.returnSelfAndAttachmentsToHand && player.active?.id === attacker.id) {
          for (const energy of attacker.attachedEnergy.splice(0)) {
            if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
          }
          if (attacker.attachedTool) { player.hand.push(attacker.attachedTool); attacker.attachedTool = null; }
          flushPreEvolutionsToDiscard(attacker, player.discardPile);
          attacker.damage = 0;
          attacker.statusConditions = [];
          player.hand.push(attacker);
          player.active = null;
          promoteActiveIfNeeded(G, G.currentPlayer as 0 | 1);
        }
        if (genericOutcome.selfSwitchToRandomBench) {
          const benchIdxs = player.bench.map((c, i) => c ? i : -1).filter(i => i >= 0);
          if (benchIdxs.length > 0 && player.active) {
            const idx = benchIdxs[Math.floor(Math.random() * benchIdxs.length)];
            const b = player.bench[idx]!;
            clearStatusConditionsOnLeaveActive(player.active);
            player.bench[idx] = player.active;
            player.active = b;
          }
        }
        if (genericOutcome.forceOpponentSwitchToRandomBench) {
          const benchIdxs = opponent.bench.map((c, i) => c ? i : -1).filter(i => i >= 0);
          if (benchIdxs.length > 0 && opponent.active) {
            const idx = benchIdxs[Math.floor(Math.random() * benchIdxs.length)];
            const b = opponent.bench[idx]!;
            clearStatusConditionsOnLeaveActive(opponent.active);
            opponent.bench[idx] = opponent.active;
            opponent.active = b;
          }
        }
        if (genericOutcome.moveSelfEnergyToRandomBench && attacker.attachedEnergy.length > 0) {
          const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
          if (benchTargets.length > 0) {
            const target = benchTargets[Math.floor(Math.random() * benchTargets.length)];
            const i = Math.floor(Math.random() * attacker.attachedEnergy.length);
            target.attachedEnergy.push(attacker.attachedEnergy.splice(i, 1)[0]);
          }
        }
        if (genericOutcome.benchSplashDamage) {
          const targets = opponent.bench.filter((c): c is GameCard => c !== null);
          if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            target.damage += genericOutcome.benchSplashDamage;
            const hp = effectiveMaxHp(G, target);
            if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id);
          }
        }
        if (genericOutcome.selfAllBenchSplashDamage) {
          for (const target of player.bench.filter((c): c is GameCard => c !== null)) {
            target.damage += genericOutcome.selfAllBenchSplashDamage;
            const hp = effectiveMaxHp(G, target);
            if (hp > 0 && target.damage >= hp) handleKo(G, G.currentPlayer, target.id);
          }
        }
        if (genericOutcome.drawToHandSize) drawUpTo(G, G.currentPlayer as 0 | 1, genericOutcome.drawToHandSize);
        if (genericOutcome.healSelfByDamageDealt && damage > 0) attacker.damage = Math.max(0, attacker.damage - damage);
        if (genericOutcome.moveOpponentEnergyToTheirBench && defender.attachedEnergy.length > 0) {
          const benchTargets = opponent.bench.filter((c): c is GameCard => c !== null);
          if (benchTargets.length > 0) {
            const target = benchTargets[Math.floor(Math.random() * benchTargets.length)];
            const i = Math.floor(Math.random() * defender.attachedEnergy.length);
            target.attachedEnergy.push(defender.attachedEnergy.splice(i, 1)[0]);
          }
        }
        if (genericOutcome.shuffleHandThenDrawCount) {
          player.deck.push(...player.hand);
          player.hand = [];
          shuffleDeck(player.deck);
          drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.shuffleHandThenDrawCount);
        }
        if (genericOutcome.deckSearchBasicEnergyToOwnPokemonCount) {
          const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy'));
          const ownTargets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
          if (matches.length > 0 && ownTargets.length > 0) {
            const target = ownTargets[Math.floor(Math.random() * ownTargets.length)];
            let remaining = genericOutcome.deckSearchBasicEnergyToOwnPokemonCount;
            while (remaining > 0 && matches.length > 0) {
              const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
              const deckIdx = player.deck.findIndex(c => c.id === pick.id);
              if (deckIdx >= 0) target.attachedEnergy.push({ id: pick.id, type: pick.cardData.types?.[0] || 'Colorless' });
              if (deckIdx >= 0) player.deck.splice(deckIdx, 1);
              remaining--;
            }
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchTypedEnergyToSelfCount) {
          const { type, count } = genericOutcome.deckSearchTypedEnergyToSelfCount;
          const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
          let remaining = count;
          while (remaining > 0 && matches.length > 0) {
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) {
              player.deck.splice(deckIdx, 1);
              attacker.attachedEnergy.push({ id: pick.id, type: type as any });
            }
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchTypedEnergyToAllBenchEach) {
          const type = genericOutcome.deckSearchTypedEnergyToAllBenchEach;
          const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
          for (const target of benchTargets) {
            const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
            if (matches.length === 0) break; // deck ran out of that Energy type — remaining bench slots get nothing
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) {
              player.deck.splice(deckIdx, 1);
              target.attachedEnergy.push({ id: pick.id, type: type as any });
            }
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchToolToHand) {
          const matches = player.deck.filter(c => c.cardData.subtypes.includes('Pokémon Tool'));
          if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchTypedPokemonOrEnergyToHand) {
          const { type, count } = genericOutcome.deckSearchTypedPokemonOrEnergyToHand;
          const eligible = player.deck.filter(c =>
            (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes(type as any)) ||
            (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any)));
          for (let n = 0; n < count && eligible.length > 0; n++) {
            const pick = eligible.splice(Math.floor(Math.random() * eligible.length), 1)[0];
            const i = player.deck.findIndex(c => c.id === pick.id);
            if (i >= 0) player.hand.push(player.deck.splice(i, 1)[0]);
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchAnyCardToHand) {
          if (player.deck.length > 0) {
            const i = Math.floor(Math.random() * player.deck.length);
            player.hand.push(player.deck.splice(i, 1)[0]);
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.discardEnergyToOwnBench) {
          const { type, count } = genericOutcome.discardEnergyToOwnBench;
          const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
          for (let n = 0; n < count && benchTargets.length > 0; n++) {
            const i = player.discardPile.findIndex(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
            if (i < 0) break;
            const energy = player.discardPile.splice(i, 1)[0];
            // spread them around rather than stacking on one Pokémon ("以任意方式")
            benchTargets[n % benchTargets.length].attachedEnergy.push({ id: energy.id, type: type as any, cardData: energy.cardData });
          }
        }
        if (genericOutcome.itemLockOpponentNextTurn) {
          opponent.itemLockedUntilTurn = G.turn + 1;
        }
        if (genericOutcome.evolveSelfFromDeck) {
          const matches = player.deck.filter(c => evolvesFromMatches(c.cardData, attacker.cardData.name));
          if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            const isActive = player.active?.id === attacker.id;
            const benchIdx = isActive ? -1 : player.bench.findIndex(c => c?.id === attacker.id);
            if (deckIdx >= 0 && (isActive || benchIdx >= 0)) {
              const evolution = player.deck.splice(deckIdx, 1)[0];
              evolution.attachedEnergy = attacker.attachedEnergy;
              evolution.damage = attacker.damage;
              evolution.attachedTool = attacker.attachedTool;
              stackAsPreEvolution(evolution, attacker);
              if (isActive) player.active = evolution; else player.bench[benchIdx] = evolution;
            }
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchPokemonToHandCount) {
          const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon');
          let remaining = genericOutcome.deckSearchPokemonToHandCount;
          while (remaining > 0 && matches.length > 0) {
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.discardPileSearchPokemonToHandCount) {
          const matches = player.discardPile.filter(c => c.cardData.supertype === 'Pokémon');
          let remaining = genericOutcome.discardPileSearchPokemonToHandCount;
          while (remaining > 0 && matches.length > 0) {
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const i = player.discardPile.findIndex(c => c.id === pick.id);
            if (i >= 0) player.hand.push(player.discardPile.splice(i, 1)[0]);
            remaining--;
          }
        }
        if (genericOutcome.discardPileSearchSupporterToHand) {
          const matches = player.discardPile.filter(c => c.cardData.subtypes.includes('Supporter'));
          if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const i = player.discardPile.findIndex(c => c.id === pick.id);
            if (i >= 0) player.hand.push(player.discardPile.splice(i, 1)[0]);
          }
        }
        if (genericOutcome.discardPileSearchAnyEnergyToSelf) {
          const matches = player.discardPile.filter(c => c.cardData.supertype === 'Energy');
          if (matches.length > 0) {
            const pick = matches[Math.floor(Math.random() * matches.length)];
            const i = player.discardPile.findIndex(c => c.id === pick.id);
            if (i >= 0) {
              const energy = player.discardPile.splice(i, 1)[0];
              attacker.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
            }
          }
        }
        if (genericOutcome.millOwnDeckCount) {
          for (let i = 0; i < genericOutcome.millOwnDeckCount && player.deck.length > 0; i++) {
            player.discardPile.push(player.deck.pop()!);
          }
        }
        if (genericOutcome.healRandomOwnDamagedAmount) {
          const damaged = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.damage > 0);
          if (damaged.length > 0) {
            const target = damaged[Math.floor(Math.random() * damaged.length)];
            target.damage = Math.max(0, target.damage - genericOutcome.healRandomOwnDamagedAmount);
          }
        }
        if (genericOutcome.deckSearchFamilyToHandCount) {
          const { name, count } = genericOutcome.deckSearchFamilyToHandCount;
          const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
          let remaining = count;
          while (remaining > 0 && matches.length > 0) {
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.deckSearchFamilyToBenchCount) {
          const { name, count } = genericOutcome.deckSearchFamilyToBenchCount;
          const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
          let remaining = count;
          while (remaining > 0 && matches.length > 0) {
            const slot = player.bench.findIndex(s => s === null);
            if (slot === -1) break;
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const deckIdx = player.deck.findIndex(c => c.id === pick.id);
            if (deckIdx >= 0) player.bench[slot] = player.deck.splice(deckIdx, 1)[0];
            remaining--;
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.discardPileSearchFamilyToBenchCount) {
          const { name, count } = genericOutcome.discardPileSearchFamilyToBenchCount;
          const matches = player.discardPile.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
          let remaining = count;
          while (remaining > 0 && matches.length > 0) {
            const slot = player.bench.findIndex(s => s === null);
            if (slot === -1) break;
            const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
            const i = player.discardPile.findIndex(c => c.id === pick.id);
            if (i >= 0) player.bench[slot] = player.discardPile.splice(i, 1)[0];
            remaining--;
          }
        }
        if (genericOutcome.cureAllSelfStatus) {
          attacker.statusConditions = [];
        }
        if (genericOutcome.healAllOwnTeamAmount) {
          for (const c of [player.active, ...player.bench]) {
            if (c) c.damage = Math.max(0, c.damage - genericOutcome.healAllOwnTeamAmount);
          }
        }
        if (genericOutcome.deckSearchTypedEnergyToOwnPokemonCount) {
          const { type, count } = genericOutcome.deckSearchTypedEnergyToOwnPokemonCount;
          const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
          const ownTargets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
          if (matches.length > 0 && ownTargets.length > 0) {
            const target = ownTargets[Math.floor(Math.random() * ownTargets.length)];
            let remaining = count;
            while (remaining > 0 && matches.length > 0) {
              const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
              const deckIdx = player.deck.findIndex(c => c.id === pick.id);
              if (deckIdx >= 0) {
                player.deck.splice(deckIdx, 1);
                target.attachedEnergy.push({ id: pick.id, type: type as any });
              }
              remaining--;
            }
          }
          shuffleDeck(player.deck);
        }
        if (genericOutcome.placeCountersOnRandomOpponent) {
          const targets = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null);
          if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            target.damage += genericOutcome.placeCountersOnRandomOpponent * 10;
            const hp = effectiveMaxHp(G, target);
            if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id);
          }
        }
        if (genericOutcome.splashDamageAfterSwitch && opponent.active) {
          opponent.active.damage += genericOutcome.splashDamageAfterSwitch;
          const hp = effectiveMaxHp(G, opponent.active);
          if (hp > 0 && opponent.active.damage >= hp) handleKo(G, 1 - G.currentPlayer, opponent.active.id);
        }
      }
    }

    // 祭典樂舞: while 祭典會場 is active, this Pokémon may attack a second time this turn.
    // Simplified vs. the printed text's KO/promote timing nuance — just allows one bonus
    // attack this turn rather than modeling the exact "opponent must first promote" sequencing.
    if (!G.pendingChoice && !player.usedBonusAttackThisTurn
      && hasPassiveAbilityNamed(G, attacker, '祭典樂舞') && isStadiumActive(G, '祭典會場')) {
      player.usedBonusAttackThisTurn = true;
      addLog(G, G.currentPlayer, 'ability', `${attacker.cardData.name}'s 祭典樂舞 grants a second attack this turn`);
      return;
    }

    if (!G.pendingChoice) {
      G.phase = 'end';
      ctx.events?.endTurn?.();
    }
  },

  endTurn: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    addLog(G, G.currentPlayer, 'end_turn', 'Turn ended');
    G.phase = 'end';
    ctx.events?.endTurn?.();
  },

  forfeit: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    G.winner = (1 - G.currentPlayer) as 0 | 1;
    G.winReason = 'forfeit';
    addLog(G, G.currentPlayer, 'forfeit', 'Player forfeited');
  },
};
