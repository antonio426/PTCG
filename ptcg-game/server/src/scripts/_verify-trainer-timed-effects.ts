/**
 * Verifies the two trainer effects added by retrofitting the per-card timedEffects system
 * (built for generic attack text this session) onto Supporter cards: 阿塞蘿拉的惡作劇 and
 * 霍米加的演奏. Both were previously left uncovered for lack of a "protects/restricts a specific
 * card during the opponent's next turn" mechanism — this confirms that mechanism, now shared
 * with attacks, resolves correctly for trainers too.
 */
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { canRetreat } from '../game/validation';
import { isDamageBlocked } from '../game/effects/passiveAbilities';

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
function trainerCard(id: string, name: string): Card {
  return {
    id, name, supertype: 'Trainer', subtypes: ['Supporter'], hp: '',
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
  } as any;
}

let pass = 0, fail = 0;
function check(label: string, cond: boolean) { if (cond) { console.log('ok:', label); pass++; } else { console.log('FAIL:', label); fail++; } }

// Test 1: 阿塞蘿拉的惡作劇
{
  const filler = mon('filler', 'Filler', '50');
  const cardData: Record<string, Card> = { filler, arlo: trainerCard('arlo', '阿塞蘿拉的惡作劇') };
  const G = setup({ decks: [Array(30).fill('filler'), Array(30).fill('filler')], cardData, seed: 1 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  G.players[0].bench = [null, null, null, null, null];
  G.players[0].active = { id: 'p0active', cardData: filler, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null };
  G.players[1].prizes = [1, 2] as any; // 2 remaining prizes -> gate satisfied
  G.players[0].hand.push({ id: 'arlo1', cardData: cardData.arlo, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });
  (moves.playTrainer as any)({ G, ctx: { currentPlayer: '0' } }, 'arlo1');
  (moves.resolveChoice as any)({ G, ctx: { currentPlayer: '0' } }, ['p0active']);
  const target = G.players[0].active!;
  check('arlosCharm: timedEffect recorded (damageImmune vs ex, turn+1)', !!target.timedEffects?.some(e => e.kind === 'damageImmune' && e.vsSubtype === 'ex' && e.appliesOnTurn === G.turn + 1));
  G.turn += 1;
  const exAttacker = { id: 'atk', cardData: mon('atk', 'ExMon', '100', { subtypes: ['Basic', 'ex'] }), owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] } as any;
  check('arlosCharm: blocks damage from an ex attacker on the recorded turn', isDamageBlocked(G, exAttacker, target));
  const nonExAttacker = { id: 'atk2', cardData: mon('atk2', 'PlainMon', '100'), owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] } as any;
  check('arlosCharm: does NOT block a non-ex attacker', !isDamageBlocked(G, nonExAttacker, target));
}

// Test 2: 霍米加的演奏
{
  const filler = mon('filler', 'Filler', '50');
  const cardData: Record<string, Card> = { filler, homika: trainerCard('homika', '霍米加的演奏') };
  const G = setup({ decks: [Array(30).fill('filler'), Array(30).fill('filler')], cardData, seed: 1 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  G.players[1].bench = [{ id: 'b1', cardData: filler, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null }, null, null, null, null];
  G.players[1].active = { id: 'p1active', cardData: filler, owner: 1, damage: 0, statusConditions: ['Poisoned'], attachedEnergy: [{ id: 'e1', type: 'Colorless' }], attachedTool: null };
  G.players[0].hand.push({ id: 'homika1', cardData: cardData.homika, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });
  G.currentPlayer = 1;
  check('canRetreat: opponent CAN retreat before the card is played', canRetreat(G, 1));
  G.currentPlayer = 0;
  (moves.playTrainer as any)({ G, ctx: { currentPlayer: '0' } }, 'homika1');
  check('homikasPerformance: flag recorded for turn+1', G.players[1].poisonedCantRetreatUntilTurn === G.turn + 1);
  G.turn += 1;
  G.currentPlayer = 1;
  check("canRetreat: opponent's Poisoned Active is now blocked from retreating", !canRetreat(G, 1));
  G.players[1].active!.statusConditions = [];
  check('canRetreat: a non-Poisoned Active is unaffected', canRetreat(G, 1));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
