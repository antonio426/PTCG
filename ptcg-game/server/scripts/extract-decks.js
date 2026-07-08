const fs = require('fs');
const content = fs.readFileSync(
  'C:/Users/antonio/Desktop/PTCG/ptcg-game/server/data/preset-decks-source.js',
  'utf-8'
);

const decks = [];
let searchStart = 0;

while (true) {
  const deckStart = content.indexOf('{id:"__preset_', searchStart);
  if (deckStart === -1) break;

  let depth = 0;
  let inStr = false;
  let endPos = deckStart;

  for (let i = deckStart; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endPos = i + 1; break; }
      }
    }
  }

  const objStr = content.substring(deckStart, endPos);
  try {
    // Convert to valid JSON by quoting property names and removing trailing commas
    const jsonStr = objStr
      .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3')
      .replace(/,(\s*[}\]])/g, '$1');
    const obj = JSON.parse(jsonStr);
    decks.push({ name: obj.name, entries: obj.entries });
  } catch (e) {
    console.log('Parse error at position', deckStart, '-', e.message);
  }

  searchStart = endPos;
}

console.log('Total decks extracted:', decks.length);
decks.forEach((d, i) => {
  const total = d.entries.reduce((s, e) => s + e.count, 0);
  console.log((i + 1) + '.', d.name, '(' + d.entries.length + ' kinds,', total, 'cards)');
});

// Save as JSON
const out = decks.map(d => ({
  id: d.name,
  name: d.name,
  entries: d.entries.map(e => ({
    cardId: 'scr-' + e.cardId,
    count: e.count
  }))
}));

fs.writeFileSync(
  'C:/Users/antonio/Desktop/PTCG/ptcg-game/server/data/preset-decks.json',
  JSON.stringify(out, null, 2),
  'utf-8'
);
console.log('\nSaved to preset-decks.json');
