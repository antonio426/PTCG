import fs from 'fs';

const scraped = JSON.parse(fs.readFileSync(process.cwd()+'/data/scraped-cards.json', 'utf-8'));
const cards = scraped.data;

// Find the 15 misclassified cards
const names = ['火箭隊的咩利羊','洛托姆ex','胖嘟嘟ex','超級摔角鷹人ex','火箭隊的黑暗鴉','流氓鱷ex','火箭隊的烏鴉頭頭','超級毒藻龍ex','派帕的貪心栗鼠','火箭隊的多邊獸Ⅱ','火箭隊的多邊獸Z','火箭隊的袋獸ex','探探鼠','喵喵ex','銀伴戰獸'];

console.log('=== Checking 15 misclassified cards ===');
for (const n of names) {
  const found = cards.filter(c => c.name === n);
  if (found.length === 0) {
    const partial = cards.filter(c => c.name.includes(n) || n.includes(c.name));
    console.log(`${n}: NOT FOUND (partial: ${partial.map(c=>c.name+'['+c.id+']').join(', ') || 'none'})`);
  } else {
    for (const c of found) {
      console.log(`${c.id} | ${c.name} | supertype=${c.supertype} | subtypes=${(c.subtypes||[]).join(',')}`);
    }
  }
}

// Check ALL cards with supertype=Trainer - list them all
const trainers = cards.filter(c => c.supertype === 'Trainer');
console.log(`\n=== TOTAL TRAINERS: ${trainers.length} ===`);
trainers.forEach(c => console.log(`${c.id} | ${c.name} | subtypes=${(c.subtypes||[]).join(',')}`));
