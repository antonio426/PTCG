// probe-trainer.js - inspect how existing Trainer cards store rules text
const cards = require('../data/cards-final.json').data;
const trainers = cards.filter(c => c.supertype === 'Trainer');
console.log('trainer count:', trainers.length);
const t = trainers[0];
console.log(JSON.stringify({ id: t.id, name: t.name, supertype: t.supertype, subtypes: t.subtypes, rules: t.rules, attacks: t.attacks, abilities: t.abilities }, null, 1));
// show 2 more
for (const c of trainers.slice(1, 4)) {
  console.log('---');
  console.log(JSON.stringify({ id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes, rules: c.rules, attacks: c.attacks, abilities: c.abilities }, null, 1));
}
