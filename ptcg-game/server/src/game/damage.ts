import { Attack, GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';

export function calculateDamage(attacker: GameCard, attack: Attack, defender: GameCard): number {
  let baseDamage = parseInt(attack.damage) || 0;
  if (isNaN(baseDamage)) baseDamage = 0;

  const attackerTypes = attacker.cardData.types || [];

  for (const attackerType of attackerTypes) {
    const weaknesses = defender.cardData.weaknesses || [];
    for (const weakness of weaknesses) {
      if (weakness.type === attackerType) {
        if (weakness.value === '×2') baseDamage *= 2;
      }
    }

    const resistances = defender.cardData.resistances || [];
    for (const resistance of resistances) {
      if (resistance.type === attackerType) {
        const resistValue = parseInt(resistance.value);
        if (!isNaN(resistValue)) baseDamage = Math.max(0, baseDamage - resistValue);
      }
    }
  }

  return baseDamage;
}

export function applyDamage(G: PtcgGameState, playerIndex: number, targetId: string, damage: number): void {
  const player = G.players[playerIndex as 0 | 1];

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;

  if (!target) return;
  target.damage += damage;
}

export function handleKo(G: PtcgGameState, koPlayerIndex: number, koCardId: string): void {
  const koPlayer = G.players[koPlayerIndex as 0 | 1];
  const attackingPlayer = G.players[(1 - koPlayerIndex) as 0 | 1];

  if (koPlayer.active?.id === koCardId) {
    const koCard = koPlayer.active;
    koPlayer.discardPile.push(koCard);
    koPlayer.active = null;

    const promo = koPlayer.bench.find(s => s !== null);
    if (promo) {
      const idx = koPlayer.bench.indexOf(promo);
      koPlayer.active = promo;
      koPlayer.bench[idx] = null;
    }
  } else {
    const idx = koPlayer.bench.findIndex(c => c?.id === koCardId);
    if (idx >= 0) {
      const koCard = koPlayer.bench[idx]!;
      koPlayer.discardPile.push(koCard);
      koPlayer.bench[idx] = null;
    }
  }

  const prize = attackingPlayer.prizes.pop();
  if (prize) attackingPlayer.takenPrizes++;
}
