// patch-ace-spec-full.js
// 依 29 個 ACE SPEC 官方名稱清單，將本地快取中所有命中卡的 rarity 設為 'ACE SPEC Rare'。
// 同時更新 cards-final.json（權威）與 cards.json（運行副本），使前端 ACE SPEC 標籤可顯示全部 ACE SPEC 卡。
//
// 名稱清單來源：
// - TCGdex EN /en/rarities/ACE SPEC Rare（33 張 / 29 唯一名稱，全在 sv05~sv08.5）為權威
// - zh-tw 名稱映射：28 個為先前人工驗證（patch-ace-spec.ts MANUAL_ZH_TW_NAMES），
//   新衝天能量 = Neo Upper Energy（SV5K-071，擴充包「狂野之力」唯一 Special Energy，標準 Legal）
//
// 安全依據：SV 世代的 29 個 ACE SPEC 名稱在本地資料中唯一定義該 ACE SPEC 卡
// （如 大師球 只以 ACE SPEC 形式存在），因此名稱比對無誤標風險。

const fs = require('fs');
const path = require('path');

const ACE_SPEC_NAMES = [
  '危險光線', // Dangerous Laser
  '中立中心', // Neutralization Zone
  '寶可生機劑A', // Poké Vital A
  '釣竿MAX', // Max Rod
  '極限腰帶', // Maximum Belt
  '頂尖捕捉器', // Prime Catcher
  '寶可夢旋風回收機', // Scoop Up Cyclone
  '璀璨結晶', // Sparkling Crystal
  '珍寶配件', // Treasure Tracker
  '奢華炸彈', // Deluxe Bomb
  '壯偉碩木', // Grand Tree
  '覺醒戰鼓', // Awakening Drum
  '英雄斗篷', // Hero's Cape
  '高級香氛', // Hyper Aroma
  '大師球', // Master Ball
  '重新啟動箱', // Reboot Pod
  '倖存鍛鍊器', // Survival Brace
  '不公印章', // Unfair Stamp
  '古舊能量', // Legacy Energy
  '能量輸送PRO', // Energy Search Pro
  '百萬噸吹風機', // Megaton Blower
  '奇跡耳麥', // Miracle Headset
  '貴重手推車', // Precious Trolley
  '急進開關', // Scramble Switch
  '富裕能量', // Enriching Energy
  '完全體攪拌器', // Brilliant Blender
  '希望護身符', // Amulet of Hope
  '秘密箱', // Secret Box
  '新衝天能量', // Neo Upper Energy
];

const RARITY = 'ACE SPEC Rare';

const dataDir = path.join(__dirname, '..', 'data');
const files = ['cards-final.json', 'cards.json'];

for (const f of files) {
  const fp = path.join(dataDir, f);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const cards = raw.data;
  let hit = 0;
  for (const c of cards) {
    if (ACE_SPEC_NAMES.includes(c.name)) {
      c.rarity = RARITY;
      hit++;
    }
  }
  fs.writeFileSync(fp, JSON.stringify(raw, null, 2));
  console.log(`${f}: total ${cards.length}, tagged ${hit}`);
}
