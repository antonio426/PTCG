import * as fs from 'fs';

const cards: any[] = JSON.parse(
  fs.readFileSync(__dirname + '/../../data/cards.json', 'utf-8')
).data;

// Check for duplicate IDs
const idMap = new Map<string, number>();
const dupes: string[] = [];
for (const c of cards) {
  if (idMap.has(c.id)) {
    dupes.push(c.id + ' appears ' + (idMap.get(c.id)! + 1) + ' times');
  }
  idMap.set(c.id, (idMap.get(c.id) || 0) + 1);
}
console.log('=== Duplicate IDs:', dupes.length, '===');
dupes.forEach(d => console.log('  ' + d));

// Check: Trainer cards with energy types set (should be none)
console.log('\n=== Trainer cards with energy types set ===');
const trainerWithTypes = cards.filter((c: any) => 
  c.supertype === 'Trainer' && c.types && c.types.length > 0
);
trainerWithTypes.slice(0, 20).forEach((c: any) => {
  console.log('  ' + c.id + ' "' + c.name + '" types: [' + (c.types || []).join(',') + '] subtypes: [' + (c.subtypes || []).join(',') + ']');
});
if (trainerWithTypes.length > 20) {
  console.log('  ... and ' + (trainerWithTypes.length - 20) + ' more');
}

// Check: cards where supertype is wrong - look for Trainer cards that should be Pokémon
console.log('\n=== Trainer scr-* cards (sample 30) ===');
const trainerScr = cards.filter((c: any) => c.supertype === 'Trainer' && c.id.startsWith('scr'));
trainerScr.slice(0, 30).forEach((c: any) => {
  console.log('  ' + c.id + ' "' + c.name + '" subtypes: [' + (c.subtypes || []).join(',') + '] set: ' + c.set?.id);
});
if (trainerScr.length > 30) {
  console.log('  ... and ' + (trainerScr.length - 30) + ' more (total: ' + trainerScr.length + ')');
}

// Check all scr-* cards sample with their h3 classification issues
console.log('\n=== scr-* cards with unexpected h3 (sample) ===');
// Look for scr-* cards that fell into "else" branch (Pokémon default) 
// but have no attacks or hp - meaning they might not be real Pokémon
const suspiciousPokemon = cards.filter((c: any) => 
  c.id.startsWith('scr') && 
  c.supertype === 'Pokémon' && 
  (!c.attacks || c.attacks.length === 0) &&
  (!c.hp)
);
console.log('scr-* default-Pokémon with no attacks/HP: ' + suspiciousPokemon.length);
suspiciousPokemon.slice(0, 15).forEach((c: any) => {
  console.log('  ' + c.id + ' "' + c.name + '"');
});
