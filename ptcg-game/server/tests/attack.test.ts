import { describe, it, expect, vi, afterEach } from 'vitest';
import { moves } from '../src/game/moves';
import { PtcgGameState } from '../src/game/GameState';
import { BASIC_ENERGY, BASIC_MON, attack as mkAttack, makeCard, makeGameCard, makePlayer, makeState } from './fixtures';

/**
 * The attack move is by far the largest in moves.ts. These specs pin its observable contract for
 * a plain, text-free attack — damage lands, weakness/resistance apply, a lethal hit KOs and pays
 * prizes, and the turn ends — rather than the hundreds of generic-attack template branches,
 * which attack-clause-audit.ts covers from the text side.
 */

const ATTACKER = makeCard({
  name: '攻擊鼠',
  hp: '100',
  types: ['Fire'],
  subtypes: ['Basic'],
  attacks: [mkAttack('火花', ['Colorless'], '50')],
});

const PLAIN_DEFENDER = makeCard({ name: '木頭鼠', hp: '200', types: ['Colorless'], subtypes: ['Basic'] });

const WEAK_DEFENDER = makeCard({
  name: '易燃鼠', hp: '200', types: ['Grass'], subtypes: ['Basic'],
  weaknesses: [{ type: 'Fire' as any, value: '×2' }],
});

const RESISTANT_DEFENDER = makeCard({
  name: '耐火鼠', hp: '200', types: ['Water'], subtypes: ['Basic'],
  resistances: [{ type: 'Fire' as any, value: '-30' }],
});

/** HP 50 so the 50-damage attack above is exactly lethal in one hit. */
const EX_DEFENDER = makeCard({ name: '大牌鼠ex', hp: '50', types: ['Colorless'], subtypes: ['Basic', 'ex'] });

function board(defenderCard = PLAIN_DEFENDER, opts: { defenderDamage?: number; benchedDefender?: boolean } = {}) {
  const attacker = makeGameCard(ATTACKER, 0, {
    attachedEnergy: [{ id: 'e1', type: 'Fire', cardData: BASIC_ENERGY }],
  });
  const defender = makeGameCard(defenderCard, 1, { damage: opts.defenderDamage ?? 0 });
  const G = makeState({
    turn: 3,
    currentPlayer: 0,
    phase: 'main',
    players: [
      makePlayer({ active: attacker, prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 0)) }),
      makePlayer({
        active: defender,
        bench: [(opts.benchedDefender ?? true) ? makeGameCard(PLAIN_DEFENDER, 1) : null, null, null, null, null],
        prizes: Array.from({ length: 6 }, () => makeGameCard(BASIC_MON, 1)),
      }),
    ],
  });
  return { G, attacker, defender };
}

function doAttack(G: PtcgGameState, index = 0) {
  const endTurn = vi.fn();
  moves.attack({ G, ctx: { currentPlayer: String(G.currentPlayer), turn: G.turn, events: { endTurn } } } as any, index);
  return endTurn;
}

afterEach(() => vi.restoreAllMocks());

describe('a plain attack', () => {
  it('deals its printed damage', () => {
    const { G, defender } = board();
    doAttack(G);
    expect(defender.damage).toBe(50);
  });

  it('ends the turn', () => {
    const { G } = board();
    const endTurn = doAttack(G);
    expect(G.phase).toBe('end');
    expect(endTurn).toHaveBeenCalled();
  });

  it('doubles against a matching weakness', () => {
    const { G, defender } = board(WEAK_DEFENDER);
    doAttack(G);
    expect(defender.damage).toBe(100);
  });

  it('is reduced by a matching resistance', () => {
    const { G, defender } = board(RESISTANT_DEFENDER);
    doAttack(G);
    expect(defender.damage).toBe(20);
  });

  it('does nothing without enough energy attached', () => {
    const { G, attacker, defender } = board();
    attacker.attachedEnergy = [];
    doAttack(G);
    expect(defender.damage).toBe(0);
  });

  it('does nothing on the first turn of the game', () => {
    const { G, defender } = board();
    G.turn = 1;
    doAttack(G);
    expect(defender.damage).toBe(0);
  });

  it('does nothing for an attack index that does not exist', () => {
    const { G, defender } = board();
    doAttack(G, 7);
    expect(defender.damage).toBe(0);
  });
});

describe('a lethal attack', () => {
  it('KOs the defender and sends it to the discard pile', () => {
    const { G, defender } = board(PLAIN_DEFENDER, { defenderDamage: 150 });
    doAttack(G);
    expect(G.players[1].discardPile.map(c => c.id)).toContain(defender.id);
    expect(G.players[1].active?.id).not.toBe(defender.id);
  });

  it('pays the attacker one prize for an ordinary Pokémon', () => {
    const { G } = board(PLAIN_DEFENDER, { defenderDamage: 150 });
    doAttack(G);
    expect(G.players[0].takenPrizes).toBe(1);
    expect(G.players[0].prizes).toHaveLength(5);
  });

  it('pays two prizes for an ex', () => {
    const { G } = board(EX_DEFENDER);
    doAttack(G);
    expect(G.players[0].takenPrizes).toBe(2);
  });

  it('does not KO at exactly one hit point short', () => {
    const { G, defender } = board(PLAIN_DEFENDER, { defenderDamage: 140 });
    doAttack(G);
    expect(defender.damage).toBe(190);
    expect(G.players[0].takenPrizes).toBe(0);
  });

  it('promotes the only Benched Pokémon into the empty Active spot', () => {
    // promoteActiveIfNeeded runs at the next turn-begin; until then the spot is legitimately
    // empty, which is what the win check reads as "opponent has no pokemon".
    const { G } = board(PLAIN_DEFENDER, { defenderDamage: 150, benchedDefender: false });
    doAttack(G);
    expect(G.players[1].active).toBeNull();
    expect(G.players[1].bench.filter(Boolean)).toHaveLength(0);
  });
});

describe('Confusion', () => {
  it('hits its own user for 30 and ends the turn on tails', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1); // < 0.5 -> the attack fails
    const { G, attacker, defender } = board();
    attacker.statusConditions = ['Confused'] as any;
    const endTurn = doAttack(G);
    expect(attacker.damage).toBe(30);
    expect(defender.damage).toBe(0);
    expect(endTurn).toHaveBeenCalled();
  });

  it('connects normally on heads', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const { G, attacker, defender } = board();
    attacker.statusConditions = ['Confused'] as any;
    doAttack(G);
    expect(attacker.damage).toBe(0);
    expect(defender.damage).toBe(50);
  });
});

/**
 * The battle log is player-facing prose in Traditional Chinese, so nothing may parse it for
 * data. The damage floater in Battle.tsx used to regex the English sentence "... for N damage
 * to ...", which would have silently stopped rendering the moment the log was translated —
 * leaving an attack that visibly does nothing, which is exactly what gets reported as "the
 * attack dealt no damage".
 */
describe('the attack log carries structured damage, not just prose', () => {
  it('records finalDamage on the log entry', () => {
    const { G } = board();
    doAttack(G);
    const entry = G.turnLog.filter(e => e.action === 'attack').pop();
    expect(entry).toBeDefined();
    expect(entry!.damageDetail?.finalDamage).toBe(50);
  });

  it('reports the post-weakness number, not the printed one', () => {
    const { G } = board(WEAK_DEFENDER);
    doAttack(G);
    const entry = G.turnLog.filter(e => e.action === 'attack').pop();
    expect(entry!.damageDetail?.finalDamage).toBe(100);
    expect(entry!.damageDetail?.weaknessApplied).toBe(true);
  });

  it('writes the log in Traditional Chinese', () => {
    const { G } = board();
    doAttack(G);
    const entry = G.turnLog.filter(e => e.action === 'attack').pop();
    expect(entry!.details).toMatch(/[一-鿿]/);
    expect(entry!.details).not.toMatch(/\bdamage to\b/);
  });

  it('explains a Confusion failure in the log rather than going silent', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { G, attacker } = board();
    attacker.statusConditions = ['Confused'] as any;
    doAttack(G);
    const entry = G.turnLog.filter(e => e.action === 'attack').pop();
    expect(entry!.details).toContain('混亂');
    expect(entry!.details).toMatch(/[一-鿿]/);
  });
});
