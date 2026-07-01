import { PtcgGameState } from './GameState';
import { canPlayPokemon, canEvolve, canAttachEnergy, canRetreat, canAttack } from './validation';
import { calculateDamage, handleKo } from './damage';

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

    player.discardPile.push(oldCard);

    if (isActive) {
      player.active = evolution;
    } else {
      player.bench[benchIdx] = evolution;
    }

    evolution.attachedEnergy = savedEnergy;
    evolution.damage = savedDamage;
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
    if (isSupporter && player.supporterPlayedThisTurn) {
      player.hand.push(trainerCard);
      return;
    }

    const cardName = trainerCard.cardData.name;

    if (cardName.includes('Professor') && cardName.includes('Research')) {
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
      player.bench[benchIdx] = player.active;
      player.active = benchPokemon;
    }

    player.discardPile.push(trainerCard);
    player.cardsPlayedThisTurn++;
    if (isSupporter) player.supporterPlayedThisTurn = true;
    addLog(G, G.currentPlayer, 'play_trainer', `Played ${cardName}`);
  },

  useAbility: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    addLog(G, G.currentPlayer, 'use_ability', `Ability use attempted`);
  },

  retreat: ({ G, ctx }: { G: PtcgGameState; ctx: any }, targetBenchPosition?: number) => {
    if (!canRetreat(G, G.currentPlayer)) return;

    const player = G.players[G.currentPlayer];
    const activePokemon = player.active;

    if (!activePokemon) return;
    const retreatCost = activePokemon.cardData.retreatCost?.length ?? 0;
    activePokemon.attachedEnergy.splice(0, retreatCost);

    let benchIdx = targetBenchPosition ?? -1;
    if (benchIdx < 0 || benchIdx >= 5 || player.bench[benchIdx] === null) {
      benchIdx = player.bench.findIndex(s => s !== null);
    }
    if (benchIdx < 0) return;

    const benchPokemon = player.bench[benchIdx];
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

    const damage = calculateDamage(attacker, attack, defender);
    defender.damage += damage;
    addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} used ${attack.name} for ${damage} damage to ${defender.cardData.name}`);

    const defenderHp = parseInt(defender.cardData.hp || '0');
    if (defender.damage >= defenderHp && defenderHp > 0) {
      handleKo(G, 1 - G.currentPlayer, defender.id);
      addLog(G, G.currentPlayer, 'ko', `Knocked out ${defender.cardData.name}`);
    }

    G.phase = 'end';
    ctx.events?.endTurn?.();
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
