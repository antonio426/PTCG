/**
 * Scrape full card data + images for official standard cards that TCGdex zh-tw
 * doesn't have. Cross-references official-standard-cards.json (5,146 cards)
 * against TCGdex cards.json. For any official card whose name doesn't appear
 * in cards.json, fetches the official detail page (using cheerio) and
 * extracts all card fields into MapCard format.
 *
 * Output: server/data/scraped-cards.json (MapCard[] format)
 * Images downloaded to: server/data/images/scraped/
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import type { MapCard, CardSet, EnergyType, Attack, Ability, WeaknessResistance, Subtype, Supertype } from '../card-api/types';

// ── Paths ──
const OFFICIAL_DATA = path.resolve(__dirname, '../../../data-scraped/official-standard-cards.json');
const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_OUT = path.resolve(__dirname, '../../data/scraped-cards.json');
const IMAGE_DIR = path.resolve(__dirname, '../../data/images/scraped');

const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail';
const IMG_BASE = 'https://asia.pokemon-card.com/tw/card-img';

interface OfficialCard {
  id: number;
  name: string;
  regulation: string;
  expansionCode: string;
  cardNumber: string;
}

// Map energy img filenames to EnergyType
const ENERGY_MAP: Record<string, EnergyType> = {
  'Grass.png': 'Grass',
  'Fire.png': 'Fire',
  'Water.png': 'Water',
  'Lightning.png': 'Lightning',
  'Psychic.png': 'Psychic',
  'Fighting.png': 'Fighting',
  'Darkness.png': 'Darkness',
  'Metal.png': 'Metal',
  'Fairy.png': 'Fairy',
  'Dragon.png': 'Dragon',
  'Colorless.png': 'Colorless',
};

// Map expansion codes to set info
const EXPANSION_SET_MAP: Record<string, Partial<CardSet>> = {
  'SV8a': { name: 'SV8a', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
  'SV10': { name: 'SV10 火箭隊', series: 'SV', printedTotal: 98, total: 98, releaseDate: '' },
  'SV9': { name: 'SV9 對戰夥伴', series: 'SV', printedTotal: 100, total: 100, releaseDate: '' },
  'M5': { name: 'M5 新緑の深淵', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
  'SVQL': { name: 'SVQL 傳說時空', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
  'SVQP': { name: 'SVQP デッキビルドセット', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
};

/** Extract energy type from img src */
function parseEnergy(html: string): EnergyType | null {
  const m = html.match(/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png/);
  if (m && m[0] in ENERGY_MAP) return ENERGY_MAP[m[0]];
  return null;
}

/** Parse a card detail page HTML into partial MapCard fields using cheerio */
function parseCardHtml(id: number, html: string, baseOfficial: OfficialCard): Partial<MapCard> {
  const $ = cheerio.load(html);
  const card: Partial<MapCard> = {
    id: `scr-${id}`,
    name: baseOfficial.name.replace(/&lt;/g, '').replace(/&gt;/g, ''),
    legalities: { standard: 'Legal' },
    regulationMark: baseOfficial.regulation,
    number: baseOfficial.cardNumber,
    // Use local proxy image URLs (route: /api/images/scr/:id/:variant)
    images: {
      small: `/api/images/scr/${id}/low`,
      large: `/api/images/scr/${id}/high`,
    },
  };

  // ── Regulation mark from page ──
  const regText = $('.alpha').first().text().trim();
  if (regText) card.regulationMark = regText;

  // ── Card number from page ──
  const numText = $('.collectorNumber').first().text().trim();
  if (numText) card.number = numText;

  // ── Set info from expansion link column ──
  let expCode = baseOfficial.expansionCode;
  if (!expCode) {
    // Try link: /tw/card-search/list/?expansionCodes=M5
    const expLinkMatch = html.match(/expansionCodes=([A-Za-z0-9]+)/);
    if (expLinkMatch) expCode = expLinkMatch[1];
  }
  // Get set name from the expansion link column
  const setNameFromPage = $('.expansionLinkColumn a').first().text().trim();
  if (expCode) {
    card.set = {
      id: expCode,
      name: setNameFromPage || expCode,
      // Derive series from regulation mark or set code prefix
      series: getSeriesFromRegulation(card.regulationMark || '', expCode),
      printedTotal: 0,
      total: 0,
      releaseDate: '',
    };
  } else {
    card.set = {
      id: 'unknown',
      name: setNameFromPage || 'Unknown',
      series: 'SV',
      printedTotal: 0,
      total: 0,
      releaseDate: '',
    };
  }

  // ── Supertype / Subtype ──
  const headerText = $('h3.commonHeader').first().text().trim();
  const evoText = $('.evolveMarker').first().text().trim();
  const pageText = $.text(); // for VMAX/VSTAR/ex detection on Pokémon cards

  // Check for Pokémon indicators FIRST (evolveMarker is exclusive to Pokémon cards)
  if (evoText) {
    card.supertype = 'Pokémon';
    card.subtypes = [];

    if (evoText === '基本' || evoText === '基礎') {
      card.subtypes.push('Basic');
    } else if (evoText.includes('1階') || evoText === '1' || evoText.includes('一階')) {
      card.subtypes.push('Stage 1');
    } else if (evoText.includes('2階') || evoText === '2' || evoText.includes('二階')) {
      card.subtypes.push('Stage 2');
    }

    // Detect VMAX / VSTAR from page text
    if (/VMAX/i.test(pageText)) card.subtypes.push('VMAX');
    if (/VSTAR/i.test(pageText)) card.subtypes.push('VSTAR');
    // ex: only if the card name ends with "ex" (e.g., "超級達克萊伊ex")
    if (baseOfficial.name.endsWith('ex')) {
      card.subtypes.push('ex');
    }
  } else if (headerText.includes('支援者卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Supporter'];
  } else if (headerText.includes('道具') || headerText.includes('物品卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Item'];
  } else if (headerText.includes('競技場卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Stadium'];
  } else if (headerText.includes('能量')) {
    card.supertype = 'Energy';
    const isBasic = /^基本[【\[]([^】\]]+)[】\]]能量$/.test(baseOfficial.name);
    card.subtypes = [isBasic ? 'Basic Energy' : 'Special Energy'];
  } else {
    card.supertype = 'Pokémon';
    card.subtypes = [];
  }

  // ── HP ──
  const hpText = $('.mainInfomation .number').first().text().trim();
  if (hpText) card.hp = hpText;

  // ── Type ──
  const typeImgSrc = $('.mainInfomation img').first().attr('src') || '';
  const typeMatch = typeImgSrc.match(/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png/);
  if (typeMatch) {
    card.types = [ENERGY_MAP[typeMatch[1] + '.png']!];
  }

  // ── Attacks / Abilities ──
  // Both live in the same .skill blocks on this site (there is no separate .abilityBlock —
  // that selector never matched anything, so abilities were silently dropped every run). An
  // ability is distinguished only by its .skillName being prefixed "[特性] ". Trainer "rule
  // reminder" blocks (e.g. "[支援者規則]") use the same bracket convention but aren't real card
  // data — skip those specifically, and log (not silently drop) anything else bracket-prefixed
  // so a genuinely new category doesn't get misfiled unnoticed.
  const REMINDER_PREFIXES = ['[物品規則]', '[支援者規則]', '[競技場規則]', '[寶可夢道具規則]', '[ACE SPEC規則]'];
  const attacks: Attack[] = [];
  const abilities: Ability[] = [];
  $('.skill').each((_i, el) => {
    const $el = $(el);
    let name = $el.find('.skillName').text().trim();
    if (!name) return;

    const damage = $el.find('.skillDamage').text().trim();
    const effect = $el.find('.skillEffect').text().trim();

    let isAbility = false;
    if (name.startsWith('[')) {
      if (name.startsWith('[特性]')) {
        isAbility = true;
        name = name.replace(/^\[特性\]\s*/, '');
      } else if (REMINDER_PREFIXES.some(p => name.startsWith(p))) {
        return;
      } else {
        console.warn(`  [unrecognized bracket-prefixed skill block, skipped] "${name}"`);
        return;
      }
    }

    if (isAbility) {
      abilities.push({ name, text: effect || '', type: 'Ability' });
      return;
    }

    // Energy costs from images inside .skillCost
    const cost: EnergyType[] = [];
    $el.find('.skillCost img').each((_, img) => {
      const src = $(img).attr('src') || '';
      const e = parseEnergy(src);
      if (e) cost.push(e);
    });

    attacks.push({
      name,
      cost,
      convertedEnergyCost: cost.length,
      damage: damage || '',
      text: effect || '',
    });
  });
  if (attacks.length > 0) card.attacks = attacks;
  if (abilities.length > 0) card.abilities = abilities;

  // ── Weakness / Resistance / Retreat ──
  // Weakness
  const weakTd = $('.weakpoint');
  if (weakTd.length) {
    const weakImg = weakTd.find('img').first().attr('src') || '';
    const weakE = parseEnergy(weakImg);
    if (weakE) {
      card.weaknesses = [{ type: weakE, value: '×2' }];
    }
  }

  // Resistance
  const resistTd = $('.resist');
  if (resistTd.length) {
    const resistText = resistTd.text().trim();
    if (resistText !== '--' && resistText !== '－') {
      const resistImg = resistTd.find('img').first().attr('src') || '';
      const resistE = parseEnergy(resistImg);
      if (resistE) {
        card.resistances = [{ type: resistE, value: '-30' }];
      }
    }
  }

  // Retreat
  const escapeTd = $('.escape');
  if (escapeTd.length) {
    const retreatCosts: EnergyType[] = [];
    escapeTd.find('img').each((_, img) => {
      const src = $(img).attr('src') || '';
      const e = parseEnergy(src);
      if (e) retreatCosts.push(e);
    });
    if (retreatCosts.length > 0) {
      card.retreatCost = retreatCosts;
      card.convertedRetreatCost = retreatCosts.length;
    }
  }

  // ── Artist ──
  const artistEl = $('.illustrator a');
  if (artistEl.length) {
    const artistText = artistEl.first().text().trim();
    if (artistText) card.artist = artistText;
  }

  return card;
}

/** Derive set series from regulation mark and/or set code */
function getSeriesFromRegulation(regulationMark: string, setCode: string): string {
  // Regulation marks: G+ = SV series, F and earlier = S series
  if (regulationMark) {
    const mark = regulationMark.toUpperCase();
    if (mark >= 'G') return 'SV';
    if (mark >= 'A' && mark <= 'F') return 'S';
  }
  // Fallback: check set code prefix
  const upper = setCode.toUpperCase();
  if (upper.startsWith('SV')) return 'SV';
  if (upper.startsWith('S') || upper.startsWith('A') || upper.startsWith('M')) {
    // M sets are promos — could be either era, check code pattern
    return regulationMark >= 'G' ? 'SV' : 'S';
  }
  return 'SV';
}

/** Download image from URL to local file */
async function downloadImage(url: string, filePath: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // ── Step 1: Read official data ──
  console.log('=== Step 1: Reading official standard cards ===');
  const rawOfficial = JSON.parse(fs.readFileSync(OFFICIAL_DATA, 'utf-8'));
  const officialCards = rawOfficial.cards as OfficialCard[];
  const officialNamesSet = new Set(officialCards.map(c => c.name));
  console.log(`  Official standard cards: ${officialCards.length}`);
  console.log(`  Unique official names: ${officialNamesSet.size}`);

  // ── Step 2: Read TCGdex cards.json ──
  console.log('\n=== Step 2: Reading TCGdex cards.json ===');
  const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8'));
  const existingCards = cacheRaw.data as MapCard[];
  const existingNames = new Set(existingCards.map(c => c.name));
  console.log(`  TCGdex cards: ${existingCards.length}`);
  console.log(`  Unique TCGdex names: ${existingNames.size}`);

  // ── Step 3: Find official cards NOT in TCGdex ──
  console.log('\n=== Step 3: Identifying missing cards ===');
  const missingIds: number[] = [];
  for (const card of officialCards) {
    if (!existingNames.has(card.name) && card.name) {
      missingIds.push(card.id);
    }
  }
  // Deduplicate IDs (a card with same name but different art can share the ID)
  const uniqueMissingIds = [...new Set(missingIds)].sort((a, b) => a - b);
  console.log(`  Missing card entries (by ID): ${missingIds.length}`);
  console.log(`  Unique missing IDs: ${uniqueMissingIds.length}`);

  // ── Step 4: Build name→official card lookup ──
  const officialById = new Map<number, OfficialCard>();
  for (const card of officialCards) {
    officialById.set(card.id, card);
  }

  // ── Step 5: Fetch detail pages ──
  console.log('\n=== Step 4: Fetching detail pages ===');
  const scrapedCards: MapCard[] = [];
  const errors: { id: number; err: string }[] = [];
  const CONCURRENCY = 5;

  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  for (let i = 0; i < uniqueMissingIds.length; i += CONCURRENCY) {
    const batch = uniqueMissingIds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const base = officialById.get(id)!;
        const res = await fetch(`${DETAIL_BASE}/${id}/`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const partial = parseCardHtml(id, html, base);

        // Fill in missing fields with defaults
        const card: MapCard = {
          id: partial.id || `scr-${id}`,
          name: partial.name || base.name,
          supertype: partial.supertype || 'Pokémon',
          subtypes: partial.subtypes || [],
          set: partial.set || { id: 'unknown', name: 'Unknown', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
          number: partial.number || base.cardNumber,
          legalities: { standard: 'Legal' },
          images: partial.images || { small: '', large: '' },
        };
        if (partial.hp) card.hp = partial.hp;
        if (partial.types) card.types = partial.types;
        if (partial.attacks) card.attacks = partial.attacks;
        if (partial.abilities) card.abilities = partial.abilities;
        if (partial.weaknesses) card.weaknesses = partial.weaknesses;
        if (partial.resistances) card.resistances = partial.resistances;
        if (partial.retreatCost) { card.retreatCost = partial.retreatCost; card.convertedRetreatCost = partial.retreatCost.length; }
        if (partial.artist) card.artist = partial.artist;
        if (partial.regulationMark) card.regulationMark = partial.regulationMark;

        // Download image
        const imgUrl = `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`;
        const imgPath = path.join(IMAGE_DIR, `tw${String(id).padStart(8, '0')}.png`);
        const downloaded = await downloadImage(imgUrl, imgPath);
        if (!downloaded) {
          console.warn(`  [WARN] Image download failed for card ${id} (${base.name})`);
        }

        return card;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        scrapedCards.push(result.value);
      } else {
        errors.push({ id: 0, err: result.reason?.message || 'Unknown error' });
      }
    }

    // Progress
    const done = Math.min(i + CONCURRENCY, uniqueMissingIds.length);
    if (done % 100 === 0 || done >= uniqueMissingIds.length) {
      console.log(`  Progress: ${done}/${uniqueMissingIds.length} — Collected: ${scrapedCards.length}, Errors: ${errors.length}`);
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  // ── Statistics ──
  console.log(`\n=== Step 5: Results ===`);
  console.log(`  Cards fetched successfully: ${scrapedCards.length}`);
  console.log(`  Errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log(`  First 5 errors:`);
    errors.slice(0, 5).forEach((e, i) => console.log(`    ${i + 1}. ${JSON.stringify(e)}`));
  }

  // Count by supertype
  const supertypes: Record<string, number> = {};
  for (const card of scrapedCards) {
    supertypes[card.supertype] = (supertypes[card.supertype] || 0) + 1;
  }
  console.log(`\n  By supertype:`);
  for (const [st, count] of Object.entries(supertypes).sort()) {
    console.log(`    ${st}: ${count}`);
  }

  // ── Save ──
  const output = {
    timestamp: Date.now(),
    totalOfficial: officialCards.length,
    totalExisting: existingCards.length,
    missingEntries: missingIds.length,
    uniqueMissingIds: uniqueMissingIds.length,
    scraped: scrapedCards.length,
    errors: errors.length,
    data: scrapedCards,
  };

  fs.writeFileSync(SCRAPED_OUT, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n  Saved ${SCRAPED_OUT} (${(fs.statSync(SCRAPED_OUT).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  Images saved to ${IMAGE_DIR}`);

  // ── Summary ──
  const totalAvailable = existingCards.length + scrapedCards.length;
  const standardCount = existingCards.filter(c => c.legalities?.standard === 'Legal').length + scrapedCards.length;
  console.log(`\n=== Final Summary ===`);
  console.log(`  TCGdex cards:         ${existingCards.length}`);
  console.log(`  Scraped cards added:  ${scrapedCards.length}`);
  console.log(`  Total available:      ${totalAvailable}`);
  console.log(`  Target (official):    ${officialCards.length}`);
  console.log(`  Standard-legal now:   ${standardCount}`);
  if (standardCount >= officialCards.length) {
    console.log(`\n  ✅ ALL ${officialCards.length} official standard cards are now in the database!`);
  } else {
    console.log(`\n  ⚠️  Still missing: ${officialCards.length - standardCount} cards`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
