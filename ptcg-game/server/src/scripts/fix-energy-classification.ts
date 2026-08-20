/**
 * Fixes every remaining Energy misclassification in cards.json / cards-final.json.
 *
 * patch-basic-energy-subtype.ts only matched the bracketed 基本【X】能量 naming, which left three
 * classes of bad data, all found while verifying the Special Energy 4-copy deck rule:
 *
 *  1. Bracket-less Basic Energy promo prints (基本火能量 from S10b/SV-P/S8a/…) still subtyped
 *     'Special Energy' → wrongly subject to the 4-copy limit, and invisible to every
 *     "search your deck for a Basic Energy" effect (~70 call sites key on the subtype).
 *  2. SV-P-086 雙重渦輪能量 subtyped 'Basic Energy' → EXEMPT from the 4-copy limit, so the deck
 *     builder would accept 60 copies of a Special Energy.
 *  3. Five non-Energy cards scraped out of starter-deck pages as supertype 'Energy'
 *     (巢穴球, 活力頭帶, 學習裝置, 伽勒爾的胸甲, 一擊的卷軸 憤怒之卷) — two of them subtyped
 *     'Basic Energy', i.e. unlimited copies of an Item in a deck. Reclassified from their
 *     same-name Trainer prints (one has no sibling and is mapped explicitly).
 *
 * Root cause was scrape-missing-card-data.ts (fixed alongside this): it classified any card whose
 * header mentioned 能量 as Energy and only recognized the bracketed Basic naming.
 *
 * Idempotent; run with: npx tsx src/scripts/fix-energy-classification.ts
 */
import fs from 'fs';
import path from 'path';

// One type character, brackets and the 基本 prefix both optional: 基本【火】能量, 基本火能量,
// 基本【炎】能量, plus the prefix-less special-art prints 【惡】能量 / 【鋼】能量 (SV4K/SV4M).
const BASIC_ENERGY_RE = /^(基本[【\[]?.[】\]]?|[【\[].[】\]])能量$/;
// The only supertype-Energy print whose real card has no same-name Trainer print in the dataset.
const NO_SIBLING_FALLBACK: Record<string, { supertype: string; subtypes: string[] }> = {
  '一擊的卷軸 憤怒之卷': { supertype: 'Trainer', subtypes: ['Pokémon Tool'] },
};

function patchFile(filePath: string) {
  if (!fs.existsSync(filePath)) { console.log(`skip (not found): ${filePath}`); return; }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const isWrapped = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.data;
  const cards: any[] = isWrapped ? raw.data : raw;

  let patched = 0;
  const fix = (c: any, what: string, apply: () => void) => {
    apply(); patched++; console.log(`  ${what}: ${c.id} ${c.name}`);
  };

  // Class 4: 驅勁能量 (ブーストエナジー) 未來/古代 — real Special Energy cards that came through
  // the scrape as Trainer/Pokémon Tool with no rules text at all, so they could never be attached
  // and the engine's Special-Energy hooks never saw them. Reclassified by exact name, keeping the
  // paradox tag, and carrying the official text (asia.pokemon-card.com detail 11683 / 11682).
  const BOOST_ENERGY_TEXT: Record<string, string> = {
    '驅勁能量 未來': '附有這張卡的「未來」寶可夢【撤退】所需的能量全部消除，那隻寶可夢使用的招式，對對手的戰鬥寶可夢造成的傷害「+20」點。',
    '驅勁能量 古代': '附有這張卡的「古代」寶可夢的最大HP「+60」，那隻寶可夢不會陷入特殊狀態，並將受到的特殊狀態全部恢復。',
  };
  for (const c of cards) {
    const text = BOOST_ENERGY_TEXT[c.name];
    if (!text) continue;
    if (c.supertype === 'Energy' && c.subtypes?.includes('Special Energy') && c.rules?.[0] === text) continue;
    const tag = (c.subtypes || []).find((s: string) => s === 'Ancient' || s === 'Future')
      ?? (c.name.includes('未來') ? 'Future' : 'Ancient');
    fix(c, `reclassify as Energy/Special Energy (${tag})`, () => {
      c.supertype = 'Energy';
      c.subtypes = ['Special Energy', tag];
      c.rules = [text];
      delete c.hp;
    });
  }

  for (const c of cards) {
    if (c.supertype !== 'Energy') continue;
    const subs: string[] = c.subtypes || [];
    if (!c.name.includes('能量')) {
      // Class 3: not an Energy at all. Copy classification from a same-name non-Energy print.
      const sibling = cards.find(s => s.name === c.name && s.supertype !== 'Energy')
        ?? NO_SIBLING_FALLBACK[c.name];
      if (!sibling) { console.log(`  UNRESOLVED non-energy: ${c.id} ${c.name}`); continue; }
      fix(c, `reclassify as ${sibling.supertype}/${sibling.subtypes}`, () => {
        c.supertype = sibling.supertype;
        c.subtypes = [...sibling.subtypes];
        if ((!c.rules || c.rules.length === 0) && sibling.rules?.length) c.rules = [...sibling.rules];
      });
    } else if (BASIC_ENERGY_RE.test(c.name)) {
      // Class 1. Same treatment as patch-basic-energy-subtype.ts: Basic Energy is always
      // Standard-legal regardless of print.
      if (subs.length !== 1 || subs[0] !== 'Basic Energy') {
        fix(c, 'mark Basic Energy', () => {
          c.subtypes = ['Basic Energy'];
          c.legalities = { ...(c.legalities || {}), standard: 'Legal' };
        });
      }
    } else if (subs.includes('Basic Energy') || !subs.includes('Special Energy')) {
      // Class 2: a named (non-基本) Energy is by definition a Special Energy.
      fix(c, 'mark Special Energy', () => { c.subtypes = ['Special Energy']; });
    }
  }

  // Second pass, same root cause beyond Energy: starter-deck pages also scraped the Item
  // 厲害釣竿 as a 70-HP "Pokémon". A printed name never spans supertypes in the real game, so any
  // name that maps to both Trainer and something else marks the non-Trainer print as junk —
  // reclassify it, but only if it is an empty shell (no attacks, no ability; real Pokémon always
  // have at least one of those).
  const trainerByName = new Map<string, any>();
  for (const c of cards) if (c.supertype === 'Trainer') trainerByName.set(c.name, c);
  for (const c of cards) {
    if (c.supertype === 'Trainer' || c.supertype === 'Energy') continue;
    const sibling = trainerByName.get(c.name);
    if (!sibling || (c.attacks?.length ?? 0) > 0 || (c.abilities?.length ?? 0) > 0) continue;
    fix(c, `reclassify as Trainer/${sibling.subtypes}`, () => {
      c.supertype = 'Trainer';
      c.subtypes = [...sibling.subtypes];
      delete c.hp;
      if ((!c.rules || c.rules.length === 0) && sibling.rules?.length) c.rules = [...sibling.rules];
    });
  }

  console.log(`${filePath}: patched ${patched} cards`);
  if (patched > 0) {
    fs.writeFileSync(filePath, JSON.stringify(isWrapped ? raw : cards, null, 2), 'utf-8');
  }
}

// cards.json only: it is the file the runtime cache actually reads. cards-final.json is a legacy
// intermediate no code consumes, and it is dirty enough (e.g. the Item 能量輸送 sits at supertype
// Energy there) that the name heuristics above would misclassify cards in it.
patchFile(path.join(__dirname, '..', '..', 'data', 'cards.json'));
