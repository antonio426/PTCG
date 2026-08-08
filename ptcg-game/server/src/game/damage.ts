import { Attack, GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';

/** Apply weakness (×2) / resistance (flat reduction) for `attacker`'s types onto a given base damage number. */
export function applyWeaknessResistance(baseDamageIn: number, attacker: GameCard, defender: GameCard): number {
  let baseDamage = baseDamageIn;
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

export function calculateDamage(attacker: GameCard, attack: Attack, defender: GameCard): number {
  let baseDamage = parseInt(attack.damage) || 0;
  if (isNaN(baseDamage)) baseDamage = 0;
  return applyWeaknessResistance(baseDamage, attacker, defender);
}

export function applyDamage(G: PtcgGameState, playerIndex: number, targetId: string, damage: number): void {
  const player = G.players[playerIndex as 0 | 1];

  const target = player.active?.id === targetId
    ? player.active
    : player.bench.find(c => c?.id === targetId) || null;

  if (!target) return;
  target.damage += damage;
}

/** Standard-format prize rule: Mega ("超級...ex") = 3 prizes, other ex/V/VMAX/VSTAR/GX = 2, everything else = 1. */
export function prizesForKo(card: GameCard): number {
  if (card.cardData.name.startsWith('超級') && card.cardData.subtypes.includes('ex')) return 3;
  const bigSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  if (card.cardData.subtypes.some(s => bigSubtypes.includes(s))) return 2;
  return 1;
}

export function handleKo(G: PtcgGameState, koPlayerIndex: number, koCardId: string): void {
  const koPlayer = G.players[koPlayerIndex as 0 | 1];
  const attackingPlayer = G.players[(1 - koPlayerIndex) as 0 | 1];
  let koCard: GameCard | undefined;

  if (koPlayer.active?.id === koCardId) {
    koCard = koPlayer.active;
    if (koCard.attachedTool) koPlayer.discardPile.push(koCard.attachedTool);
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
      koCard = koPlayer.bench[idx]!;
      if (koCard.attachedTool) koPlayer.discardPile.push(koCard.attachedTool);
      koPlayer.discardPile.push(koCard);
      koPlayer.bench[idx] = null;
    }
  }

  const prizeCount = koCard ? prizesForKo(koCard) : 1;
  for (let i = 0; i < prizeCount; i++) {
    const prize = attackingPlayer.prizes.pop();
    if (prize) { attackingPlayer.hand.push(prize); attackingPlayer.takenPrizes++; }
  }
}
