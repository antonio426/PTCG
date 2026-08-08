/**
 * Targeted verification for the passive-ability framework and new trainer/ability effects
 * added for the "修正所有寶可夢的特性" goal: once-per-turn enforcement, 放逐區障礙 (exile
 * zone), 虹色DNA (special evolution), 天空徑線 (retreat waiver), 妖精領域 (weakness
 * override), 老練招式 (attack cost reduction), 祭典樂舞 (double attack), 龐克頭盔
 * (retaliation Tool). Run with: npx tsx src/scripts/_verify-new-mechanics.ts
 */
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { getLegalMoves, canEvolve, effectiveRetreatCost, canAttack } from '../game/validation';
import { calculateDamage, handleKo } from '../game/damage';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok:', msg);
}

function mon(id: string, name: string, hp: string, opts: Partial<Card> = {}): Card {
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp, types: ['Colorless'],
    attacks: [{ name: 'Tackle', cost: [], convertedEnergyCost: 0, damage: '10', text: '' }],
    weaknesses: [], resistances: [], retreatCost: [], convertedRetreatCost: 0,
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
    ...opts,
  };
}
function filler(): Card { return mon('filler', '填充獸', '50'); }

const cardData: Record<string, Card> = { filler: filler() };
function reg(c: Card) { cardData[c.id] = c; return c; }

/* ================= Test 1: once-per-turn ability enforcement ================= */
{
  const grassEnergy = reg({
    id: 'ge', name: '基本【草】能量', supertype: 'Energy', subtypes: ['Basic Energy'], types: ['Grass'],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: 'ge', legalities: {}, images: { small: '', large: '' },
  });
  const abilityMon = reg(mon('abilitymon', '特性測試獸', '100', {
    abilities: [{ name: '碧綠之舞', text: 'attach grass energy', type: 'Ability' }],
  }));
  // Deck stays 'filler'-only so setup()'s placeBasics() can't auto-place a second, untracked
  // copy of abilityMon onto the bench before we manually assign it to Active below.
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 1 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  const p0 = G.players[0];
  p0.bench = [null, null, null, null, null];
  p0.active = { id: 'active0', cardData: abilityMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  p0.hand.push({ id: 'ge1', cardData: grassEnergy, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });
  p0.hand.push({ id: 'ge2', cardData: grassEnergy, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });

  const before = getLegalMoves(G, 0).filter(m => m.type === 'use_ability');
  assert(before.length === 1, 'once-per-turn: use_ability offered before first use');

  (moves.useAbility as any)({ G, ctx: {} }, 'active0');
  (moves.resolveChoice as any)({ G, ctx: {} }, ['ge1']);
  (moves.resolveChoice as any)({ G, ctx: {} }, ['active0']);
  assert(p0.active!.attachedEnergy.length === 1, 'once-per-turn: ability resolved and attached energy');

  const after = getLegalMoves(G, 0).filter(m => m.type === 'use_ability');
  assert(after.length === 0, 'once-per-turn: use_ability no longer offered after using it once this turn');
}

/* ================= Test 2: 放逐區障礙 exile zone ================= */
{
  const exileMon = reg(mon('exilemon', '龜足巨鎧', '120', {
    abilities: [{ name: '放逐區障礙', text: '對手獲得的獎賞卡不加入手牌，而是放置於放逐區。', type: 'Ability' }],
  }));
  const targetMon = reg(mon('exiletarget', '被擊倒獸', '10'));
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 2 });
  const p0 = G.players[0];
  const p1 = G.players[1];
  p0.active = { id: 'atk', cardData: filler(), owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  p1.active = { id: 'def', cardData: targetMon, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };
  p1.bench[0] = { id: 'exileholder', cardData: exileMon, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };
  p0.prizes = [{ id: 'prize1', cardData: filler(), owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] }];
  const handBefore = p0.hand.length;

  p1.active.damage = 999; // ensure lethal regardless of calc
  handleKo(G, 1, 'def');

  assert(p0.hand.length === handBefore, "exile zone: attacker's hand did NOT grow (prize redirected)");
  assert(p0.exileZone.length === 1, 'exile zone: prize card landed in exileZone instead');
}

/* ================= Test 3: 虹色DNA special evolution ================= */
{
  const dnaHolder = reg(mon('dnaholder', '伊布ex', '180', {
    subtypes: ['Basic', 'ex'],
    abilities: [{ name: '虹色DNA', text: '可從手牌使出從「伊布」進化而來的寶可夢【ex】完成進化', type: 'Ability' }],
  }));
  const eeveeEvo = reg(mon('eeveeevo', '水伊布ex', '250', { subtypes: ['Basic', 'ex'], evolvesFrom: '伊布' }));
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 3 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  const p0 = G.players[0];
  p0.active = { id: 'dnaactive', cardData: dnaHolder, owner: 0, damage: 40, statusConditions: [], attachedEnergy: [{ id: 'e1', type: 'Colorless' }] };
  p0.hand.push({ id: 'eevee_hand', cardData: eeveeEvo, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });

  assert(canEvolve(G, 0, 'eevee_hand', 'dnaactive'), '虹色DNA: evolving mismatched-name card onto ability holder is legal');
  (moves.evolvePokemon as any)({ G, ctx: {} }, 'eevee_hand', 'dnaactive');
  assert(p0.active?.cardData.id === 'eeveeevo', '虹色DNA: evolution actually swapped the active Pokémon');
  assert(p0.active?.attachedEnergy.length === 1, '虹色DNA: attached energy carried over through the evolution');
}

/* ================= Test 4: 天空徑線 retreat waiver ================= */
{
  const skylineMon = reg(mon('skyline', '拉帝亞斯ex', '210', {
    abilities: [{ name: '天空徑線', text: '自己的所有基礎寶可夢撤退所需能量全部消除', type: 'Ability' }],
  }));
  const costlyBasic = reg(mon('costly', '重撤退基礎獸', '90', { retreatCost: ['Colorless', 'Colorless', 'Colorless'], convertedRetreatCost: 3 }));
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 4 });
  const p0 = G.players[0];
  const costlyCard = { id: 'costlyactive', cardData: costlyBasic, owner: 0 as const, damage: 0, statusConditions: [], attachedEnergy: [] };
  p0.active = costlyCard;
  assert(effectiveRetreatCost(G, costlyCard) === 3, '天空徑線 sanity: without the ability in play, retreat cost is still 3');
  p0.bench[0] = { id: 'skylineholder', cardData: skylineMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  assert(effectiveRetreatCost(G, costlyCard) === 0, '天空徑線: Basic Pokémon retreat cost waived once the ability enters play');
}

/* ================= Test 5: 妖精領域 weakness override ================= */
{
  const fairyMon = reg(mon('fairyzone', '莉莉艾的皮皮ex', '190', {
    abilities: [{ name: '妖精領域', text: '對手場上所有龍寶可夢的弱點全部改為超屬性', type: 'Ability' }],
  }));
  const dragonMon = reg(mon('dragonmon', '測試龍獸', '150', { types: ['Dragon'], weaknesses: [{ type: 'Fairy', value: '×2' }] }));
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 5 });
  const p0 = G.players[0];
  const p1 = G.players[1];
  const psychicAttacker = { id: 'psyattacker', cardData: mon('psyattacker', '超系攻擊者', '100', { types: ['Psychic'] }), owner: 0 as const, damage: 0, statusConditions: [], attachedEnergy: [] };
  p0.active = psychicAttacker;
  const dragonDefender = { id: 'dragondef', cardData: dragonMon, owner: 1 as const, damage: 0, statusConditions: [], attachedEnergy: [] };
  p1.active = dragonDefender;
  const attack = { name: 'Zap', cost: [], convertedEnergyCost: 0, damage: '50', text: '' };

  const dmgBefore = calculateDamage(G, 0, psychicAttacker, attack, dragonDefender);
  assert(dmgBefore === 50, '妖精領域 sanity: without the ability in play, Psychic vs printed-Fairy-weakness Dragon does not double (50)');

  p0.bench[0] = { id: 'fairyholder', cardData: fairyMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  const dmgAfter = calculateDamage(G, 0, psychicAttacker, attack, dragonDefender);
  assert(dmgAfter === 100, "妖精領域: once in play, opponent's Dragon weakness is overridden to Psychic — Psychic attacker now doubles (100)");
}

/* ================= Test 6: 老練招式 attack cost reduction ================= */
{
  const veteranMon = reg(mon('veteranmon', '月月熊 赫月 ex', '260', {
    abilities: [{ name: '老練招式', text: "這隻寶可夢使用「血月」所需的無能量，減少對手已經獲得的獎賞卡的張數數量。", type: 'Ability' }],
    attacks: [{ name: '血月', cost: ['Colorless', 'Colorless', 'Colorless'], convertedEnergyCost: 3, damage: '150', text: '' }],
  }));
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 6 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  const p0 = G.players[0];
  const p1 = G.players[1];
  p0.active = { id: 'veteranactive', cardData: veteranMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [{ id: 'e1', type: 'Colorless' }] };
  p1.active = { id: 'defender6', cardData: filler(), owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };
  assert(!canAttack(G, 0, 0), '老練招式 sanity: with only 1 energy and 0 opponent taken prizes, the 3-cost attack is not payable');
  p1.takenPrizes = 2;
  assert(canAttack(G, 0, 0), "老練招式: opponent having taken 2 prizes reduces 血月's Colorless cost by 2, making 1 energy enough");
}

/* ================= Test 7: 祭典樂舞 double attack ================= */
{
  const festivalMon = reg(mon('festivalmon', '裹蜜蟲', '90', {
    abilities: [{ name: '祭典樂舞', text: '若場上有「祭典會場」，則這隻寶可夢可使用持有的招式2次。', type: 'Ability' }],
  }));
  const stadiumCard = reg({
    id: 'festivalstadium', name: '祭典會場', supertype: 'Trainer', subtypes: ['Stadium'],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: 'fs', legalities: {}, images: { small: '', large: '' },
  });
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 7 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  const p0 = G.players[0];
  const p1 = G.players[1];
  p0.active = { id: 'festivalactive', cardData: festivalMon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
  p1.active = { id: 'defender7', cardData: mon('defender7mon', '受測獸', '250'), owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };
  G.activeStadium = { id: 'stadiumactive', cardData: stadiumCard, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };

  (moves.attack as any)({ G, ctx: {} }, 0);
  const phaseAfterFirstAttack: string = G.phase;
  assert(phaseAfterFirstAttack === 'attack' && G.currentPlayer === 0, '祭典樂舞: after the first attack, turn does NOT end (stays this player\'s attack phase)');
  assert(p0.usedBonusAttackThisTurn === true, '祭典樂舞: bonus-attack flag consumed after first attack');

  let endTurnCalled = false;
  (moves.attack as any)({ G, ctx: { events: { endTurn: () => { endTurnCalled = true; } } } }, 0);
  assert(endTurnCalled, '祭典樂舞: after the SECOND attack this turn, turn ends normally (bonus already used)');
}

/* ================= Test 8: 龐克頭盔 retaliation Tool ================= */
{
  const darkDefender = reg(mon('darkdefmon', '惡屬性防守獸', '150', { types: ['Darkness'] }));
  const punkHelmet = reg({
    id: 'punkhelmet', name: '龐克頭盔', supertype: 'Trainer', subtypes: ['Pokémon Tool'],
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: 'ph', legalities: {}, images: { small: '', large: '' },
  });
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 8 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  const p0 = G.players[0];
  const p1 = G.players[1];
  const attacker8 = { id: 'attacker8', cardData: mon('attacker8mon', '攻擊測試獸', '120'), owner: 0 as const, damage: 0, statusConditions: [], attachedEnergy: [] };
  p0.active = attacker8;
  const defender8 = { id: 'defender8', cardData: darkDefender, owner: 1 as const, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: { id: 'toolinstance', cardData: punkHelmet, owner: 1 as const, damage: 0, statusConditions: [], attachedEnergy: [] } };
  p1.active = defender8;

  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  assert(attacker8.damage === 40, `龐克頭盔: attacker takes 4 counters (40 damage) retaliation for hitting a Darkness Tool-holder (got ${attacker8.damage})`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
