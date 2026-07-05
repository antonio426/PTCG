// Verify Issue 4: 15 cards should be Pokemon
const res = await fetch('http://localhost:3001/api/cards/search?q=');
const data = await res.json();
const all = data.data;

// Check 15 misclassified cards
const checks = [
  '火箭隊的咩利羊','洛托姆ex','胖嘟嘟ex','超級摔角鷹人ex',
  '火箭隊的黑暗鴉','流氓鱷ex','火箭隊的烏鴉頭頭','超級毒藻龍ex',
  '派帕的貪心栗鼠','火箭隊的多邊獸','火箭隊的袋獸ex','探探鼠','喵喵ex','銀伴戰獸'
];
let allOk = true;
for (const name of checks) {
  const found = all.filter(x => x.name.startsWith(name) || x.name.includes(name));
  if (found.length === 0) {
    console.log('NOT FOUND:', name);
    allOk = false;
  } else {
    const wrong = found.filter(x => x.supertype !== 'Pokémon');
    if (wrong.length > 0) {
      console.log('WRONG:', name, '->', wrong.map(x => x.supertype+'/'+x.id));
      allOk = false;
    } else {
      console.log('OK:', name, '->', found.map(x => x.subtypes.join(',')));
    }
  }
}
console.log(allOk ? '\n✅ Issue 4: All 15+ cards correctly Pokemon' : '\n❌ Some still wrong');
