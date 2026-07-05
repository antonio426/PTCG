"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cheerio = __importStar(require("cheerio"));
// ── Paths ──
const OFFICIAL_DATA = path.resolve(__dirname, '../../../data-scraped/official-standard-cards.json');
const CARDS_CACHE = path.resolve(__dirname, '../../data/cards.json');
const SCRAPED_OUT = path.resolve(__dirname, '../../data/scraped-cards.json');
const IMAGE_DIR = path.resolve(__dirname, '../../data/images/scraped');
const DETAIL_BASE = 'https://asia.pokemon-card.com/tw/card-search/detail';
const IMG_BASE = 'https://asia.pokemon-card.com/tw/card-img';
// Map energy img filenames to EnergyType
const ENERGY_MAP = {
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
const EXPANSION_SET_MAP = {
    'SV8a': { name: 'SV8a', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
    'SV10': { name: 'SV10 火箭隊', series: 'SV', printedTotal: 98, total: 98, releaseDate: '' },
    'SV9': { name: 'SV9 對戰夥伴', series: 'SV', printedTotal: 100, total: 100, releaseDate: '' },
    'M5': { name: 'M5 新緑の深淵', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
    'SVQL': { name: 'SVQL 傳說時空', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
    'SVQP': { name: 'SVQP デッキビルドセット', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
};
/** Extract energy type from img src */
function parseEnergy(html) {
    const m = html.match(/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png/);
    if (m && m[1] in ENERGY_MAP)
        return ENERGY_MAP[m[1]];
    return null;
}
/** Parse a card detail page HTML into partial MapCard fields */
function parseCardHtml(id, html, baseOfficial) {
    const $ = cheerio.load(html);
    const card = {
        id: `scr-${id}`,
        name: baseOfficial.name,
        legalities: { standard: 'Legal' },
        regulationMark: baseOfficial.regulation,
        number: baseOfficial.cardNumber,
        images: {
            small: `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`,
            large: `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`,
        },
    };
    // ── Set info ──
    // Try extraction from detail page links/images
    let expCode = baseOfficial.expansionCode;
    if (!expCode) {
        // Try link: /tw/card-search/list/?expansionCodes=M5
        const expLinkMatch = html.match(/expansionCodes=([A-Za-z0-9]+)/);
        if (expLinkMatch)
            expCode = expLinkMatch[1];
        // Try img: twhk_exp_M5.png
        const expImgMatch = html.match(/twhk_exp_([A-Za-z0-9]+)\.png/);
        if (!expCode && expImgMatch)
            expCode = expImgMatch[1];
    }
    if (expCode && EXPANSION_SET_MAP[expCode]) {
        card.set = EXPANSION_SET_MAP[expCode];
    }
    if (!card.set) {
        card.set = {
            id: expCode || 'unknown',
            name: expCode || 'Unknown',
            series: 'SV',
            printedTotal: 0,
            total: 0,
            releaseDate: '',
        };
    }
    card.set.id = card.set.id || expCode || 'unknown';
    // ── Supertype / Subtype ──
    const pageText = $.text();
    if (/支援者卡/.test(pageText)) {
        card.supertype = 'Trainer';
        card.subtypes = ['Supporter'];
    }
    else if (/道具/.test(pageText)) {
        card.supertype = 'Trainer';
        card.subtypes = ['Item'];
    }
    else if (/競技場卡/.test(pageText)) {
        card.supertype = 'Trainer';
        card.subtypes = ['Stadium'];
    }
    else if (/基本能量/.test(pageText) || pageText.includes('基本')) {
        card.supertype = 'Energy';
        card.subtypes = ['Basic Energy'];
    }
    else {
        card.supertype = 'Pokémon';
        card.subtypes = [];
    }
    // Check header for subtype
    const headerMatch = html.match(/<h3 class="commonHeader">\s*([^<]+?)\s*<\/h3>/);
    if (headerMatch) {
        const h = headerMatch[1];
        if (/寶可夢卡/.test(h)) {
            card.supertype = 'Pokémon';
            card.subtypes = [];
            // Check evolution
            const evoText = $('.cardDetailPage').text().trim();
            if (/VMax/.test(evoText) || /VMAX/.test(evoText))
                card.subtypes.push('VMAX');
            else if (/VSTAR/.test(evoText))
                card.subtypes.push('VSTAR');
            else if (/ex[^p]/.test(evoText) && /ex/.test(evoText))
                card.subtypes.push('ex');
        }
        else if (/支援者卡/.test(h)) {
            card.supertype = 'Trainer';
            card.subtypes = ['Supporter'];
        }
        else if (/道具/.test(h)) {
            card.supertype = 'Trainer';
            card.subtypes = ['Item'];
        }
        else if (/競技場卡/.test(h)) {
            card.supertype = 'Trainer';
            card.subtypes = ['Stadium'];
        }
        else if (/能量/.test(h)) {
            card.supertype = 'Energy';
        }
    }
    // ── Evolution check ──
    const evoMatch = html.match(/([0-9序列]階進化|基本)/);
    if (evoMatch) {
        const evo = evoMatch[1];
        if (evo === '基本')
            card.subtypes?.push('Basic');
        else if (evo.includes('2'))
            card.subtypes?.push('Stage 2');
        else if (evo.includes('1'))
            card.subtypes?.push('Stage 1');
    }
    // ── HP ──
    const hpMatch = html.match(/HP\s*(\d+)\s*\/\s*[屬]/);
    if (hpMatch)
        card.hp = hpMatch[1];
    const hpMatch2 = html.match(/<span class="hitPoint">(\d+)<\/span>/);
    if (!card.hp && hpMatch2)
        card.hp = hpMatch2[1];
    // ── Types (energy icon near "屬性") ──
    const typeMatch = html.match(/<img[^>]*src="[^"]*?energy\/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png"[^>]*>/);
    if (typeMatch) {
        card.types = [ENERGY_MAP[typeMatch[1] + '.png']];
    }
    // ── Attacks ──
    const attacks = [];
    $('.skillBlock').each((_i, el) => {
        const $el = $(el);
        const name = $el.find('.skillName').text().trim();
        const damage = $el.find('.skillDamage').text().trim();
        const effect = $el.find('.skillEffect').text().trim();
        if (!name)
            return;
        // Cost energy icons
        const cost = [];
        $el.find('img').each((_, img) => {
            const src = $(img).attr('src') || '';
            const e = parseEnergy(src);
            if (e)
                cost.push(e);
        });
        attacks.push({
            name,
            cost,
            convertedEnergyCost: cost.length,
            damage: damage || '',
            text: effect || '',
        });
    });
    if (attacks.length > 0)
        card.attacks = attacks;
    // ── Abilities ──
    // Look for ability text blocks before skills
    const abilities = [];
    $('.abilityBlock').each((_i, el) => {
        const $el = $(el);
        const name = $el.find('.abilityName').text().trim();
        const text = $el.find('.abilityEffect').text().trim();
        if (name) {
            abilities.push({ name, text, type: 'Ability' });
        }
    });
    if (abilities.length > 0)
        card.abilities = abilities;
    // ── Weakness / Resistance / Retreat ──
    const tableHtml = html.match(/<table[^>]*class="[^"]*subInformation[^"]*"[^>]*>[\s\S]*?<\/table>/);
    if (tableHtml) {
        const $t = cheerio.load(tableHtml[0]);
        const cells = $t('td').toArray();
        for (let i = 0; i < cells.length; i++) {
            const cellHtml = $(cells[i]).html() || '';
            if (cellHtml.includes('×2')) {
                const e = parseEnergy(cellHtml);
                if (e) {
                    if (!card.weaknesses)
                        card.weaknesses = [];
                    card.weaknesses.push({ type: e, value: '×2' });
                }
            }
            else if (cellHtml.includes('--') || cellHtml.includes('－')) {
                const e = parseEnergy(cellHtml);
                if (e) {
                    if (!card.resistances)
                        card.resistances = [];
                    card.resistances.push({ type: e, value: '-30' });
                }
            }
            else {
                // Retreat — energy icons
                const retreatEnergies = [];
                const energyImgRegex = /energy\/(Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy|Dragon|Colorless)\.png/g;
                let m;
                while ((m = energyImgRegex.exec(cellHtml)) !== null) {
                    retreatEnergies.push(m[1]);
                }
                if (retreatEnergies.length > 0) {
                    card.retreatCost = retreatEnergies.map(e => ENERGY_MAP[e + '.png']);
                    card.convertedRetreatCost = retreatEnergies.length;
                }
            }
        }
    }
    // ── Artist ──
    const artistMatch = html.match(/繪[^：:]*[：:]\s*([^<\n]+)/);
    if (artistMatch)
        card.artist = artistMatch[1].trim();
    const artistMatch2 = html.match(/イラストレーター[：:]\s*([^<\n]+)/);
    if (!card.artist && artistMatch2)
        card.artist = artistMatch2[1].trim();
    return card;
}
/** Download image from URL to local file */
async function downloadImage(url, filePath) {
    try {
        const res = await fetch(url);
        if (!res.ok)
            return false;
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return true;
    }
    catch {
        return false;
    }
}
async function main() {
    // ── Step 1: Read official data ──
    console.log('=== Step 1: Reading official standard cards ===');
    const rawOfficial = JSON.parse(fs.readFileSync(OFFICIAL_DATA, 'utf-8'));
    const officialCards = rawOfficial.cards;
    const officialNamesSet = new Set(officialCards.map(c => c.name));
    console.log(`  Official standard cards: ${officialCards.length}`);
    console.log(`  Unique official names: ${officialNamesSet.size}`);
    // ── Step 2: Read TCGdex cards.json ──
    console.log('\n=== Step 2: Reading TCGdex cards.json ===');
    const cacheRaw = JSON.parse(fs.readFileSync(CARDS_CACHE, 'utf-8'));
    const existingCards = cacheRaw.data;
    const existingNames = new Set(existingCards.map(c => c.name));
    console.log(`  TCGdex cards: ${existingCards.length}`);
    console.log(`  Unique TCGdex names: ${existingNames.size}`);
    // ── Step 3: Find official cards NOT in TCGdex ──
    console.log('\n=== Step 3: Identifying missing cards ===');
    const missingIds = [];
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
    const officialById = new Map();
    for (const card of officialCards) {
        officialById.set(card.id, card);
    }
    // ── Step 5: Fetch detail pages ──
    console.log('\n=== Step 4: Fetching detail pages ===');
    const scrapedCards = [];
    const errors = [];
    const CONCURRENCY = 5;
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    for (let i = 0; i < uniqueMissingIds.length; i += CONCURRENCY) {
        const batch = uniqueMissingIds.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (id) => {
            const base = officialById.get(id);
            const res = await fetch(`${DETAIL_BASE}/${id}/`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const html = await res.text();
            const partial = parseCardHtml(id, html, base);
            // Fill in missing fields with defaults
            const card = {
                id: partial.id || `scr-${id}`,
                name: partial.name || base.name,
                supertype: partial.supertype || 'Pokémon',
                subtypes: partial.subtypes || [],
                set: partial.set || { id: 'unknown', name: 'Unknown', series: 'SV', printedTotal: 0, total: 0, releaseDate: '' },
                number: partial.number || base.cardNumber,
                legalities: { standard: 'Legal' },
                images: partial.images || { small: '', large: '' },
            };
            if (partial.hp)
                card.hp = partial.hp;
            if (partial.types)
                card.types = partial.types;
            if (partial.attacks)
                card.attacks = partial.attacks;
            if (partial.abilities)
                card.abilities = partial.abilities;
            if (partial.weaknesses)
                card.weaknesses = partial.weaknesses;
            if (partial.resistances)
                card.resistances = partial.resistances;
            if (partial.retreatCost) {
                card.retreatCost = partial.retreatCost;
                card.convertedRetreatCost = partial.retreatCost.length;
            }
            if (partial.artist)
                card.artist = partial.artist;
            if (partial.regulationMark)
                card.regulationMark = partial.regulationMark;
            // Download image
            const imgUrl = `${IMG_BASE}/tw${String(id).padStart(8, '0')}.png`;
            const imgPath = path.join(IMAGE_DIR, `tw${String(id).padStart(8, '0')}.png`);
            const downloaded = await downloadImage(imgUrl, imgPath);
            if (!downloaded) {
                console.warn(`  [WARN] Image download failed for card ${id} (${base.name})`);
            }
            return card;
        }));
        for (const result of results) {
            if (result.status === 'fulfilled') {
                scrapedCards.push(result.value);
            }
            else {
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
    const supertypes = {};
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
    }
    else {
        console.log(`\n  ⚠️  Still missing: ${officialCards.length - standardCount} cards`);
    }
}
main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
