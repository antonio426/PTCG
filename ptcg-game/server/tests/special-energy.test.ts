import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { energyUnitsProvided, ALL_ENERGY_TYPES, specialEnergyRetaliation, specialEnergyBlocksAttackEffects } from '../src/game/effects/specialEnergy';
import { effectiveMaxHp } from '../src/game/damage';
import { getPassiveDamageBonus, getPrizeReduction, isDamageBlocked } from '../src/game/effects/passiveAbilities';
import { applyStatusCondition } from '../src/game/effects/primitives';
import { moves } from '../src/game/moves';
import { processBetweenTurns } from '../src/game/statusConditions';
import { makePlayer, makeState } from './fixtures';
import { canPayEnergyCost, effectiveRetreatCost } from '../src/game/validation';
import { BASIC_ENERGY, BASIC_MON, makeCard, makeGameCard } from './fixtures';
import type { EnergyType, Subtype } from '@ptcg/shared';

const cards: any[] = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'cards.json'), 'utf8')).data;
const norm = (n: string) => String(n).replace(/^[‌​\s]+/, '').trim();
const special = (name: string) =>
  cards.find(c => norm(c.name) === name
    && (c.subtypes ?? []).includes('Special Energy')
    && c.legalities?.standard === 'Legal');

/** An attachment exactly as moves.attachEnergy builds one from the real card. */
const attach = (name: string) => {
  const card = special(name);
  if (!card) throw new Error(`no Standard print of ${name}`);
  return { id: `e-${name}`, type: (card.types?.[0] ?? 'Colorless') as string, cardData: card };
};
const basicEnergy = (type: string) => ({
  id: `b-${type}`, type,
  cardData: makeCard({ name: `基本${type}能量`, supertype: 'Energy', subtypes: ['Basic Energy'] as Subtype[], types: [type] as any }),
});

const holderOf = (subtypes: string[]) =>
  makeGameCard(makeCard({ name: '持有者', hp: '100', types: ['Colorless'], subtypes: subtypes as Subtype[] }), 0);

const BASIC = holderOf(['Basic']);
const STAGE1 = holderOf(['Stage 1']);
const STAGE2 = holderOf(['Stage 2']);

const typesOf = (name: string, holder = BASIC) =>
  energyUnitsProvided(attach(name), holder).map(u => u.types);

/**
 * Special Energy pays for attacks differently from basic Energy, and the engine read only the
 * flat `AttachedEnergy.type` — one Colorless for most of them. The texts driving this were
 * missing from both data sources until they were scraped off the official card page.
 */
describe('what each Special Energy provides', () => {
  it('every Standard Special Energy print carries its printed text', () => {
    const bare = cards
      .filter(c => c.legalities?.standard === 'Legal' && (c.subtypes ?? []).includes('Special Energy'))
      .filter(c => !(c.rules ?? []).length);
    expect(bare.map(c => `${c.id} ${c.name}`)).toEqual([]);
  });

  it.each([
    ['富裕能量', ['Colorless']],
    ['回力鏢能量', ['Colorless']],
    ['薄霧能量', ['Colorless']],
    ['扣殺能量', ['Colorless']],
    ['硬岩【鬥】能量', ['Fighting']],
    ['感應【超】能量', ['Psychic']],
    ['增強【草】能量', ['Grass']],
    ['泡沫【水】能量', ['Water']],
  ])('%s is a single %s', (name, expected) => {
    expect(typesOf(name)).toEqual([expected]);
  });

  it('火箭隊能量 provides TWO units, each payable as 超 or 惡', () => {
    // 「視為提供2個【超】【惡】2種屬性的能量」 — the flat type read this as one Colorless.
    const units = typesOf('火箭隊能量');
    expect(units).toHaveLength(2);
    for (const u of units) expect(u.slice().sort()).toEqual(['Darkness', 'Psychic']);
  });

  it('古舊能量 is a wildcard on any Pokémon', () => {
    for (const holder of [BASIC, STAGE1, STAGE2]) {
      const units = energyUnitsProvided(attach('古舊能量'), holder);
      expect(units).toHaveLength(1);
      expect(units[0].types.slice().sort()).toEqual([...ALL_ENERGY_TYPES].sort());
    }
  });

  it('稜鏡能量 is a wildcard only on a Basic', () => {
    expect(typesOf('稜鏡能量', BASIC)[0].slice().sort()).toEqual([...ALL_ENERGY_TYPES].sort());
    expect(typesOf('稜鏡能量', STAGE1)).toEqual([['Colorless']]);
    expect(typesOf('稜鏡能量', STAGE2)).toEqual([['Colorless']]);
  });

  it('新衝天能量 gives two wildcards only on a Stage 2', () => {
    const onStage2 = typesOf('新衝天能量', STAGE2);
    expect(onStage2).toHaveLength(2);
    for (const u of onStage2) expect(u.slice().sort()).toEqual([...ALL_ENERGY_TYPES].sort());
    expect(typesOf('新衝天能量', BASIC)).toEqual([['Colorless']]);
    expect(typesOf('新衝天能量', STAGE1)).toEqual([['Colorless']]);
  });

  it('燃火能量 gives three Colorless only on an evolved Pokémon', () => {
    expect(typesOf('燃火能量', BASIC)).toEqual([['Colorless']]);
    expect(typesOf('燃火能量', STAGE1)).toEqual([['Colorless'], ['Colorless'], ['Colorless']]);
    expect(typesOf('燃火能量', STAGE2)).toEqual([['Colorless'], ['Colorless'], ['Colorless']]);
  });

  it('falls back to the flat type for basic Energy', () => {
    expect(energyUnitsProvided(basicEnergy('Fire'), BASIC)).toEqual([{ types: ['Fire'] }]);
  });
});

describe('paying an attack cost with Special Energy', () => {
  const pay = (attached: any[], cost: string[], holder = BASIC) =>
    canPayEnergyCost(attached, cost as EnergyType[], 0, holder);

  it('火箭隊能量 alone covers a two-symbol 超/惡 cost', () => {
    expect(pay([attach('火箭隊能量')], ['Psychic', 'Darkness'])).toBe(true);
  });

  it('火箭隊能量 does not cover a type it does not provide', () => {
    expect(pay([attach('火箭隊能量')], ['Fire'])).toBe(false);
  });

  it('古舊能量 pays any single symbol', () => {
    for (const t of ['Fire', 'Water', 'Metal', 'Dragon']) {
      expect(pay([attach('古舊能量')], [t])).toBe(true);
    }
  });

  /**
   * The reason the matcher spends the least flexible unit first: a wildcard must not be burned on
   * a symbol that an exact-type unit could have paid.
   */
  it('spends the exact type before the wildcard', () => {
    expect(pay([attach('古舊能量'), basicEnergy('Fire')], ['Fire', 'Colorless'])).toBe(true);
  });

  it('still refuses a cost that genuinely cannot be met', () => {
    expect(pay([attach('古舊能量'), basicEnergy('Fire')], ['Fire', 'Fire', 'Colorless'])).toBe(false);
  });

  it('稜鏡能量 pays a coloured symbol on a Basic but not on a Stage 1', () => {
    expect(pay([attach('稜鏡能量')], ['Psychic'], BASIC)).toBe(true);
    expect(pay([attach('稜鏡能量')], ['Psychic'], STAGE1)).toBe(false);
  });

  it('燃火能量 covers a three-Colorless cost once the holder has evolved', () => {
    expect(pay([attach('燃火能量')], ['Colorless', 'Colorless', 'Colorless'], STAGE1)).toBe(true);
    expect(pay([attach('燃火能量')], ['Colorless', 'Colorless', 'Colorless'], BASIC)).toBe(false);
  });

  it('behaves exactly as before for basic Energy', () => {
    const attached = [basicEnergy('Fire'), basicEnergy('Water'), basicEnergy('Colorless')];
    expect(pay(attached, ['Fire', 'Water', 'Colorless'])).toBe(true);
    expect(pay(attached, ['Fire', 'Fire'])).toBe(false);
    expect(pay(attached, [])).toBe(true);
  });

  it('honours a Colorless-cost reduction', () => {
    expect(canPayEnergyCost([basicEnergy('Fire')], ['Fire', 'Colorless'] as EnergyType[], 1, BASIC)).toBe(true);
  });

  it('without a holder, falls back to the flat type so old callers are unchanged', () => {
    // heuristicAI still calls it this way; Special Energy then reads as its plain type.
    expect(canPayEnergyCost([attach('古舊能量')], ['Fire'] as EnergyType[])).toBe(false);
  });
});

/**
 * The secondary effects, each wired into the passive hook that already existed for its shape
 * rather than a new code path: max-HP bonus, retreat waiver, damage bonus, benched immunity,
 * status immunity, retaliation and the prize reduction.
 */
describe('Special Energy secondary effects', () => {
  const mon = (types: string[], subtypes: string[] = ['Basic']) =>
    makeGameCard(makeCard({ name: '持有者', hp: '100', types: types as any, subtypes: subtypes as Subtype[] }), 0);
  const carrying = (holder: ReturnType<typeof mon>, name: string) => {
    holder.attachedEnergy = [attach(name)];
    return holder;
  };

  it('增強【草】能量 gives a Grass holder +20 max HP, and nothing to others', () => {
    const G = makeState();
    expect(effectiveMaxHp(G, carrying(mon(['Grass']), '增強【草】能量'))).toBe(120);
    expect(effectiveMaxHp(G, carrying(mon(['Fire']), '增強【草】能量'))).toBe(100);
  });

  it('磁鐵【鋼】能量 waives retreat for a Metal holder only', () => {
    const metal = carrying(mon(['Metal']), '磁鐵【鋼】能量');
    metal.cardData = { ...metal.cardData, retreatCost: ['Colorless', 'Colorless'] as any };
    const other = carrying(mon(['Fire']), '磁鐵【鋼】能量');
    other.cardData = { ...other.cardData, retreatCost: ['Colorless', 'Colorless'] as any };
    const G = makeState({ players: [makePlayer({ active: metal }), makePlayer({ active: mon(['Colorless']) })] });
    expect(effectiveRetreatCost(G, metal)).toBe(0);
    expect(effectiveRetreatCost(G, other)).toBe(2);
  });

  it('伏特【雷】能量 adds 20 damage for a Lightning attacker', () => {
    const G = makeState();
    const lightning = carrying(mon(['Lightning']), '伏特【雷】能量');
    const other = carrying(mon(['Water']), '伏特【雷】能量');
    const target = mon(['Colorless']);
    expect(getPassiveDamageBonus(G, 0, lightning, target)).toBe(20);
    expect(getPassiveDamageBonus(G, 0, other, target)).toBe(0);
  });

  it('暗影【惡】能量 makes a Benched Darkness holder untouchable', () => {
    const benched = carrying(mon(['Darkness']), '暗影【惡】能量');
    const G = makeState({
      players: [
        makePlayer({ active: mon(['Colorless']) }),
        makePlayer({ active: mon(['Colorless'], ['Basic']), bench: [benched, null, null, null, null] }),
      ],
    });
    benched.owner = 1;
    expect(isDamageBlocked(G, mon(['Colorless']), benched)).toBe(true);
    // In the Active spot the same card is a normal target.
    G.players[1].active = benched;
    G.players[1].bench = [null, null, null, null, null];
    expect(isDamageBlocked(G, mon(['Colorless']), benched)).toBe(false);
  });

  it('泡沫【水】能量 keeps a Water holder free of Special Conditions', () => {
    const G = makeState();
    const water = carrying(mon(['Water']), '泡沫【水】能量');
    G.players[0].active = water;
    applyStatusCondition(G, water, 'Asleep');
    expect(water.statusConditions).toEqual([]);

    const fire = carrying(mon(['Fire']), '泡沫【水】能量');
    G.players[0].active = fire;
    applyStatusCondition(G, fire, 'Asleep');
    expect(fire.statusConditions).toContain('Asleep');
  });

  it('扣殺能量 puts 2 counters back on the attacker', () => {
    expect(specialEnergyRetaliation(carrying(mon(['Colorless']), '扣殺能量'))).toBe(20);
    expect(specialEnergyRetaliation(mon(['Colorless']))).toBe(0);
  });

  it('古舊能量 reduces a prize once per game, then never again', () => {
    const victim = carrying(mon(['Colorless']), '古舊能量');
    const attacker = mon(['Colorless']);
    const G = makeState();
    expect(getPrizeReduction(G, 0, victim, attacker)).toBe(1);
    expect(G.players[0].usedAncientEnergyPrizeReduction).toBe(true);
    // 「對戰中…只生效1次」 — the second KO gets nothing, even from a different copy.
    expect(getPrizeReduction(G, 0, carrying(mon(['Colorless']), '古舊能量'), attacker)).toBe(0);
  });

  it('薄霧能量 blocks attack effects for anything, 硬岩【鬥】能量 only for Fighting', () => {
    expect(specialEnergyBlocksAttackEffects(carrying(mon(['Fire']), '薄霧能量'))).toBe(true);
    expect(specialEnergyBlocksAttackEffects(carrying(mon(['Fighting']), '硬岩【鬥】能量'))).toBe(true);
    expect(specialEnergyBlocksAttackEffects(carrying(mon(['Fire']), '硬岩【鬥】能量'))).toBe(false);
  });
});

describe('Special Energy timing effects', () => {
  const mon2 = (types: string[], subtypes: string[] = ['Basic']) =>
    makeGameCard(makeCard({ name: '持有者', hp: '100', types: types as any, subtypes: subtypes as Subtype[] }), 0);

  it('富裕能量 draws 4 when attached from hand', () => {
    const energy = makeGameCard(special('富裕能量'), 0);
    const active = mon2(['Colorless']);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active, hand: [energy], deck: Array.from({ length: 10 }, () => makeGameCard(BASIC_MON, 0)) }),
        makePlayer({ active: mon2(['Colorless']) }),
      ],
    });
    moves.attachEnergy({ G, ctx: { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } } as any, energy.id, active.id);
    expect(active.attachedEnergy).toHaveLength(1);
    expect(G.players[0].hand).toHaveLength(4);
    expect(G.players[0].deck).toHaveLength(6);
  });

  it('a plain energy attaches without drawing', () => {
    const energy = makeGameCard(BASIC_ENERGY, 0);
    const active = mon2(['Colorless']);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active, hand: [energy], deck: Array.from({ length: 10 }, () => makeGameCard(BASIC_MON, 0)) }),
        makePlayer({ active: mon2(['Colorless']) }),
      ],
    });
    moves.attachEnergy({ G, ctx: { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } } as any, energy.id, active.id);
    expect(G.players[0].hand).toHaveLength(0);
    expect(G.players[0].deck).toHaveLength(10);
  });

  it('燃火能量 discards itself at the end of its own controller\'s turn', () => {
    const mine = mon2(['Colorless']);
    mine.attachedEnergy = [attach('燃火能量')];
    const theirs = mon2(['Colorless']);
    theirs.attachedEnergy = [attach('燃火能量')];
    // currentPlayer 1 is starting their turn, so player 0's turn just ended.
    const G = makeState({
      turn: 4, currentPlayer: 1,
      players: [makePlayer({ active: mine }), makePlayer({ active: theirs })],
    });
    processBetweenTurns(G);
    expect(mine.attachedEnergy).toHaveLength(0);
    expect(G.players[0].discardPile.map(c => norm(c.cardData.name))).toContain('燃火能量');
    // The opponent's copy survives — it goes at the end of THEIR turn, not this one.
    expect(theirs.attachedEnergy).toHaveLength(1);
  });
});

describe('感應【超】能量 attach-time deck search', () => {
  const ctx0 = { currentPlayer: '0', turn: 3, events: { endTurn: () => {} } } as any;
  const psychicMon = (n: number) => makeGameCard(makeCard({
    name: `超基礎${n}`, hp: '60', types: ['Psychic'] as any, subtypes: ['Basic'] as Subtype[],
  }), 0);
  const setup = (holderTypes: string[], deckExtras = [psychicMon(1), psychicMon(2), psychicMon(3)]) => {
    const energy = makeGameCard(special('感應【超】能量'), 0);
    const active = makeGameCard(makeCard({ name: '持有者', hp: '100', types: holderTypes as any, subtypes: ['Basic'] as Subtype[] }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({ active, hand: [energy], deck: [...deckExtras, makeGameCard(BASIC_MON, 0)] }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    moves.attachEnergy({ G, ctx: ctx0 }, energy.id, active.id);
    return { G, active };
  };

  it('raises the deck search when attached from hand onto a 【超】 Pokémon', () => {
    const { G, active } = setup(['Psychic']);
    expect(active.attachedEnergy).toHaveLength(1);
    expect(G.pendingChoice?.effectKey).toBe('sensor_energy_bench');
    // Only the 【超】 Basics are offered, capped at the printed 2.
    expect(G.pendingChoice?.options).toHaveLength(3);
    expect(G.pendingChoice?.maxCount).toBe(2);
    expect(G.pendingChoice?.minCount).toBe(0);
  });

  it('benches the picks and shrinks the deck on resolve', () => {
    const { G } = setup(['Psychic']);
    const picks = G.pendingChoice!.options!.slice(0, 2).map(o => o.id);
    moves.resolveChoice({ G, ctx: ctx0 }, picks);
    expect(G.pendingChoice).toBeNull();
    const benched = G.players[0].bench.filter(c => c !== null);
    expect(benched.map(c => c!.id).sort()).toEqual([...picks].sort());
    expect(G.players[0].deck).toHaveLength(2);
  });

  it('does nothing beyond the attach on a non-【超】 Pokémon', () => {
    const { G, active } = setup(['Fire']);
    expect(active.attachedEnergy).toHaveLength(1);
    expect(G.pendingChoice).toBeNull();
    expect(G.players[0].deck).toHaveLength(4);
  });

  it('skips the choice entirely when the Bench is full', () => {
    const energy = makeGameCard(special('感應【超】能量'), 0);
    const active = makeGameCard(makeCard({ name: '持有者', hp: '100', types: ['Psychic'] as any, subtypes: ['Basic'] as Subtype[] }), 0);
    const G = makeState({
      turn: 3, currentPlayer: 0, phase: 'main',
      players: [
        makePlayer({
          active, hand: [energy], deck: [psychicMon(1)],
          bench: Array.from({ length: 5 }, (_, i) => makeGameCard(makeCard({ name: `備戰${i}`, hp: '60', subtypes: ['Basic'] as Subtype[] }), 0)),
        }),
        makePlayer({ active: makeGameCard(BASIC_MON, 1) }),
      ],
    });
    moves.attachEnergy({ G, ctx: ctx0 }, energy.id, active.id);
    expect(active.attachedEnergy).toHaveLength(1);
    expect(G.pendingChoice).toBeNull();
  });

  it('refuses ineligible ids smuggled into the resolution', () => {
    const { G } = setup(['Psychic']);
    // The colorless BASIC_MON in the deck is not among options — submitting it must not bench it.
    const smuggled = G.players[0].deck.find(c => !(c.cardData.types ?? []).includes('Psychic'))!;
    moves.resolveChoice({ G, ctx: ctx0 }, [smuggled.id]);
    expect(G.pendingChoice).toBeNull();
    expect(G.players[0].bench.every(c => c === null)).toBe(true);
    expect(G.players[0].deck).toHaveLength(4);
  });
});
