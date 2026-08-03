// probe-trainer2.js - find fully-enriched trainer cards with rules
const cards = require('../data/cards-final.json').data;
const withRules = cards.filter(c => c.supertype === 'Trainer' && (c.rules || (c.attacks && c.attacks.length && (c.attacks[0].text || c.attacks[0].name))));
console.log('trainers with rules/attacks:', withRules.length);
for (const c of withRules.slice(0, 5)) {
  console.log(JSON.stringify({ id: c.id, name: c.name, supertype: c.supertype, subtypes: c.subtypes, rules: c.rules, abilities: c.abilities, attacks: c.attacks }, null, 1));
  console.log('---');
}
// also check M-era trainer example
const mTrainer = cards.find(c => c.id.startsWith('M') && c.supertype === 'Trainer');
console.log('M-era trainer sample:', JSON.stringify(mTrainer, null, 1));
