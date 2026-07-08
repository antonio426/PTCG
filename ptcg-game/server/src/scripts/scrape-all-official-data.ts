/**
 * Scrape ALL official standard cards (5146) with full detail data.
 *
 * Reads official-standard-cards.json (5146 card IDs + basic info),
 * fetches each card's detail page, extracts full card data (HP, types,
 * attacks, abilities, etc.) and saves to scraped-cards-all.json.
 *
 * Run AFTER scrape-official-standard.ts has completed.
 * The result can be merged into cards.json via merge-scraped-cards.ts or
 * a dedicated merge script.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import type { MapCard, CardSet, EnergyType, Attack, Ability, WeaknessResistance, Subtype, Supertype } from '../card-api/types';

// ── Paths ──
const OFFICIAL_DATA = path.resolve(__dirname, '../../../data-scraped/official-standard-cards.json');
const SCRAPED_ALL_OUT = path.resolve(__dirname, '../../data/scraped-cards-all.json');

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

/** Parse a card detail page HTML into partial MapCard fields */
function parseCardHtml(id: number, html: string, baseOfficial: OfficialCard): Partial<MapCard> {
  const $ = cheerio.load(html);
  const card: Partial<MapCard> = {
    id: `scr-${id}`,
    name: baseOfficial.name.replace(/&lt;/g, '').replace(/&gt;/g, ''),
    legalities: { standard: 'Legal' },
    regulationMark: baseOfficial.regulation,
    number: baseOfficial.cardNumber,
    images: {
      small: `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`,
      large: `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`,
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
    const expLinkMatch = html.match(/expansionCodes=([A-Za-z0-9]+)/);
    if (expLinkMatch) expCode = expLinkMatch[1];
  }
  const setNameFromPage = $('.expansionLinkColumn a').first().text().trim();
  if (expCode) {
    card.set = {
      id: expCode,
      name: setNameFromPage || expCode,
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
  const pageText = $.text();

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

    if (/VMAX/i.test(pageText)) card.subtypes.push('VMAX');
    if (/VSTAR/i.test(pageText)) card.subtypes.push('VSTAR');
    if (baseOfficial.name.endsWith('ex')) {
      card.subtypes.push('ex');
    }
  } else if (headerText.includes('支援者卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Supporter'];
  } else if (headerText.includes('寶可夢道具')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Pokémon Tool'];
  } else if (headerText.includes('物品卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Item'];
  } else if (headerText.includes('競技場卡')) {
    card.supertype = 'Trainer';
    card.subtypes = ['Stadium'];
  } else if (headerText.includes('能量')) {
    card.supertype = 'Energy';
    card.subtypes = ['Special Energy'];
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

  // ── Attacks ──
  const attacks: Attack[] = [];
  $('.skill').each((_i, el) => {
    const $el = $(el);
    const name = $el.find('.skillName').text().trim();
    if (!name) return;
    if (name.startsWith('[')) return;

    const damage = $el.find('.skillDamage').text().trim();
    const effect = $el.find('.skillEffect').text().trim();

    const cost: EnergyType[] = [];
    $el.find('.skillCost img').each((_, img) => {
      const src = $(img).attr('src') || '';
      const e = parseEnergyLocal(src);
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

  // ── Abilities ──
  const abilities: Ability[] = [];
  $('.abilityBlock').each((_i, el) => {
    const $el = $(el);
    const name = $el.find('.abilityName').text().trim();
    const text = $el.find('.abilityEffect').text().trim();
    if (name) {
      abilities.push({ name, text, type: 'Ability' });
    }
  });
  if (abilities.length > 0) card.abilities = abilities;

  // ── Weakness / Resistance / Retreat ──
  const weakTd = $('.weakpoint');
  if (weakTd.length) {
    const weakImg = weakTd.find('img').first().attr('src') || '';
    const weakE = parseEnergyLocal(weakImg);
    if (weakE) {
      card.weaknesses = [{ type: weakE, value: '×2' }];
    }
  }

  const resistTd = $('.resist');
  if (resistTd.length) {
    const resistText = resistTd.text().trim();
    if (resistText !== '--' && resistText !== '－') {
      const resistImg = resistTd.find('img').first().attr('src') || '';
      const resistE = parseEnergyLocal(resistImg);
      if (resistE) {
        card.resistances = [{ type: resistE, value: '-30' }];
      }
    }
  }

  const escapeTd = $('.escape');
  if (escapeTd.length) {
    const retreatCosts: EnergyType[] = [];
    escapeTd.find('img').each((_, img) => {
      const src = $(img).attr('src') || '';
      const e = parseEnergyLocal(src);
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

function parseEnergyLocal(html: string): EnergyType | null {
  const m = html.match(/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png/);
  if (m && m[0] in ENERGY_MAP) return ENERGY_MAP[m[0]];
  return null;
}

function getSeriesFromRegulation(regulationMark: string, setCode: string): string {
  if (regulationMark) {
    const mark = regulationMark.toUpperCase();
    if (mark >= 'G') return 'SV';
    if (mark >= 'A' && mark <= 'F') return 'S';
  }
  const upper = setCode.toUpperCase();
  if (upper.startsWith('SV')) return 'SV';
  if (upper.startsWith('S') || upper.startsWith('A') || upper.startsWith('M')) {
    return regulationMark >= 'G' ? 'SV' : 'S';
  }
  return 'SV';
}

async function main() {
  // ── Step 1: Read official data ──
  console.log('=== Step 1: Reading official standard cards ===');
  const rawOfficial = JSON.parse(fs.readFileSync(OFFICIAL_DATA, 'utf-8'));
  const officialCards = rawOfficial.cards as OfficialCard[];
  console.log(`  Official standard cards: ${officialCards.length}`);

  const officialById = new Map<number, OfficialCard>();
  for (const card of officialCards) {
    officialById.set(card.id, card);
  }
  const allIds = [...officialById.keys()].sort((a, b) => a - b);

  // ── Step 2: Fetch detail pages for ALL cards ──
  console.log('\n=== Step 2: Fetching detail pages for ALL cards ===');
  const scrapedCards: MapCard[] = [];
  const errors: { id: number; err: string }[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < allIds.length; i += CONCURRENCY) {
    const batch = allIds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const base = officialById.get(id)!;
        const res = await fetch(`${DETAIL_BASE}/${id}/`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const partial = parseCardHtml(id, html, base);

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

    const done = Math.min(i + CONCURRENCY, allIds.length);
    if (done % 200 === 0 || done >= allIds.length) {
      const pct = (done / allIds.length * 100).toFixed(1);
      console.log(`  Progress: ${done}/${allIds.length} (${pct}%) — ${scrapedCards.length} cards, ${errors.length} errors`);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  // ── Statistics ──
  console.log(`\n=== Results ===`);
  console.log(`  Cards fetched: ${scrapedCards.length}`);
  console.log(`  Errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log(`  First 5 errors:`);
    errors.slice(0, 5).forEach((e, i) => console.log(`    ${i + 1}. ${JSON.stringify(e)}`));
  }

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
    collected: scrapedCards.length,
    errors: errors.length,
    data: scrapedCards,
  };

  const json = JSON.stringify(output, null, 2);
  fs.writeFileSync(SCRAPED_ALL_OUT, json, 'utf-8');
  console.log(`\n  Saved ${SCRAPED_ALL_OUT} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
