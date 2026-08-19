import { describe, it, expect } from 'vitest';
import { normalizeCardName, normalizeAbilityName } from '../src/game/effects/types';
import { abilityEffects } from '../src/game/effects/abilities';
import { trainerEffects } from '../src/game/effects/trainers';
import { PASSIVE_ABILITY_NAMES } from '../src/game/effects/passiveAbilities';

/**
 * Scraped names carry invisible junk (zero-width chars, a literal `[特性] ` prefix, and a stray
 * space between the two). Every registry lookup goes through these helpers — when they miss, the
 * lookup fails silently and the effect just never fires, which is invisible in testing because
 * the offending character doesn't print. See CLAUDE.md, "Recurring pitfalls".
 */
describe('normalizeCardName', () => {
  const CLEAN = '璀璨鱗片';

  it.each([
    ['plain', CLEAN],
    ['zero-width non-joiner prefix', '‌璀璨鱗片'],
    ['zero-width space prefix', '​璀璨鱗片'],
    ['zero-width + literal space', '‌ 璀璨鱗片'],
    ['leading whitespace', '  璀璨鱗片'],
    ['trailing whitespace', '璀璨鱗片 '],
  ])('normalizes the %s form to the registry key', (_label, raw) => {
    expect(normalizeCardName(raw)).toBe(CLEAN);
  });

  it('strips the [特性] prefix an ability name carries on the official site', () => {
    expect(normalizeAbilityName('[特性] 璀璨鱗片')).toBe(CLEAN);
    expect(normalizeAbilityName('[特性]璀璨鱗片')).toBe(CLEAN);
    expect(normalizeAbilityName('‌[特性] 璀璨鱗片')).toBe(CLEAN);
  });

  it('returns an empty string for a missing name rather than throwing', () => {
    // At least one real card (S5R-059 爆炸頭水牛) has an ability entry scraped with no name.
    expect(normalizeCardName(undefined)).toBe('');
    expect(normalizeCardName(null)).toBe('');
    expect(normalizeCardName('')).toBe('');
  });

  it('leaves an already-clean name untouched', () => {
    expect(normalizeCardName('博士的研究')).toBe('博士的研究');
  });

  it('does not strip characters from the middle of a name', () => {
    expect(normalizeCardName('火箭隊的‌妨礙機器人')).toBe('火箭隊的‌妨礙機器人');
  });
});

describe('every effect registry key is already normalized', () => {
  // A registry key that itself carries scraped junk can never be hit, since every lookup
  // normalizes the incoming name first — this is the mirror image of the lookup-side bug.
  it.each([
    ['abilityEffects', Object.keys(abilityEffects)],
    ['trainerEffects', Object.keys(trainerEffects)],
    ['PASSIVE_ABILITY_NAMES', [...PASSIVE_ABILITY_NAMES]],
  ])('%s', (_name, keys) => {
    expect(keys.filter(k => normalizeCardName(k) !== k)).toEqual([]);
  });

  it('has no name registered as both a triggered and a passive ability', () => {
    // The two registries are consulted by different code paths (useAbility vs hasAbility); a name
    // in both means one of them is dead code that will never be reached for that card.
    const overlap = Object.keys(abilityEffects).filter(k => PASSIVE_ABILITY_NAMES.has(k));
    expect(overlap).toEqual([]);
  });
});
