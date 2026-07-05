async function main() {
  const res = await fetch('http://localhost:3001/api/cards/search?q=');
  const data = await res.json();
  const c = data.data;
  const st = {};
  c.forEach(x => st[x.supertype] = (st[x.supertype]||0)+1);
  console.log('Supertype counts:', JSON.stringify(st));
  console.log('Total:', c.length);
  const mega = c.find(x => x.name.includes('超級差不多娃娃ex'));
  if (mega) console.log('Mega test:', mega.id, mega.name, mega.supertype, mega.subtypes);
  else console.log('Mega NOT found - may need restart');
  const rocket = c.find(x => x.name.includes('火箭隊的黑暗鴉'));
  if (rocket) console.log('Rocket test:', rocket.id, rocket.name, rocket.supertype, rocket.subtypes);
}
main().catch(e => console.log('Error:', e.message));
