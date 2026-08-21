import { resolveGenericAttackEffect, NEUTRAL_BOARD } from '../game/effects/genericAttacks';
import { abilityEffects } from '../game/effects/abilities';
import { PASSIVE_ABILITY_NAMES } from '../game/effects/passiveAbilities';
import { attackEffects, attackEffectKey } from '../game/effects/attacks';
import { normalizeAbilityName } from '../game/effects/types';

export /**
 * `--covered`: decks built out of cards whose printed effects the engine actually implements.
 *
 * The preset pool and the adversarial pool between them never touch most of what got implemented
 * for custom decks — those cards are simply not in any preset list — so every ability and attack
 * template written for the Standard-wide push had been verified by unit tests and never once
 * played. This samples that population instead: 8 distinct implemented Basics per deck, padded
 * with basic Energy of the types their attacks actually cost, so the attacks are payable.
 *
 * The sample (not the games) is seeded, so a violation can be re-triaged with the same deck list.
 */
function buildCoveredDecks(cards: any[], deckCount: number, seed: number): { name: string; entries: { cardId: string; count: number }[] }[] {
  const std = cards.filter(c => c.legalities?.standard === 'Legal');
  const implemented = (c: any): boolean => {
    if (c.supertype !== 'Pokémon') return false;
    for (const ab of c.abilities || []) {
      const n = normalizeAbilityName(ab.name || '');
      if (n in abilityEffects || PASSIVE_ABILITY_NAMES.has(n)) return true;
    }
    for (const a of c.attacks || []) {
      if (attackEffectKey(c.name, a.name) in attackEffects) return true;
      if (!a.text) continue;
      try {
        const out = resolveGenericAttackEffect(a.text, a.damage || '0', NEUTRAL_BOARD);
        if (out && Object.keys(out).some(k => k !== 'baseDamage' && k !== 'coinFlipNote')) return true;
      } catch { /* a throwing branch still means the text is handled */ }
    }
    return false;
  };

  // Deterministic sample: a card's position in the shuffle is a hash of its id and the seed, so
  // the same --seed rebuilds the same decks while a different one reaches different cards.
  const hash = (s: string, salt: number) => {
    let h = salt >>> 0;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    return h;
  };
  const seenName = new Set<string>();
  const pool = std
    .filter(c => c.subtypes?.includes('Basic') && (c.attacks?.length ?? 0) > 0 && implemented(c))
    .filter(c => !seenName.has(c.name) && seenName.add(c.name))
    .sort((a, b) => hash(a.id, seed) - hash(b.id, seed));

  const energyByType = new Map<string, string>();
  for (const c of std) {
    if (c.supertype !== 'Energy' || !c.subtypes?.includes('Basic Energy')) continue;
    for (const ty of c.types || []) if (!energyByType.has(ty)) energyByType.set(ty, c.id);
  }
  const colorless = energyByType.get('Colorless') ?? [...energyByType.values()][0];

  const decks: { name: string; entries: { cardId: string; count: number }[] }[] = [];
  for (let d = 0; d < deckCount; d++) {
    const picks = pool.slice(d * 8, d * 8 + 8);
    if (picks.length < 8) break;
    // Pad with the Energy their own attack costs ask for, so the attacks are actually reachable —
    // a deck of implemented Pokémon that can never pay for them tests nothing.
    const costTypes = new Map<string, number>();
    for (const c of picks) {
      for (const a of c.attacks || []) {
        for (const ty of a.cost || []) if (ty !== 'Colorless') costTypes.set(ty, (costTypes.get(ty) || 0) + 1);
      }
    }
    const wanted = [...costTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([ty]) => energyByType.get(ty)).filter((x): x is string => !!x);
    const energyIds = wanted.length ? wanted : [colorless];
    const perEnergy = Math.floor((60 - picks.length * 4) / energyIds.length);
    const entries = [
      ...picks.map(c => ({ cardId: c.id, count: 4 })),
      ...energyIds.map((id, i) => ({ cardId: id, count: i === 0 ? 60 - picks.length * 4 - perEnergy * (energyIds.length - 1) : perEnergy })),
    ];
    decks.push({ name: `covered #${d + 1}: ${picks.slice(0, 3).map(c => c.name).join('/')}…`, entries });
  }
  return decks;
}
