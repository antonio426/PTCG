import { GameCard, EnergyType, LegalAction } from '@ptcg/shared';
import { PtcgGameState, GamePhase } from './GameState';

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

function canPayEnergyCost(attachedEnergy: { type: string }[], cost: EnergyType[]): boolean {
  if (cost.length === 0) return true;

  const counts = getEnergyCounts(attachedEnergy);
  const specificCosts = cost.filter(c => c !== 'Colorless');
  const colorlessCount = cost.filter(c => c === 'Colorless').length;

  const remaining = { ...counts };

  for (const requiredType of specificCosts) {
    if (!remaining[requiredType] || remaining[requiredType] <= 0) return false;
    remaining[requiredType]--;
  }

  const totalRemaining = Object.values(remaining).reduce((a, b) => a + b, 0);
  return totalRemaining >= colorlessCount;
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

export function canEvolve(G: PtcgGameState, playerIndex: number, cardId: string, targetId: string): boolean {
  const player = playerState(G, playerIndex, ['main']);
  if (!player) return false;

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return false;
  if (card.cardData.supertype !== 'Pokémon') return false;

  const evolvesFrom = card.cardData.evolvesFrom;
  if (!evolvesFrom) return false;

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;
  if (!target) return false;
  if (target.cardData.name !== evolvesFrom) return false;
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

  const retreatCost = player.active.cardData.retreatCost?.length ?? 0;
  const attachedEnergyCount = player.active.attachedEnergy.length;

  return attachedEnergyCount >= retreatCost;
}

export function canAttack(G: PtcgGameState, playerIndex: number, attackIndex: number): boolean {
  const player = playerState(G, playerIndex, ['main', 'attack']);
  if (!player) return false;
  if (!player.active) return false;

  const attack = player.active.cardData.attacks?.[attackIndex];
  if (!attack) return false;

  return canPayEnergyCost(player.active.attachedEnergy, attack.cost);
}

export function getLegalMoves(G: PtcgGameState, playerIndex: number): LegalAction[] {
  const legalMoves: LegalAction[] = [];
  const player = G.players[playerIndex as 0 | 1];

  if (G.currentPlayer !== playerIndex) return legalMoves;

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
        legalMoves.push({
          type: 'play_trainer',
          description: `Play ${card.cardData.name}`,
          payload: { cardId: card.id },
        });
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
