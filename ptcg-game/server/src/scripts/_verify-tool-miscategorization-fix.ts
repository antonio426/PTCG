/**
 * Verifies the 龐克頭盔/猛攻手鐲/電氣球 Item→Pokémon Tool data fix using the REAL cards.json
 * data (not synthetic test cards) through the real moves.playTrainer path, confirming they now
 * route to the generic tool_attach flow instead of silently no-op'ing as before.
 * Run with: npx tsx src/scripts/_verify-tool-miscategorization-fix.ts
 */
import fs from 'fs';
import path from 'path';
import type { Card } from '@ptcg/shared';
import { setup } from '../game/setup';
import { moves } from '../game/moves';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); failures++; }
  else console.log('ok:', msg);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/cards.json'), 'utf-8'));
const allCards: Card[] = raw.data || raw;
const cardById = new Map(allCards.map(c => [c.id, c]));

const targets = ['MBG-018', 'MC-689', 'M2a-163'];
for (const id of targets) {
  const card = cardById.get(id);
  assert(!!card, `${id}: found in cards.json`);
  assert(!!card && card.subtypes.includes('Pokémon Tool'), `${id} (${card?.name}): subtypes now include Pokémon Tool`);
}

// Full end-to-end: play 電氣球 via the real moves.playTrainer and confirm it opens tool_attach.
const filler: Card = {
  id: 'filler', name: '填充獸', supertype: 'Pokémon', subtypes: ['Basic'], hp: '60', types: ['Colorless'],
  attacks: [{ name: 'Tackle', cost: [], convertedEnergyCost: 0, damage: '10', text: '' }],
  set: { id: 'TEST', name: 'Test', series: 'T', printedTotal: 1, total: 1, releaseDate: '' },
  number: 'f', legalities: {}, images: { small: '', large: '' },
};
const electroBalloon = cardById.get('M2a-163')!;
const cardData: Record<string, Card> = { filler, electroBalloon };
const deckA = [...Array(30).fill('filler')];
const deckB = [...Array(30).fill('filler')];
const G = setup({ decks: [deckA, deckB], cardData, seed: 1 });
G.turn = 3; G.currentPlayer = 0; G.phase = 'main';
const p0 = G.players[0];
p0.active = { id: 'pikachu', cardData: filler, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] };
p0.hand.push({ id: 'balloon1', cardData: electroBalloon, owner: 0, damage: 0, statusConditions: [], attachedEnergy: [] });

(moves.playTrainer as any)({ G, ctx: { currentPlayer: '0' } }, 'balloon1');
assert(G.pendingChoice?.effectKey === 'tool_attach', `電氣球 play_trainer opens the generic tool_attach flow (got ${G.pendingChoice?.effectKey ?? 'null'})`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
