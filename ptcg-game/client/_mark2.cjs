const fs = require('fs');
const p = 'src/pages/Battle.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (from, to) => { if (!s.includes(from)) throw new Error('anchor: ' + from.slice(0, 50)); s = s.replace(from, to); };
// The draw button builds its move inline, so the blanket data-move pass missed it.
rep(`            <button
              onClick={() => {
                const drawMove = quickActions.find(m => m.type === 'draw_card');
                if (drawMove) handleSubmitMove(drawMove);
              }}
              disabled={loading}`,
`            <button
              onClick={() => {
                const drawMove = quickActions.find(m => m.type === 'draw_card');
                if (drawMove) handleSubmitMove(drawMove);
              }}
              data-move="draw_card"
              disabled={loading}`);
fs.writeFileSync(p, s);
console.log('draw button marked');
