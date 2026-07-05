import fs from 'fs';
const d = JSON.parse(fs.readFileSync('C:/Users/antonio/Desktop/PTCG/ptcg-game/server/data/scraped-cards.json','utf-8'));
const t = d.data.filter(c => c.supertype === 'Trainer');
const subs = new Set();
t.forEach(c => c.subtypes.forEach(s => subs.add(s)));
console.log('Trainer subtypes:', [...subs].join(', '));
console.log('Count per subtype:');
[...subs].sort().forEach(s => console.log('  ' + s + ': ' + t.filter(c => c.subtypes.includes(s)).length));
