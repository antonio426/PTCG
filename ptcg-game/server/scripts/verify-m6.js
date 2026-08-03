// verify-m6.js
const cards = require('../data/cards-final.json').data;
const m6 = cards.filter(c => c.id.startsWith('M6-'));
console.log('M6 count:', m6.length);
for (const id of ['M6-001', 'M6-058', 'M6-063', 'M6-071', 'M6-076']) {
  const c = cards.find(x => x.id === id);
  console.log(JSON.stringify({ id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes, hp: c.hp, types: c.types, rules: c.rules, attacks: c.attacks && c.attacks.slice(0,1), abilities: c.abilities, weaknesses: c.weaknesses, resistances: c.resistances, retreatCost: c.retreatCost, number: c.number, legalities: c.legalities, images: c.images, set: c.set.id, regulationMark: c.regulationMark }, null, 1));
  console.log('---');
}
