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

function buildSubtypes(detail: TcgdexCardDetail): Subtype[] {
  const result: Subtype[] = [];
  if (detail.category === 'Pokemon' || detail.category === 'Pokémon') {
    if (detail.stage) result.push(detail.stage as Subtype);
    if (detail.suffix) result.push(detail.suffix as Subtype);
  } else if (detail.category === 'Trainer' && detail.trainerType) {
    result.push(detail.trainerType as Subtype);
  } else if (detail.category === 'Energy') {
    result.push(detail.energyType === 'Basic' ? 'Basic Energy' : 'Special Energy');
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

// Build CDN image URL: https://assets.tcgdex.net/{lang}/{serie}/{setId}/{localId}/{variant}.png
function buildImageUrl(lang: string, setId: string, localId: string, serie: string, variant: 'high' | 'low'): string {
  const resolvedSerie = inferSerie(setId, serie);
  return `https://assets.tcgdex.net/${lang}/${resolvedSerie}/${setId}/${localId}/${variant}.png`;
}

function buildRetreatCost(retreat: number | undefined): { cost: EnergyType[]; converted: number } {
  const r = retreat ?? 0;
  const cost: EnergyType[] = [];
  for (let i = 0; i < r; i++) cost.push('Colorless');
  return { cost, converted: r };
}

function detailToMapCard(detail: TcgdexCardDetail, lang: string, serie = ''): MapCard {
  const setId = detail.set?.id || '';
  const localId = detail.localId;
  const retreat = buildRetreatCost(detail.retreat);
  const types = detail.types?.map(t => toEnergyType(t)).filter((t): t is EnergyType => t !== undefined);
  const category = CATEGORY_MAP[detail.category || ''] || 'Pokémon';
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
    rarity: detail.rarity,
    flavorText: detail.description,
    nationalPokedexNumbers: detail.dexId,
    legalities: {
      standard: detail.legal?.standard ? 'Legal' : undefined,
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

  return {
    id: s.id,
    name: s.name,
    supertype: 'Pokémon' as Supertype,
    subtypes: ['Basic' as Subtype],
    set: { id: setId, name: '', series: serie, printedTotal: 0, total: 0, releaseDate: '' },
    number: localId,
    legalities: {},
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
  const fileCached = cache.loadCardCache();
  if (fileCached) { inMemoryCards = fileCached; return fileCached; }

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
  cache.saveCardCache(cards);
  return cards;
}

export async function fetchCardById(id: string, lang = 'zh-tw'): Promise<MapCard | null> {
  // Check in-memory cache for full detail (artist = present only on detail-fetched cards)
  if (inMemoryCards) {
    const found = inMemoryCards.find(c => c.id === id);
    if (found && found.artist) return found;
  }
  // Check file cache
  const fileCached = cache.loadCardCache();
  if (fileCached) {
    const found = fileCached.find(c => c.id === id);
    if (found && found.artist) { inMemoryCards = fileCached; return found; }
  }
  try {
    const detail = await apiFetch<TcgdexCardDetail>(`/${lang}/cards/${id}`);
    const setId = detail.set?.id || id.split('-')[0] || '';
    const serie = getSerieForSet(setId);
    const card = detailToMapCard(detail, lang, serie);
    if (inMemoryCards) {
      const idx = inMemoryCards.findIndex(c => c.id === id);
      if (idx >= 0) inMemoryCards[idx] = card;
      else inMemoryCards.push(card);
    }
    return card;
  } catch { return null; }
}

export async function fetchCardsByIds(ids: string[], lang = 'zh-tw'): Promise<Record<string, MapCard>> {
  const result: Record<string, MapCard> = {};
  const uncached: string[] = [];

  if (inMemoryCards) {
    for (const id of ids) {
      const found = inMemoryCards.find(c => c.id === id);
      if (found && found.artist) result[id] = found;
      else uncached.push(id);
    }
  } else {
    const fileCached = cache.loadCardCache();
    if (fileCached) {
      for (const id of ids) {
        const found = fileCached.find(c => c.id === id);
        if (found && found.artist) result[id] = found;
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
        result[r.id] = r.card;
        if (inMemoryCards) {
          const idx = inMemoryCards.findIndex(c => c.id === r.id);
          if (idx >= 0) inMemoryCards[idx] = r.card;
          else inMemoryCards.push(r.card);
        }
      }
    }
  }

  return result;
}

export async function fetchAllSets(lang = 'zh-tw'): Promise<SetData[]> {
  if (inMemorySets) return inMemorySets;
  const fileCached = cache.loadSetCache();
  if (fileCached) { inMemorySets = fileCached; return fileCached; }

  const raw = await apiFetch<TcgdexSet[]>(`/${lang}/sets`);
  const sets = raw.map(s => {
    const serieId = s.serie?.id || s.series || '';
    // Build serie lookup map
    if (serieId) { serieBySet[s.id] = serieId; }
    return {
      id: s.id,
      name: s.name,
      series: serieId,
      printedTotal: s.cardCount.total,
      total: s.cardCount.official,
      releaseDate: s.releaseDate || '',
      symbol: s.symbol,
      logo: s.logo,
    };
  });
  inMemorySets = sets;
  cache.saveSetCache(sets);
  return sets;
}

export async function fetchSetById(id: string, lang = 'zh-tw'): Promise<SetData | null> {
  if (inMemorySets) { const f = inMemorySets.find(s => s.id === id); if (f) return f; }
  const fileCached = cache.loadSetCache();
  if (fileCached) { const f = fileCached.find(s => s.id === id); if (f) { inMemorySets = fileCached; return f; } }
  try {
    const raw = await apiFetch<TcgdexSet>(`/${lang}/sets/${id}`);
    const serieId = raw.serie?.id || raw.series || '';
    if (serieId) { serieBySet[raw.id] = serieId; }
    return {
      id: raw.id, name: raw.name, series: serieId,
      printedTotal: raw.cardCount.total, total: raw.cardCount.official,
      releaseDate: raw.releaseDate || '', symbol: raw.symbol, logo: raw.logo,
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
