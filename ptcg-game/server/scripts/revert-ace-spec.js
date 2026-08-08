/**
 * Revert ACE SPEC rarity tags: 'ACE SPEC Rare' is not a real rarity category
 * in the source data (TCGdex zh-tw). ACE SPEC is now a name-based frontend
 * tag, so restore these cards' rarity to 'None' (the value TCGdex returns
 * for unmarked cards).
 *
 * Idempotent: cards without rarity === 'ACE SPEC Rare' are untouched.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['cards-final.json', 'cards.json'];

for (const f of FILES) {
  const fp = path.join(__dirname, '..', 'data', f);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  let reverted = 0;
  for (const c of raw.data) {
    if (c.rarity === 'ACE SPEC Rare') {
      c.rarity = 'None';
      reverted++;
    }
  }
  fs.writeFileSync(fp, JSON.stringify(raw, null, 2));
  console.log(`${f}: total ${raw.data.length}, reverted ${reverted}`);
}
