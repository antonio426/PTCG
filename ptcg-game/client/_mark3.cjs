const fs = require('fs');
const p = 'src/pages/Battle.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (from, to) => { if (!s.includes(from)) throw new Error('anchor: ' + from.slice(0, 60)); s = s.replace(from, to); };
rep(`      onClick={onClick}
      role={onClick ? 'button' : undefined}`,
`      onClick={onClick}
      // A board Pokémon that is a legal click-target right now. Marked for the same reason the
      // hand cards are: targeting happens by clicking the real card, so an automated pass has no
      // other way to see that this is where the answer to a select_pokemon choice lives.
      data-board-target={targetable ? card.id : undefined}
      role={onClick ? 'button' : undefined}`);
fs.writeFileSync(p, s);
console.log('board targets marked');
