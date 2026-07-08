const path = require('path');
const fs = require('fs');
console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('SCRIPT DIR (path.dirname):', path.dirname(__filename || ''));
const DATA_DIR = path.resolve(__dirname, '../../data');
console.log('DATA_DIR:', DATA_DIR);
console.log('exists:', fs.existsSync(DATA_DIR));
const cardsPath = path.join(DATA_DIR, 'cards.json');
console.log('cards.json:', cardsPath);
console.log('file exists:', fs.existsSync(cardsPath));
if (fs.existsSync(cardsPath)) {
  const content = fs.readFileSync(cardsPath, 'utf-8');
  const parsed = JSON.parse(content);
  console.log('length:', parsed.data?.length || 'no data');
}
