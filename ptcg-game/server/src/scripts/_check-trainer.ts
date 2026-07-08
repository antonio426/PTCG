import * as fs from 'fs';

const cards: any[] = JSON.parse(
  fs.readFileSync(__dirname + '/../../data/cards.json', 'utf-8')
).data;

// 1. Same name, different supertype
const map = new Map<string, Map<string, string[]>>();
for (const c of cards) {
  if (!map.has(c.name)) map.set(c.name, new Map());
  const entry = map.get(c.name)!;
  const key = c.supertype;
  if (!entry.has(key)) entry.set(key, []);
  entry.get(key)!.push(c.id);
}
const conflicts: any[] = [];
for (const [name, stMap] of map) {
  if (stMap.size > 1) {
    conflicts.push({ name, supertypes: [...stMap.keys()], ids: [...stMap.values()].flat() });
  }
}
console.log('=== Same name, different supertype: ' + conflicts.length + ' ===');
conflicts.sort((a, b) => b.ids.length - a.ids.length);
for (const c of conflicts) {
  console.log(`  "${c.name}" → ${c.supertypes.join(', ')} (IDs: ${c.ids.join(', ')})`);
}

// 2. Trainer cards that look like they should be Energy (name contains 能量)
console.log('\n=== Trainer cards with "能量" in name ===');
const trainerWithEnergy = cards.filter(
  (c: any) => c.supertype === 'Trainer' && c.name.includes('能量')
);
trainerWithEnergy.forEach((c: any) =>
  console.log(`  ${c.id} "${c.name}" subtypes: [${(c.subtypes || []).join(', ')}]`)
);

// 3. Energy cards that look like they should be Trainer
console.log('\n=== Energy cards ===');
const energyCards = cards.filter((c: any) => c.supertype === 'Energy');
energyCards.forEach((c: any) =>
  console.log(`  ${c.id} "${c.name}" subtypes: [${(c.subtypes || []).join(', ')}]`)
);
