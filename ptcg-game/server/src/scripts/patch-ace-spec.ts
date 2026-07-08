/**
 * patch-ace-spec.ts
 * 
 * Patches cards.json to set rarity = "ACE SPEC Rare" for all ACE SPEC cards.
 * 
 * Approach: For each ACE SPEC card listed by English TCGdex API, try to find
 * the zh-tw equivalent by set ID mapping, then update cards.json.
 */
import * as fs from 'fs';
import * as path from 'path';

const API_BASE = 'https://api.tcgdex.net/v2';
const DATA_DIR = path.resolve(__dirname, '../../data');

interface TcgdexSummary {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

interface TcgdexRarityResponse {
  name: string;
  cards: TcgdexSummary[];
}

interface CardSetRef {
  id: string;
  name: string;
}

interface CardEntry {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  rarity?: string;
  set?: CardSetRef;
  [key: string]: unknown;
}

async function apiFetch<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

// Known zh-tw names for ACE SPEC cards (verified from cards.json)
const MANUAL_ZH_TW_NAMES: Record<string, string> = {
  'Dangerous Laser': '危險光線',
  'Neutralization Zone': '中立中心',
  'Poké Vital A': '寶可生機劑A',
  'Max Rod': '釣竿MAX',
  'Maximum Belt': '極限腰帶',
  'Prime Catcher': '頂尖捕捉器',
  'Scoop Up Cyclone': '寶可夢旋風回收機',
  'Sparkling Crystal': '璀璨結晶',
  'Treasure Tracker': '珍寶配件',
  'Deluxe Bomb': '奢華炸彈',
  'Grand Tree': '壯偉碩木',
  'Awakening Drum': '覺醒戰鼓',
  "Hero's Cape": '英雄斗篷',
  'Hyper Aroma': '高級香氛',
  'Master Ball': '大師球',
  'Reboot Pod': '重新啟動箱',
  'Survival Brace': '倖存鍛鍊器',
  'Unfair Stamp': '不公印章',
  'Legacy Energy': '古舊能量',
  'Energy Search Pro': '能量輸送PRO',
  'Megaton Blower': '百萬噸吹風機',
  'Miracle Headset': '奇跡耳麥',  // NOT 奇蹟 — zh-tw name uses 跡
  'Precious Trolley': '貴重手推車',
  'Scramble Switch': '急進開關',
  'Enriching Energy': '富裕能量',
  'Brilliant Blender': '完全體攪拌器',
  'Amulet of Hope': '希望護身符',
  'Secret Box': '秘密箱',
};

async function main() {
  const cardsPath = path.join(DATA_DIR, 'cards.json');
  const raw = JSON.parse(fs.readFileSync(cardsPath, 'utf-8'));
  const cards: CardEntry[] = raw.data;
  console.log(`Loaded ${cards.length} cards from cards.json`);

  // Fetch English ACE SPEC cards
  console.log('Fetching English ACE SPEC cards from TCGdex...');
  const enAceSpec = await apiFetch<TcgdexRarityResponse>('/en/rarities/ACE%20SPEC%20Rare');
  console.log(`Found ${enAceSpec.cards.length} ACE SPEC cards in English TCGdex`);

  // Set ID mapping: English -> zh-tw
  const SET_MAP: Record<string, string[]> = {
    'sv05': ['SV5a', 'SV5M'],
    'sv06': ['SV6'],
    'sv06.5': ['SV6a'],
    'sv07': ['SV7'],
    'sv08': ['SV8'],
    'sv08.5': ['SV8a'],
  };

  // Chinese set IDs known to contain ACE SPEC cards
  // Cards from other sets with the same name (e.g. reprints in starter decks)
  // should NOT be marked as ACE SPEC.
  const KNOWN_ACE_SPEC_SETS = new Set([
    'SV5a', 'SV5M', 'SV5K',  // Temporal Forces era
    'SV6', 'SV6a',            // Twilight Masquerade / Shrouded Fable era
    'SV7', 'SV7a',            // Stellar Crown / Paradise Dragona era
    'SV8', 'SV8a',            // Surging Sparks / Prismatic Evolutions era
  ]);

  let foundByName = 0;
  let foundBySetMap = 0;
  let notFound = 0;
  const zhTwMatchedNames: string[] = [];

  for (const enCard of enAceSpec.cards) {
    // Check manual name map first
    if (MANUAL_ZH_TW_NAMES[enCard.name]) {
      zhTwMatchedNames.push(MANUAL_ZH_TW_NAMES[enCard.name]);
      foundByName++;
      console.log(`  [NAME] ${enCard.name} -> ${MANUAL_ZH_TW_NAMES[enCard.name]}`);
      continue;
    }

    // Try set+localId match
    const parts = enCard.id.split('-');
    const enSetId = parts[0];
    const localId = parts.slice(1).join('-');
    const zhTwSetIds = SET_MAP[enSetId];
    
    if (zhTwSetIds) {
      let matchFound = false;
      for (const zhTwSetId of zhTwSetIds) {
        // Try original padding
        const guessedZhTwId = `${zhTwSetId}-${localId}`;
        try {
          const detail = await apiFetch<{ name: string }>(`/zh-tw/cards/${guessedZhTwId}`);
          zhTwMatchedNames.push(detail.name);
          foundBySetMap++;
          console.log(`  [SET] ${enCard.name} (en:${enCard.id}) -> zh-tw: ${detail.name} (${guessedZhTwId})`);
          matchFound = true;
          break;
        } catch {
          // Try 3-digit padding
          const paddedId = localId.padStart(3, '0');
          const guessedPadded = `${zhTwSetId}-${paddedId}`;
          try {
            const detail = await apiFetch<{ name: string }>(`/zh-tw/cards/${guessedPadded}`);
            zhTwMatchedNames.push(detail.name);
            foundBySetMap++;
            console.log(`  [SET] ${enCard.name} (en:${enCard.id}) -> zh-tw: ${detail.name} (${guessedPadded})`);
            matchFound = true;
            break;
          } catch {
            // Try 2-digit padding
            const paddedId2 = localId.padStart(2, '0');
            const guessedPadded2 = `${zhTwSetId}-${paddedId2}`;
            try {
              const detail = await apiFetch<{ name: string }>(`/zh-tw/cards/${guessedPadded2}`);
              zhTwMatchedNames.push(detail.name);
              foundBySetMap++;
              console.log(`  [SET] ${enCard.name} (en:${enCard.id}) -> zh-tw: ${detail.name} (${guessedPadded2})`);
              matchFound = true;
              break;
            } catch {
              // try next zh-tw set mapping
            }
          }
        }
      }
      if (!matchFound) {
        notFound++;
        console.log(`  [MISS] ${enCard.name} (en:${enCard.id}) -> no zh-tw match`);
      }
    } else {
      notFound++;
      console.log(`  [MISS] ${enCard.name} (en:${enCard.id}) -> Unknown set ${enSetId}`);
    }
  }

  console.log(`\nMatched: ${foundByName} by name, ${foundBySetMap} by set mapping, ${notFound} not found`);
  console.log(`Unique zh-tw names to update: ${zhTwMatchedNames.length}`);

  // Also need to handle "Neo Upper Energy" and "Secret Box" which are ACE SPEC
  // but are in the "missing" list from set mapping. Let's look for known names.
  // "Neo Upper Energy" might be a Special Energy card
  // "Secret Box" might be a different Chinese name
  // Check if there are names in cards.json matching these patterns

  // Update cards.json
  let updated = 0;
  const uniqueNames = [...new Set(zhTwMatchedNames)];
  
  for (const card of cards) {
    // Only mark cards from known ACE SPEC sets to avoid false positives
    // from reprints in starter decks, special sets, etc.
    if (
      uniqueNames.includes(card.name)
      && card.set?.id
      && KNOWN_ACE_SPEC_SETS.has(card.set.id)
      && card.rarity !== 'ACE SPEC Rare'
    ) {
      const oldRarity = card.rarity;
      card.rarity = 'ACE SPEC Rare';
      updated++;
      console.log(`  UPDATED: ${card.id} ${card.name} (${card.set.id}) rarity: ${oldRarity} -> ACE SPEC Rare`);
    }
  }

  raw.data = cards;
  raw.timestamp = Date.now();
  fs.writeFileSync(cardsPath, JSON.stringify(raw, null, 2), 'utf-8');
  
  const aceCount = cards.filter(c => c.rarity === 'ACE SPEC Rare').length;
  const aceNames = [...new Set(cards.filter(c => c.rarity === 'ACE SPEC Rare').map(c => c.name))];
  console.log(`\nDone! Updated ${updated} cards.`);
  console.log(`Total ACE SPEC cards in DB: ${aceCount}`);
  console.log(`Unique ACE SPEC names (${aceNames.length}):`);
  aceNames.forEach(n => console.log(`  - ${n}`));
}

main().catch(console.error);
