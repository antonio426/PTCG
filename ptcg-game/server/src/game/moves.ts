import { GameCard } from '@ptcg/shared';
import { PtcgGameState, PendingChoice } from './GameState';
import { canPlayPokemon, canEvolve, canAttachEnergy, canRetreat, canAttack, effectiveRetreatCost } from './validation';
import { clearStatusConditionsOnLeaveActive } from './statusConditions';
import { calculateDamage, handleKo, prizesForKo } from './damage';
import {
  EffectContext, EffectStep,
  hasTrainerEffect, startTrainerEffect, resumeTrainerEffect,
  hasAbilityEffect, startAbilityEffect, resumeAbilityEffect,
  hasAttackEffect, startAttackEffect, resumeAttackEffect,
} from './effects';

function applyEffectStep(G: PtcgGameState, player: 0 | 1, effectKey: string, step: EffectStep): void {
  if (step === 'done') {
    G.pendingChoice = null;
  } else {
    G.pendingChoice = { player, effectKey, ...step };
  }
}

function addLog(G: PtcgGameState, player: number, action: string, details: string) {
  G.turnLog.push({
    player: player as 0 | 1,
    turn: G.turn,
    action,
    details,
    timestamp: Date.now(),
  });
}

export const moves = {
  drawCard: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    if (G.phase !== 'draw') return;
    if (G.currentPlayer !== parseInt(ctx.currentPlayer)) return;

    const player = G.players[G.currentPlayer];

    if (player.deck.length === 0) {
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

    player.discardPile.push(oldCard);

    if (isActive) {
      player.active = evolution;
    } else {
      player.bench[benchIdx] = evolution;
    }

    evolution.attachedEnergy = savedEnergy;
    evolution.damage = savedDamage;
    evolution.attachedTool = savedTool;
    player.cardsPlayedThisTurn++;
    addLog(G, G.currentPlayer, 'evolve', `Evolved into ${evolution.cardData.name}`);
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
    });

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
    if (isSupporter && (player.supporterPlayedThisTurn || G.turn === 1)) {
      player.hand.push(trainerCard);
      return;
    }
    if (G.pendingChoice) {
      player.hand.push(trainerCard);
      return;
    }

    const cardName = trainerCard.cardData.name;
    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: trainerCard.id };

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
      applyEffectStep(G, G.currentPlayer as 0 | 1, `trainer:${cardName}`, step);
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
    const ability = source.cardData.abilities?.find(a => hasAbilityEffect(a.name));
    if (!ability) return;

    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: source.id };
    const step = startAbilityEffect(ability.name, ctxInfo);
    applyEffectStep(G, G.currentPlayer as 0 | 1, `ability:${ability.name}`, step);
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

    const colonIdx = effectKey.indexOf(':');
    const kind = effectKey.slice(0, colonIdx);
    const name = effectKey.slice(colonIdx + 1);
    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: '' };

    let step: EffectStep;
    if (kind === 'trainer') step = resumeTrainerEffect(name, ctxInfo, context, selection);
    else if (kind === 'ability') step = resumeAbilityEffect(name, ctxInfo, context, selection);
    else {
      const [pokemonName, attackName] = name.split('::');
      step = resumeAttackEffect(pokemonName, attackName, ctxInfo, context, selection);
    }
    applyEffectStep(G, G.currentPlayer as 0 | 1, effectKey, step);
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

    const player = G.players[G.currentPlayer];
    const activePokemon = player.active;

    if (!activePokemon) return;
    const retreatCost = effectiveRetreatCost(G, activePokemon);
    if (discardEnergyIds && discardEnergyIds.length > 0) {
      for (const id of discardEnergyIds.slice(0, retreatCost)) {
        const idx = activePokemon.attachedEnergy.findIndex(e => e.id === id);
        if (idx >= 0) activePokemon.attachedEnergy.splice(idx, 1);
      }
    } else {
      activePokemon.attachedEnergy.splice(0, retreatCost);
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
    addLog(G, G.currentPlayer, 'retreat', `Retreated to ${benchPokemon!.cardData.name}`);
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
      const selfHp = parseInt(attacker.cardData.hp || '0', 10);
      if (selfHp > 0 && attacker.damage >= selfHp) handleKo(G, G.currentPlayer, attacker.id);
      G.phase = 'end';
      ctx.events?.endTurn?.();
      return;
    }

    if (hasAttackEffect(attacker.cardData.name, attack.name)) {
      const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: attacker.id };
      const step = startAttackEffect(attacker.cardData.name, attack.name, ctxInfo);
      applyEffectStep(G, G.currentPlayer as 0 | 1, `attack:${attacker.cardData.name}::${attack.name}`, step);
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} used "${attack.name}"!`);
    } else {
      const damage = calculateDamage(attacker, attack, defender);
      defender.damage += damage;
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} used ${attack.name} for ${damage} damage to ${defender.cardData.name}`);

      const defenderHp = parseInt(defender.cardData.hp || '0');
      if (defender.damage >= defenderHp && defenderHp > 0) {
        handleKo(G, 1 - G.currentPlayer, defender.id);
        addLog(G, G.currentPlayer, 'ko', `Knocked out ${defender.cardData.name}`);
      }
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
