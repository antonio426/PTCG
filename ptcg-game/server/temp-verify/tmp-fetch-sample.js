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
const cheerio = __importStar(require("cheerio"));
async function main() {
    // Test with a Pokémon card (蘭螳花ex ID 19148)
    const res = await fetch('https://asia.pokemon-card.com/tw/card-search/detail/19148/');
    const html = await res.text();
    const $ = cheerio.load(html);
    console.log('=== FULL HTML KEY SECTIONS ===');
    // Card name
    console.log('\n--- Title ---');
    console.log($('title').text().trim());
    // Common header (name)
    console.log('\n--- commonHeader ---');
    console.log($('.commonHeader').text().trim());
    // HP
    console.log('\n--- hitPoint ---');
    console.log($('.hitPoint').text().trim());
    // Energy type icons
    console.log('\n--- Energy Images ---');
    $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('energy') || src.includes('Energy')) {
            console.log(`  [${i}]`, src, 'alt:', $(el).attr('alt'));
        }
    });
    // All skill blocks
    console.log('\n--- Skill Blocks ---');
    $('.skillBlock, .skillBlock01, .skillBlock02, [class*="skill"]').each((i, el) => {
        const cls = $(el).attr('class') || '';
        if (cls.includes('skill')) {
            console.log(`\n[${i}] class=${cls}`);
            console.log($(el).text().trim().slice(0, 500));
        }
    });
    // Sub information (weakness, resistance, retreat)
    console.log('\n--- subInformation ---');
    console.log($('.subInformation').text().trim().slice(0, 300));
    // Evolve marker
    console.log('\n--- evolveMarker ---');
    console.log($('.evolveMarker').text().trim());
    // Card number / regulation mark
    console.log('\n--- Card Info area ---');
    // Try various selectors
    $('.cardInfo, .infoTxt, .detailTxt, .dataBlock, .cardNumber, .regulationMark, .regulation').each((i, el) => {
        console.log(`[${i}] class=${$(el).attr('class')}`, $(el).text().trim().slice(0, 200));
    });
    // Look for regulation mark in text
    console.log('\n--- Text containing レギュ or 標準 or 規制 ---');
    $('*').each((i, el) => {
        const text = $(el).text().trim();
        if (text.match(/[レ規制]|Regulation|regulation/)) {
            const tag = el.tagName;
            const cls = $(el).attr('class') || '';
            if (tag !== 'html' && tag !== 'body' && tag !== 'head') {
                console.log(`<${tag} class="${cls}">`, text.slice(0, 200));
            }
        }
    });
    // Image URL
    console.log('\n--- Main Card Image ---');
    $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('card-img') || src.includes('cardimg')) {
            console.log(`[${i}]`, src);
        }
    });
    // Expansion/set info
    console.log('\n--- Expansion Links ---');
    $('a[href*="expansion"]').each((i, el) => {
        console.log(`[${i}]`, $(el).attr('href'), $(el).text().trim());
    });
    // Any image with expansion in name
    console.log('\n--- Expansion Images ---');
    $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('expansion') || src.includes('Expansion') || src.includes('exp_')) {
            console.log(`[${i}]`, src, 'alt:', $(el).attr('alt'));
        }
    });
}
main().catch(console.error);
