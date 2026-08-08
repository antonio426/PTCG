/**
 * Drives the REAL moves.attack against synthetic board state to confirm the generic attack-text
 * resolver (genericAttacks.ts) actually produces correct damage/status/heal/draw outcomes when
 * invoked through the real attack move, not just that its regexes match in isolation.
 */
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { moves } from '../game/moves';
import { canAttack, canRetreat } from '../game/validation';

let passed = 0, failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { console.log(`ok: ${label}`); passed++; }
  else { console.log(`FAIL: ${label}`); failed++; }
}

function mon(id: string, name: string, hp: string, attackText: string, damage: string, opts: Partial<Card> = {}): Card {
  return {
    id, name, supertype: 'Pokémon', subtypes: ['Basic'], hp, types: ['Colorless'],
    attacks: [{ name: 'Move', cost: [], convertedEnergyCost: 0, damage, text: attackText }],
    weaknesses: [], resistances: [], retreatCost: [], convertedRetreatCost: 0,
    set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
    number: id, legalities: {}, images: { small: '', large: '' },
    ...opts,
  };
}
function filler(): Card {
  return mon('filler', '填充獸', '50', '', '10');
}

function freshBattle(attackerData: Card, defenderData: Card) {
  const cardData: Record<string, Card> = { filler: filler(), atk: attackerData, def: defenderData };
  const deckA = [...Array(30).fill('filler')];
  const deckB = [...Array(30).fill('filler')];
  const G = setup({ decks: [deckA, deckB], cardData, seed: 1 });
  G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
  G.players[0].bench = [null, null, null, null, null];
  G.players[1].bench = [null, null, null, null, null];
  G.players[0].active = { id: 'atk1', cardData: attackerData, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null };
  G.players[1].active = { id: 'def1', cardData: defenderData, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null };
  return G;
}

// 1. Unconditional status infliction: "將對手的戰鬥寶可夢【麻痺】。"
{
  const attacker = mon('atk', 'TestMon', '100', '將對手的戰鬥寶可夢【麻痺】。', '30');
  const defender = mon('def', 'DefMon', '100', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('status_unconditional: damage applied (30)', G.players[1].active!.damage === 30);
  check('status_unconditional: Paralyzed applied', G.players[1].active!.statusConditions.includes('Paralyzed'));
}

// 2. Coin-flip scaled damage: "擲4次硬幣，造成正面出現的次數×10點傷害。" with damage field "10x" -> base 0
{
  const attacker = mon('atk', 'CoinMon', '100', '擲4次硬幣，造成正面出現的次數×10點傷害。', '10x');
  const defender = mon('def', 'DefMon2', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const dmg = G.players[1].active!.damage;
  check('coinN_scaled: damage is a multiple of 10 between 0 and 40', dmg % 10 === 0 && dmg >= 0 && dmg <= 40);
}

// 3. Self-heal: "將這隻寶可夢恢復「30」HP。" on a damaged attacker with flat damage field
{
  const attacker = mon('atk', 'HealMon', '100', '將這隻寶可夢恢復「30」HP。', '20');
  const defender = mon('def', 'DefMon3', '100', '', '10');
  const G = freshBattle(attacker, defender);
  G.players[0].active!.damage = 50;
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('selfHeal: attacker healed from 50 to 20 damage remaining', G.players[0].active!.damage === 20);
  check('selfHeal: defender still took the flat 20 damage', G.players[1].active!.damage === 20);
}

// 4. Draw cards: "從自己的牌庫抽出2張卡。"
{
  const attacker = mon('atk', 'DrawMon', '100', '從自己的牌庫抽出2張卡。', '10');
  const defender = mon('def', 'DefMon4', '100', '', '10');
  const G = freshBattle(attacker, defender);
  const handBefore = G.players[0].hand.length;
  const deckBefore = G.players[0].deck.length;
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('drawCards: hand grew by 2', G.players[0].hand.length === handBefore + 2);
  check('drawCards: deck shrank by 2', G.players[0].deck.length === deckBefore - 2);
}

// 5. Miss-on-tails doesn't crash and produces 0 or the flat damage
{
  const attacker = mon('atk', 'MissMon', '100', '擲1次硬幣若為反面，則這個招式失敗。', '50');
  const defender = mon('def', 'DefMon5', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const dmg = G.players[1].active!.damage;
  check('coin1_missOnTails: damage is either 0 or 50', dmg === 0 || dmg === 50);
}

// 6. Recoil: "這隻寶可夢也受到10點傷害。"
{
  const attacker = mon('atk', 'RecoilMon', '100', '這隻寶可夢也受到10點傷害。', '40');
  const defender = mon('def', 'DefMon6', '100', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('selfDamage: attacker took 10 recoil', G.players[0].active!.damage === 10);
  check('selfDamage: defender took the flat 40', G.players[1].active!.damage === 40);
}

// 7. Self energy discard: "選擇1個這隻寶可夢身上附加的能量，將其丟棄。"
{
  const attacker = mon('atk', 'DiscardMon', '100', '選擇1個這隻寶可夢身上附加的能量，將其丟棄。', '20');
  const defender = mon('def', 'DefMon7', '100', '', '10');
  const G = freshBattle(attacker, defender);
  G.players[0].active!.attachedEnergy = [{ id: 'e1', type: 'Colorless' }, { id: 'e2', type: 'Colorless' }];
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('discardSelfEnergyCount: exactly 1 energy removed', G.players[0].active!.attachedEnergy.length === 1);
}

// 8. Opponent Tool discard: "在造成傷害前，將對手的戰鬥寶可夢身上附加的「寶可夢道具」卡丟棄。"
{
  const attacker = mon('atk', 'ToolStripMon', '100', '在造成傷害前，將對手的戰鬥寶可夢身上附加的「寶可夢道具」卡丟棄。', '20');
  const defender = mon('def', 'DefMon8', '100', '', '10');
  const G = freshBattle(attacker, defender);
  const toolCard = mon('tool', '測試道具', '', '', '');
  G.players[1].active!.attachedTool = { id: 'tool1', cardData: toolCard, owner: 1, damage: 0, statusConditions: [], attachedEnergy: [] };
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('discardOpponentTool: tool removed from defender', G.players[1].active!.attachedTool === null);
  check('discardOpponentTool: tool landed in owner discard pile', G.players[1].discardPile.some(c => c.id === 'tool1'));
}

// 9. Board-scaled damage: "造成自己的場上寶可夢的數量×20點傷害。"
{
  const attacker = mon('atk', 'FieldCountMon', '100', '造成自己的場上寶可夢的數量×20點傷害。', '');
  const defender = mon('def', 'DefMon9', '200', '', '10');
  const G = freshBattle(attacker, defender);
  G.players[0].bench[0] = { id: 'b1', cardData: filler(), owner: 0, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null };
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  check('fieldCount-scaled: 2 own Pokémon (active+1 bench) -> 40 damage', G.players[1].active!.damage === 40);
}

// 10. Self-lockout timed effect: "在下個自己的回合，這隻寶可夢無法使用招式。"
{
  const attacker = mon('atk', 'LockoutMon', '100', '在下個自己的回合，這隻寶可夢無法使用招式。', '30');
  const defender = mon('def', 'DefMon10', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const atk = G.players[0].active!;
  check('selfTimedEffect: cantAttack recorded for turn+2', !!atk.timedEffects?.some(e => e.kind === 'cantAttack' && e.appliesOnTurn === G.turn + 2));
}

// 11. Defender lockout: "在下個對手的回合，受到這個招式的寶可夢無法撤退。"
{
  const attacker = mon('atk', 'PinDownMon', '100', '在下個對手的回合，受到這個招式的寶可夢無法撤退。', '30');
  const defender = mon('def', 'DefMon11', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const def = G.players[1].active!;
  check('opponentTimedEffect: cantRetreat recorded for turn+1', !!def.timedEffects?.some(e => e.kind === 'cantRetreat' && e.appliesOnTurn === G.turn + 1));
}

// 12. Timed effects actually block the real validation checks once the target turn arrives
{
  const attacker = mon('atk', 'LockoutMon2', '100', '在下個自己的回合，這隻寶可夢無法使用招式。', '30');
  const defender = mon('def', 'DefMon12', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const lockTurn = G.players[0].active!.timedEffects![0].appliesOnTurn;
  G.phase = 'main';
  check('canAttack: not blocked on the turn it was set', canAttack(G, 0, 0));
  G.turn = lockTurn;
  G.players[0].active!.attachedEnergy = []; // avoid unrelated cost-payment false negatives
  check('canAttack: blocked exactly on the recorded turn', !canAttack(G, 0, 0));
  G.turn = lockTurn + 1;
  check('canAttack: no longer blocked the turn after', canAttack(G, 0, 0));
}
{
  const attacker = mon('atk', 'PinDownMon2', '100', '在下個對手的回合，受到這個招式的寶可夢無法撤退。', '30');
  const defender = mon('def', 'DefMon13', '200', '', '10');
  const G = freshBattle(attacker, defender);
  (moves.attack as any)({ G, ctx: { events: {} } }, 0);
  const def = G.players[1].active!;
  const lockTurn = def.timedEffects![0].appliesOnTurn;
  G.players[1].bench[0] = { id: 'b2', cardData: filler(), owner: 1, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null };
  G.currentPlayer = 1;
  G.phase = 'main';
  G.turn = lockTurn;
  check('canRetreat: blocked exactly on the recorded turn', !canRetreat(G, 1));
  G.turn = lockTurn + 1;
  check('canRetreat: no longer blocked the turn after', canRetreat(G, 1));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
