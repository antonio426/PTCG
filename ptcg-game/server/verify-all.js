// Verify Issue 4: 15 cards now correctly Pokémon
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('data/scraped-cards.json', 'utf-8'));
const cards = data.data;

// Check all 15 formerly misclassified cards
const checks = [
  '火箭隊的咩利羊', '洛托姆ex', '胖嘟嘟ex', '超級摔角鷹人ex',
  '火箭隊的黑暗鴉', '流氓鱷ex', '火箭隊的烏鴉頭頭', '超級毒藻龍ex',
  '派帕的貪心栗鼠', '火箭隊的多邊獸Ⅱ', '火箭隊的多邊獸Z',
  '火箭隊的袋獸ex', '探探鼠', '喵喵ex', '銀伴戰獸'
];

let ok = 0;
let fail = 0;
for (const name of checks) {
  const found = cards.filter(c => c.name.includes(name));
  const allPokemon = found.every(c => c.supertype === 'Pokémon');
  if (allPokemon && found.length > 0) {
    ok++;
    console.log(`✅ ${name}: ${found.length} version(s) all Pokémon`);
  } else {
    fail++;
    console.log(`❌ ${name}: ${found.map(c => `${c.id}=${c.supertype}`).join(', ')}`);
  }
}

console.log(`\n${ok}/15 correct, ${fail} failed`);
