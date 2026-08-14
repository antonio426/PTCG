import {
  MapCard, SetData, Supertype, Subtype, EnergyType,
  Attack, Ability, WeaknessResistance,
  TcgdexCardSummary, TcgdexCardDetail, TcgdexSet,
} from './types';
import * as cache from './cache';

const API_BASE = 'https://api.tcgdex.net/v2';

/** Shape returned by /categories/{name} */
interface CategoryResponse {
  name: string;
  cards: TcgdexCardSummary[];
}

let inMemoryCards: MapCard[] | null = null;
let inMemorySets: SetData[] | null = null;
// Serie (series short code) lookup by set ID, e.g. { "SV1" -> "SV", "S8b" -> "S" }
let serieBySet: Record<string, string> = {};
// Set legality lookup by set ID, populated from set API data
let setLegality: Record<string, { standard: boolean; expanded: boolean }> = {};

function getSerieForSet(setId: string): string {
  return serieBySet[setId] || '';
}

const CATEGORY_MAP: Record<string, Supertype> = {
  Pokemon: 'Pokémon',
  Pokémon: 'Pokémon',
  Trainer: 'Trainer',
  Energy: 'Energy',
};

const ENERGY_MAP: Record<string, EnergyType> = {
  Grass: 'Grass', Fire: 'Fire', Water: 'Water', Lightning: 'Lightning',
  Psychic: 'Psychic', Fighting: 'Fighting', Darkness: 'Darkness',
  Metal: 'Metal', Fairy: 'Fairy', Dragon: 'Dragon', Colorless: 'Colorless',
};

async function apiFetch<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TCGdex API error ${res.status} for ${url}`);
  return res.json() as Promise<T>;
}

function toEnergyType(t: string): EnergyType | undefined {
  return ENERGY_MAP[t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()];
}

// TCGdex trainerType uses short names; our Subtype type uses Pokémon TCG display names.
const TRAINER_TYPE_MAP: Record<string, Subtype> = {
  'Item': 'Item',
  'Supporter': 'Supporter',
  'Stadium': 'Stadium',
  'Tool': 'Pokémon Tool',
  'Tool F': 'Pokémon Tool F',
};

// TCGdex stage values use no-space format; our Subtype type expects spaces
const STAGE_MAP: Record<string, Subtype> = {
  'Basic': 'Basic',
  'Stage1': 'Stage 1',
  'Stage2': 'Stage 2',
};

// TCGdex suffix values use uppercase; our Subtype type may differ
const SUFFIX_MAP: Record<string, Subtype | undefined> = {
  'MEGA': 'Mega',
};

// A Basic Energy card's name unambiguously encodes it (e.g. "基本【草】能量") — used to
// override TCGdex's own energyType/legal.standard fields, which are unreliable for some
// promo/box-exclusive reprints (e.g. SVB/SI/SVC sets).
const BASIC_ENERGY_NAME_RE = /^基本[【\[]([^】\]]+)[】\]]能量$/;

function buildSubtypes(detail: TcgdexCardDetail): Subtype[] {
  const result: Subtype[] = [];
  if (detail.category === 'Pokemon' || detail.category === 'Pokémon') {
    if (detail.stage) result.push(STAGE_MAP[detail.stage] ?? detail.stage as Subtype);
    if (detail.suffix) result.push(SUFFIX_MAP[detail.suffix] ?? detail.suffix as Subtype);
  } else if (detail.category === 'Trainer' && detail.trainerType) {
    result.push(TRAINER_TYPE_MAP[detail.trainerType] ?? detail.trainerType as Subtype);
  } else if (detail.category === 'Energy') {
    // TCGdex energyType: "Normal" = Basic Energy, "Special" = Special Energy.
    const isBasicByName = BASIC_ENERGY_NAME_RE.test(detail.name || '');
    result.push(detail.energyType === 'Normal' || isBasicByName ? 'Basic Energy' : 'Special Energy');
  }
  return result;
}

function buildAttacks(tcgAttacks: TcgdexCardDetail['attacks']): Attack[] {
  if (!tcgAttacks) return [];
  return tcgAttacks.map(a => ({
    name: a.name,
    cost: (a.cost || []).map(c => toEnergyType(c) || 'Colorless'),
    convertedEnergyCost: (a.cost || []).length,
    damage: String(a.damage ?? '').replace('×', 'x'),
    text: a.effect ?? '',
  }));
}

function buildAbilities(tcgAbilities: TcgdexCardDetail['abilities']): Ability[] {
  if (!tcgAbilities) return [];
  return tcgAbilities.map(a => ({
    name: a.name,
    text: a.effect ?? '',
    type: (a.type ?? 'Ability') as Ability['type'],
  }));
}

function buildWeaknesses(tcgWeaknesses: TcgdexCardDetail['weaknesses']): WeaknessResistance[] {
  if (!tcgWeaknesses) return [];
  return tcgWeaknesses.map(w => ({
    type: toEnergyType(w.type) || 'Colorless',
    value: w.value.replace('×', 'x'),
  }));
}

function buildResistances(tcgResistances: TcgdexCardDetail['resistances']): WeaknessResistance[] {
  if (!tcgResistances) return [];
  return tcgResistances.map(r => ({
    type: toEnergyType(r.type) || 'Colorless',
    value: r.value,
  }));
}

function inferSerie(setId: string, serie = ''): string {
  if (serie) return serie;
  const letterPrefix = setId.replace(/[^a-zA-Z].*$/, '');
  return letterPrefix || setId;
}

// Build image URL — uses local API proxy that serves from disk or CDN fallback
function buildImageUrl(lang: string, setId: string, localId: string, serie: string, variant: 'high' | 'low'): string {
  const resolvedSerie = inferSerie(setId, serie);
  return `/api/images/${resolvedSerie}/${setId}/${localId}/${variant === 'low' ? 'low' : 'high'}`;
}

function buildRetreatCost(retreat: number | undefined): { cost: EnergyType[]; converted: number } {
  const r = retreat ?? 0;
  const cost: EnergyType[] = [];
  for (let i = 0; i < r; i++) cost.push('Colorless');
  return { cost, converted: r };
}

// Official Standard-format regulation marks (asia.pokemon-card.com/tw/rules/regulation/):
// 「卡面左下方的『賽制標記』標示為H、I、J者」— cards with no regulation mark are NOT
// standard-legal even when TCGdex's own `legal.standard` flag says so (TCGdex's flag is
// unreliable for old/no-mark reprints, e.g. Mega Evolution tactical-deck exclusives).
// NOTE: the official rules also carve out ~25 specific G-marked reprints (basic energy,
// Energy Retrieval, etc.) as a named exception — that allowlist is NOT "every G card",
// so it is deliberately left OUT of this generic regulation-mark check. Those specific
// cards are instead confirmed via a direct match against the scraped official Standard
// card list (see server/src/scripts/reconcile-official-data.ts), which is ground truth.
const STANDARD_REGULATION_MARKS = new Set(['H', 'I', 'J']);

// Real-rules exception: Basic Energy cards are Standard-legal in any print, regardless of
// regulation mark — TCGdex's own `legal.standard`/`regulationMark` are unreliable for these
// promo/box-exclusive reprints (see BASIC_ENERGY_NAME_RE above).
function isStandardLegal(detail: TcgdexCardDetail): boolean {
  if (detail.category === 'Energy' && BASIC_ENERGY_NAME_RE.test(detail.name || '')) return true;
  if (!detail.legal?.standard) return false;
  return !!detail.regulationMark && STANDARD_REGULATION_MARKS.has(detail.regulationMark);
}

// TCGdex never populates `detail.types` for Energy-supertype cards (that field is a Pokémon
// concept there) — but a Basic Energy card's own name always encodes its element in brackets
// (e.g. "基本【草】能量"), so that's used as a fallback. Without this, every basic energy
// attachment in the game silently defaults to 'Colorless' (see moves.attachEnergy), which
// breaks any attack cost that requires a specific energy type.
const ZH_ENERGY_LABEL: Record<string, EnergyType> = {
  草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning', 超: 'Psychic',
  鬥: 'Fighting', 惡: 'Darkness', 鋼: 'Metal', 妖: 'Fairy', 龍: 'Dragon', 無: 'Colorless',
};

function inferEnergyTypeFromName(name: string): EnergyType | undefined {
  const m = name.match(/[【\[]([^】\]]+)[】\]]/);
  if (!m) return undefined;
  return ZH_ENERGY_LABEL[m[1]];
}

function detailToMapCard(detail: TcgdexCardDetail, lang: string, serie = ''): MapCard {
  const setId = detail.set?.id || '';
  const localId = detail.localId;
  const retreat = buildRetreatCost(detail.retreat);
  let types = detail.types?.map(t => toEnergyType(t)).filter((t): t is EnergyType => t !== undefined);
  const category = CATEGORY_MAP[detail.category || ''] || 'Pokémon';
  if ((!types || types.length === 0) && category === 'Energy') {
    const inferred = inferEnergyTypeFromName(detail.name);
    if (inferred) types = [inferred];
  }
  // Use local API path for images (route proxies to local cache or CDN fallback)
  const images = {
    small: buildImageUrl(lang, setId, localId, serie, 'low'),
    large: buildImageUrl(lang, setId, localId, serie, 'high'),
  };

  return {
    id: detail.id,
    name: detail.name,
    supertype: category,
    subtypes: buildSubtypes(detail),
    hp: detail.hp != null ? String(detail.hp) : undefined,
    types: types && types.length > 0 ? types : undefined,
    evolvesFrom: detail.evolveFrom,
    evolvesTo: detail.evolveTo,
    abilities: buildAbilities(detail.abilities),
    attacks: buildAttacks(detail.attacks),
    weaknesses: buildWeaknesses(detail.weaknesses),
    resistances: buildResistances(detail.resistances),
    retreatCost: retreat.cost.length > 0 ? retreat.cost : undefined,
    convertedRetreatCost: retreat.converted,
    set: {
      id: setId,
      name: detail.set?.name || '',
      series: serie,
      printedTotal: detail.set?.cardCount?.total || 0,
      total: detail.set?.cardCount?.official || 0,
      releaseDate: '',
    },
    number: detail.id.split('-')[1] || localId,
    artist: detail.illustrator,
    rarity: detail.rarity === 'ACE SPEC Rare' ? 'None' : detail.rarity,
    flavorText: detail.description,
    nationalPokedexNumbers: detail.dexId,
    legalities: {
      standard: isStandardLegal(detail) ? 'Legal' : undefined,
      expanded: detail.legal?.expanded ? 'Legal' : undefined,
    },
    regulationMark: detail.regulationMark,
    images,
    localId,
  };
}

function summaryToMapCard(s: TcgdexCardSummary, setId: string, serie: string, lang: string): MapCard {
  const localId = s.localId;
  const images = {
    small: buildImageUrl(lang, setId, localId, serie, 'low'),
    large: buildImageUrl(lang, setId, localId, serie, 'high'),
  };

  // Use set-level legality for summary cards (card-level detail has its own)
  const setLegal = setLegality[setId];
  const legalities: MapCard['legalities'] = {};
  if (setLegal) {
    if (setLegal.standard) legalities.standard = 'Legal';
    if (setLegal.expanded) legalities.expanded = 'Legal';
  }

  return {
    id: s.id,
    name: s.name,
    supertype: 'Pokémon' as Supertype,
    subtypes: ['Basic' as Subtype],
    set: { id: setId, name: '', series: serie, printedTotal: 0, total: 0, releaseDate: '' },
    number: localId,
    legalities,
    images,
    localId,
  };
}

async function fetchWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('fetch failed');
}

export async function fetchAllCards(lang = 'zh-tw'): Promise<MapCard[]> {
  if (inMemoryCards) return inMemoryCards;
  // cards.json is a CURATED dataset, not a disposable cache: one-off scripts under src/scripts/
  // (official-site ability/attack backfills, ACE SPEC patches, sibling-print fixes) write
  // straight into it. The old TTL-checked load meant any server start >24h after the last save
  // silently REPLACED the whole catalog with bare TCGdex category summaries — destroying every
  // curated field and "un-fixing" cards that had already been repaired, repeatedly. So: always
  // trust the file when it exists; refetch only when it's missing or explicitly requested via
  // PTCG_REFRESH_CARDS=1 (after which the curation scripts need re-running).
  const forceRefresh = process.env.PTCG_REFRESH_CARDS === '1';
  const fileCached = forceRefresh ? null : cache.loadCardCache(true);
  if (fileCached) {
    inMemoryCards = fileCached;
    // setLegality must be populated for standardOnly filter to work on cached cards
    await fetchAllSets(lang);
    // Start background enrichment (updates in-memory + saves to cache periodically)
    enrichAllCardsInBackground(lang);
    return fileCached;
  }

  // Ensure set/serie map is loaded
  await fetchAllSets(lang);

  // Fetch 3 category endpoints in parallel.
  // Each includes the same summary fields {id, localId, name, image} but
  // scoped to one category, so we know the supertype for every card.
  const [pokemonCat, trainerCat, energyCat] = await Promise.all([
    apiFetch<CategoryResponse>(`/${lang}/categories/Pokemon`),
    apiFetch<CategoryResponse>(`/${lang}/categories/Trainer`),
    apiFetch<CategoryResponse>(`/${lang}/categories/Energy`),
  ]);

  const categoryToSupertype: Array<[CategoryResponse, Supertype]> = [
    [pokemonCat, 'Pokémon'],
    [trainerCat, 'Trainer'],
    [energyCat, 'Energy'],
  ];

  const cards: MapCard[] = [];
  for (const [cat, supertype] of categoryToSupertype) {
    for (const s of cat.cards) {
      const setId = s.id.split('-')[0] || '';
      const serie = getSerieForSet(setId);
      const card = summaryToMapCard(s, setId, serie, lang);
      card.supertype = supertype;
      cards.push(card);
    }
  }

  const total = pokemonCat.cards.length + trainerCat.cards.length + energyCat.cards.length;
  console.log(`[tcgdex] Loaded ${cards.length}/${total} cards via category endpoints`);

  inMemoryCards = cards;
  await cache.saveCardCache(cards);
  return cards;
}

export async function fetchCardById(id: string, lang = 'zh-tw'): Promise<MapCard | null> {
  const enrichedCheck = (c: MapCard) => c.artist || c._enriched;
  // Check in-memory cache for full detail
  if (inMemoryCards) {
    const found = inMemoryCards.find(c => c.id === id);
    if (found && enrichedCheck(found)) return found;
  }
  // Check file cache
  const fileCached = cache.loadCardCache(true); // curated master — see fetchAllCards
  if (fileCached) {
    const found = fileCached.find(c => c.id === id);
    if (found && enrichedCheck(found)) { inMemoryCards = fileCached; return found; }
  }
  try {
    const detail = await apiFetch<TcgdexCardDetail>(`/${lang}/cards/${id}`);
    const setId = detail.set?.id || id.split('-')[0] || '';
    const serie = getSerieForSet(setId);
    const card = detailToMapCard(detail, lang, serie);
    card._enriched = true;
    if (inMemoryCards) {
      const idx = inMemoryCards.findIndex(c => c.id === id);
      if (idx >= 0) {
        const originalRarity = inMemoryCards[idx].rarity;
        if (originalRarity === 'ACE SPEC Rare' && card.rarity !== 'ACE SPEC Rare') {
          card.rarity = originalRarity;
        }
        inMemoryCards[idx] = card;
      }
      else inMemoryCards.push(card);
    }
    return card;
  } catch { return null; }
}

export async function fetchCardsByIds(ids: string[], lang = 'zh-tw'): Promise<Record<string, MapCard>> {
  const result: Record<string, MapCard> = {};
  const uncached: string[] = [];

  const enrichedCheck = (c: MapCard) => c.artist || c._enriched;
  if (inMemoryCards) {
    for (const id of ids) {
      const found = inMemoryCards.find(c => c.id === id);
      if (found && enrichedCheck(found)) result[id] = found;
      else uncached.push(id);
    }
  } else {
    const fileCached = cache.loadCardCache(true); // curated master — see fetchAllCards
    if (fileCached) {
      for (const id of ids) {
        const found = fileCached.find(c => c.id === id);
        if (found && enrichedCheck(found)) result[id] = found;
        else uncached.push(id);
      }
    } else {
      uncached.push(...ids);
    }
  }

  const batchSize = 5;
  for (let i = 0; i < uncached.length; i += batchSize) {
    const batch = uncached.slice(i, i + batchSize);
    const promises = batch.map(id =>
      fetchWithRetry(() =>
        apiFetch<TcgdexCardDetail>(`/${lang}/cards/${id}`)
          .then(d => {
            const setId = d.set?.id || id.split('-')[0] || '';
            const serie = getSerieForSet(setId);
            return { id, card: detailToMapCard(d, lang, serie) };
          })
          .catch(() => null)
      )
    );
    const resolved = await Promise.all(promises);
    for (const r of resolved) {
      if (r) {
        r.card._enriched = true;
        result[r.id] = r.card;
        if (inMemoryCards) {
          const idx = inMemoryCards.findIndex(c => c.id === r.id);
          if (idx >= 0) {
            const originalRarity = inMemoryCards[idx].rarity;
            if (originalRarity === 'ACE SPEC Rare' && r.card.rarity !== 'ACE SPEC Rare') {
              r.card.rarity = originalRarity;
            }
            inMemoryCards[idx] = r.card;
          }
          else inMemoryCards.push(r.card);
        }
      }
    }
  }

  return result;
}

export async function fetchAllSets(lang = 'zh-tw'): Promise<SetData[]> {
  if (inMemorySets) return inMemorySets;
  const fileCached = process.env.PTCG_REFRESH_CARDS === '1' ? null : cache.loadSetCache(true); // curated-master policy, same as fetchAllCards
  if (fileCached) {
    inMemorySets = fileCached;
    for (const s of fileCached) {
      if (s.legal) { setLegality[s.id] = s.legal; }
    }
    return fileCached;
  }

  const raw = await apiFetch<TcgdexSet[]>(`/${lang}/sets`);
  // Deduplicate by set id AND by set name (TCGdex API returns many duplicate
  // entries — same id repeated, plus different Chinese-exclusive codes that
  // share the same Chinese name). Keep the first occurrence of each name.
  const seenId = new Set<string>();
  const seenName = new Set<string>();
  const sets: SetData[] = [];
  for (const s of raw) {
    if (seenId.has(s.id)) continue;
    seenId.add(s.id);
    if (seenName.has(s.name)) continue;
    seenName.add(s.name);
    const serieId = s.serie?.id || s.series || '';
    if (serieId) { serieBySet[s.id] = serieId; }
    if (s.legal) { setLegality[s.id] = s.legal; }
    sets.push({
      id: s.id,
      name: s.name,
      series: serieId,
      printedTotal: s.cardCount.total,
      total: s.cardCount.official,
      releaseDate: s.releaseDate || '',
      symbol: s.symbol,
      logo: s.logo,
      legal: s.legal,
    });
  }
  inMemorySets = sets;
  await cache.saveSetCache(sets);
  return sets;
}

export async function fetchSetById(id: string, lang = 'zh-tw'): Promise<SetData | null> {
  if (inMemorySets) { const f = inMemorySets.find(s => s.id === id); if (f) return f; }
  const fileCached = process.env.PTCG_REFRESH_CARDS === '1' ? null : cache.loadSetCache(true); // curated-master policy, same as fetchAllCards
  if (fileCached) {
    const f = fileCached.find(s => s.id === id);
    if (f) {
      inMemorySets = fileCached;
      if (f.legal) { setLegality[f.id] = f.legal; }
      return f;
    }
  }
  try {
    const raw = await apiFetch<TcgdexSet>(`/${lang}/sets/${id}`);
    const serieId = raw.serie?.id || raw.series || '';
    if (serieId) { serieBySet[raw.id] = serieId; }
    if (raw.legal) { setLegality[raw.id] = raw.legal; }
    return {
      id: raw.id, name: raw.name, series: serieId,
      printedTotal: raw.cardCount.total, total: raw.cardCount.official,
      releaseDate: raw.releaseDate || '', symbol: raw.symbol, logo: raw.logo,
      legal: raw.legal,
    };
  } catch { return null; }
}

export function fetchCardImage(card: MapCard, variant: 'small' | 'large' = 'large'): string {
  return card.images[variant];
}

export function getCachedCards(): MapCard[] { return inMemoryCards ?? []; }
export function setCachedCards(cards: MapCard[]): void { inMemoryCards = cards; }
export function getCachedSets(): SetData[] { return inMemorySets ?? []; }
export function setCachedSets(sets: SetData[]): void { inMemorySets = sets; }

export function invalidateCache(): void {
  inMemoryCards = null; inMemorySets = null; cache.clearCache();
}

export async function refreshCache(lang = 'zh-tw'): Promise<{ cards: number; sets: number }> {
  invalidateCache();
  const cards = await fetchAllCards(lang);
  const sets = await fetchAllSets(lang);
  return { cards: cards.length, sets: sets.length };
}

// ——— Enrichment: batch-fetch detail for every summary-only card ———

let enrichmentStats = { total: 0, done: 0, failed: 0 };

export function getEnrichmentStats() { return enrichmentStats; }

const ENRICH_BATCH_SIZE = 5;

/**
 * Enrich all cards in the in-memory cache by fetching individual detail
 * endpoints. Runs until every card has proper data (artist present).
 * Saves progress to file cache periodically.
 */
export async function enrichAllCards(lang = 'zh-tw'): Promise<void> {
  const cards = inMemoryCards;
  if (!cards || cards.length === 0) return;

  // ——— Migration: update image URLs from CDN to local API ———
  let migrated = 0;
  for (const c of cards) {
    if (c.images?.small?.startsWith('https://assets.tcgdex.net')) {
      const setId = c.set.id;
      const localId = c.localId || c.number || '';
      const serie = c.set.series || inferSerie(setId);
      c.images.small = `/api/images/${serie}/${setId}/${localId}/low`;
      c.images.large = `/api/images/${serie}/${setId}/${localId}/high`;
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[enrich] Migrated ${migrated} cards to local image URLs`);
    await cache.saveCardCache(cards);
  }

  // Stale subtype values from prior mapping versions that need re-fetch
  const STALE_SUBTYPES = new Set<string>(['Tool', 'Tool F', 'Stage1', 'Stage2']);
  const needsEnrich = (c: MapCard) => 
    !c.artist || c.subtypes.length === 0
    || c.subtypes.some(s => STALE_SUBTYPES.has(s))
    || (c.subtypes.length === 1 && c.subtypes[0] === 'Basic' && c.supertype !== 'Pokémon');

  const toEnrich = cards.filter(needsEnrich);
  // Mark already-enriched cards to skip re-check next time
  for (const c of cards) {
    if (c.artist && !STALE_SUBTYPES.has((c.subtypes as string[])[0])) c._enriched = true;
  }
  enrichmentStats = { total: toEnrich.length, done: 0, failed: 0 };

  if (toEnrich.length === 0) {
    console.log('[enrich] All cards already enriched');
    return;
  }

  console.log(`[enrich] Starting enrichment of ${toEnrich.length} cards (batch: ${ENRICH_BATCH_SIZE})`);

  for (let i = 0; i < toEnrich.length; i += ENRICH_BATCH_SIZE) {
    const batch = toEnrich.slice(i, i + ENRICH_BATCH_SIZE);
    const promises = batch.map(card =>
      apiFetch<TcgdexCardDetail>(`/${lang}/cards/${card.id}`)
        .then(detail => ({ id: detail.id, detail }))
        .catch(() => null)
    );
    const results = await Promise.all(promises);

    for (const r of results) {
      if (!r) { enrichmentStats.failed++; continue; }
      const idx = cards.findIndex(c => c.id === r.id);
      if (idx >= 0) {
        const setId = r.detail.set?.id || r.id.split('-')[0] || '';
        const serie = getSerieForSet(setId);
        const originalRarity = cards[idx].rarity;
        const enriched = detailToMapCard(r.detail, lang, serie);
        enriched._enriched = true;
        // Preserve ACE SPEC rarity — TCGdex API doesn't always return it
        if (originalRarity === 'ACE SPEC Rare' && enriched.rarity !== 'ACE SPEC Rare') {
          enriched.rarity = originalRarity;
        }
        cards[idx] = enriched;
      }
      enrichmentStats.done++;
    }

    // Save to file cache every 100 cards
    if (enrichmentStats.done % 100 === 0) {
      await cache.saveCardCache(cards);
      console.log(`[enrich] ${enrichmentStats.done}/${enrichmentStats.total} done (${enrichmentStats.failed} failed)`);
    }
  }

  // Final save
  await cache.saveCardCache(cards);
  console.log(`[enrich] Completed: ${enrichmentStats.done} enriched, ${enrichmentStats.failed} failed`);
}

// Start enrichment in background after initial load; returns immediately
export function enrichAllCardsInBackground(lang = 'zh-tw'): void {
  enrichAllCards(lang).catch(e => console.error('[enrich] Background enrichment error:', e));
}
