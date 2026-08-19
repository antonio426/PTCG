/**
 * "Is this card an ACE SPEC?" — one definition for both sides.
 *
 * TCGdex marks ACE SPEC prints with `rarity: 'ACE'`, and the engine's 「ACE消弭」 lock plus the
 * client's ACE SPEC tag both read that field. It is incomplete: 23 Standard-legal prints are
 * ACE SPEC and carry some other rarity, two of them in preset decks (完全體攪拌器 SVK-017 and
 * 貴重手推車 MC-658). Every rarity-marked card is also in the name list below, so the name list
 * is the broader of the two and the union is what a player would recognise.
 *
 * The list previously existed as a hardcoded literal inside CardBrowser.tsx AND DeckBuilder.tsx,
 * while the store and the server used the rarity field — three copies, two definitions, and the
 * same "ACE SPEC" label in the UI meaning different things depending on which control you used.
 */

/** The 29 ACE SPEC card names in the current Standard pool (zh-TW). */
export const ACE_SPEC_NAMES: readonly string[] = [
  '危險光線', '中立中心', '寶可生機劑A', '釣竿MAX', '極限腰帶', '頂尖捕捉器',
  '寶可夢旋風回收機', '璀璨結晶', '珍寶配件', '奢華炸彈', '壯偉碩木', '覺醒戰鼓',
  '英雄斗篷', '高級香氛', '大師球', '重新啟動箱', '倖存鍛鍊器', '不公印章',
  '古舊能量', '能量輸送PRO', '百萬噸吹風機', '奇跡耳麥', '貴重手推車', '急進開關',
  '富裕能量', '完全體攪拌器', '希望護身符', '秘密箱', '新衝天能量',
];

const ACE_SPEC_NAME_SET = new Set(ACE_SPEC_NAMES);

/** Scraped names can carry a leading zero-width character — see normalizeCardName on the server. */
const stripInvisible = (name: string) => name.replace(/^[‌​\s]+/, '').trim();

export function isAceSpec(card: { name: string; rarity?: string }): boolean {
  return card.rarity === 'ACE' || ACE_SPEC_NAME_SET.has(stripInvisible(card.name));
}
