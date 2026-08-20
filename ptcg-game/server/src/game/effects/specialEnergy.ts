import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { shuffleDeck } from './types';

/**
 * What a piece of attached Energy actually pays for.
 *
 * A basic Energy is one unit of its own type, which is what `AttachedEnergy.type` has always
 * modelled. Special Energy doesn't fit that: 火箭隊能量 provides TWO units that each count as
 * either 【超】 or 【惡】, 古舊能量 provides one unit of every type at once, and 稜鏡能量 /
 * 新衝天能量 / 燃火能量 change what they provide depending on the Pokémon holding them. Reading a
 * single `type` string meant every one of those was silently just one Colorless.
 *
 * Driven off the card's printed text rather than a per-card registry, so a new Special Energy
 * printed in the same wording works without a code change. The texts themselves were missing from
 * both data sources until backfill-special-energy-text.ts pulled them off the official page.
 */

export const ALL_ENERGY_TYPES = [
  'Grass', 'Fire', 'Water', 'Lightning', 'Psychic',
  'Fighting', 'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless',
] as const;

const ZH_TO_TYPE: Record<string, string> = {
  無: 'Colorless', 草: 'Grass', 火: 'Fire', 水: 'Water', 雷: 'Lightning',
  超: 'Psychic', 鬥: 'Fighting', 惡: 'Darkness', 鋼: 'Metal', 妖: 'Fairy', 龍: 'Dragon',
};

/** One energy's worth of payment, and which cost symbols it can be spent on. */
export interface EnergyUnit {
  /** Types this unit satisfies. A unit covering every type is a wildcard (古舊能量, 稜鏡能量 …). */
  types: string[];
}

const wildcard = (): EnergyUnit => ({ types: [...ALL_ENERGY_TYPES] });

/** 「視為提供N個…」 clauses, in the two shapes the current pool prints. */
function parseProvision(clause: string): EnergyUnit[] | null {
  // 「視為提供1個所有屬性的能量」 / 「視為提供2個所有屬性的能量」
  let m = clause.match(/視為提供(\d+)個所有屬性的能量/);
  if (m) return Array.from({ length: parseInt(m[1], 10) }, wildcard);

  // 「視為提供2個【超】【惡】2種屬性的能量」 — N units, each payable as any of the listed types.
  m = clause.match(/視為提供(\d+)個((?:【.】)+)\d+種屬性的能量/);
  if (m) {
    const types = [...m[2].matchAll(/【(.)】/g)].map(x => ZH_TO_TYPE[x[1]]).filter(Boolean);
    if (types.length) return Array.from({ length: parseInt(m[1], 10) }, () => ({ types }));
  }

  // 「視為提供1個【無】能量」 / 「視為提供3個【無】能量」
  m = clause.match(/視為提供(\d+)個【(.)】能量/);
  if (m) {
    const type = ZH_TO_TYPE[m[2]];
    if (type) return Array.from({ length: parseInt(m[1], 10) }, () => ({ types: [type] }));
  }
  return null;
}

/** Whether the 「若附於X寶可夢身上」 condition in a clause holds for the Pokémon carrying the card. */
function conditionHolds(clause: string, holder: GameCard): boolean {
  const subs = holder.cardData.subtypes ?? [];
  if (/若附於【2階進化】寶可夢身上/.test(clause)) return subs.includes('Stage 2');
  if (/若附於【基礎】寶可夢身上/.test(clause)) return subs.includes('Basic');
  if (/若附於進化寶可夢身上/.test(clause)) return subs.includes('Stage 1') || subs.includes('Stage 2');
  return false;
}

/**
 * The units `energy` pays for while attached to `holder`.
 *
 * Falls back to the flat `AttachedEnergy.type` whenever the card has no parseable provision text,
 * which covers every basic Energy and any Special Energy whose text hasn't been backfilled — the
 * previous behaviour, so nothing regresses when the data is incomplete.
 */
export function energyUnitsProvided(
  energy: { type: string; cardData?: GameCard['cardData'] },
  holder: GameCard,
): EnergyUnit[] {
  const rules = energy.cardData?.rules ?? [];
  if (energy.cardData?.subtypes?.includes('Special Energy') && rules.length) {
    const text = rules.join('');
    // A conditional clause REPLACES the base one when it applies ("若附於…則視為提供…"), so check
    // it first and only fall back to the unconditional reading.
    for (const clause of text.split('。')) {
      if (!/若附於/.test(clause)) continue;
      if (!conditionHolds(clause, holder)) continue;
      const units = parseProvision(clause);
      if (units) return units;
    }
    for (const clause of text.split('。')) {
      if (/若附於/.test(clause)) continue;
      const units = parseProvision(clause);
      if (units) return units;
    }
  }
  return [{ types: [energy.type] }];
}

/** Every unit on a Pokémon, flattened — what an attack cost is actually paid from. */
export function energyUnitsOn(holder: GameCard): EnergyUnit[] {
  return holder.attachedEnergy.flatMap(e => energyUnitsProvided(e, holder));
}

/** Does `holder` carry a Special Energy printed with this exact name? */
export function hasSpecialEnergy(holder: GameCard, name: string): boolean {
  return holder.attachedEnergy.some(e =>
    e.cardData?.subtypes?.includes('Special Energy')
    && String(e.cardData.name).replace(/^[‌​\s]+/, '').trim() === name);
}

const holderTypes = (holder: GameCard) => holder.cardData.types ?? [];

/** 增強【草】能量: 「附有這張卡的【草】寶可夢的最大HP「+20」」 */
export function specialEnergyMaxHpBonus(holder: GameCard): number {
  return hasSpecialEnergy(holder, '增強【草】能量') && holderTypes(holder).includes('Grass') ? 20 : 0;
}

/** 磁鐵【鋼】能量: 「附有這張卡的【鋼】寶可夢【撤退】所需的能量全部消除」 */
export function specialEnergyWaivesRetreat(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '磁鐵【鋼】能量') && holderTypes(holder).includes('Metal');
}

/** 伏特【雷】能量: 「附有這張卡的【雷】寶可夢使用的招式…傷害「+20」點」 */
export function specialEnergyDamageBonus(attacker: GameCard): number {
  return hasSpecialEnergy(attacker, '伏特【雷】能量') && holderTypes(attacker).includes('Lightning') ? 20 : 0;
}

/** 暗影【惡】能量: 「只要附有這張卡的【惡】寶可夢在備戰區，不會受到對手的招式的傷害」 */
export function specialEnergyBlocksBenchedDamage(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '暗影【惡】能量') && holderTypes(holder).includes('Darkness');
}

/** 泡沫【水】能量: 「附有這張卡的【水】寶可夢不會陷入特殊狀態，並將受到的特殊狀態全部恢復」 */
export function specialEnergyBlocksStatus(holder: GameCard): boolean {
  return hasSpecialEnergy(holder, '泡沫【水】能量') && holderTypes(holder).includes('Water');
}

/**
 * 扣殺能量: 「附有這張卡的寶可夢在戰鬥場受到對手的寶可夢招式的傷害時，在使用招式的寶可夢身上放置
 * 2個傷害指示物」 — damage counters, so 20 damage, dealt back to the attacker.
 */
export function specialEnergyRetaliation(defender: GameCard): number {
  return hasSpecialEnergy(defender, '扣殺能量') ? 20 : 0;
}

/**
 * 薄霧能量 / 硬岩【鬥】能量: 「不會受到對手的寶可夢使用招式的效果的影響」. 硬岩 additionally
 * requires the holder to be a 【鬥】 Pokémon; 薄霧 applies to whatever carries it.
 */
export function specialEnergyBlocksAttackEffects(holder: GameCard): boolean {
  if (hasSpecialEnergy(holder, '薄霧能量')) return true;
  return hasSpecialEnergy(holder, '硬岩【鬥】能量') && holderTypes(holder).includes('Fighting');
}

/**
 * 古舊能量: 「受到對手的寶可夢招式的傷害而【昏厥】時，被獲得的獎賞卡減少1張。對戰中，自己的
 * 「古舊能量」的這個效果只生效1次。」 — the once-per-GAME limit is tracked on the player, not the
 * card, since the text scopes it to 自己的「古舊能量」 as a whole rather than to one copy.
 */
export function specialEnergyPrizeReduction(koCard: GameCard): number {
  return hasSpecialEnergy(koCard, '古舊能量') ? 1 : 0;
}

/**
 * 燃火能量: 「將附於寶可夢身上的這張卡，在自己的回合結束時丟棄」 — discards itself off every
 * Pokémon that player controls at the end of their own turn. The card goes to the discard pile
 * rather than vanishing, same as any other energy leaving a Pokémon.
 */
export function discardBurnoutEnergy(G: PtcgGameState, playerIdx: 0 | 1): void {
  const p = G.players[playerIdx];
  for (const card of [p.active, ...p.bench]) {
    if (!card) continue;
    for (let i = card.attachedEnergy.length - 1; i >= 0; i--) {
      const e = card.attachedEnergy[i];
      if (!hasSpecialEnergyName(e, '燃火能量')) continue;
      card.attachedEnergy.splice(i, 1);
      if (e.cardData) {
        p.discardPile.push({
          id: e.id, cardData: e.cardData, owner: playerIdx,
          damage: 0, statusConditions: [], attachedEnergy: [],
        });
      }
    }
  }
}

/** Named-card check on a raw attachment (no holding Pokémon needed). */
function hasSpecialEnergyName(energy: { cardData?: GameCard['cardData'] }, name: string): boolean {
  return !!energy.cardData?.subtypes?.includes('Special Energy')
    && String(energy.cardData.name).replace(/^[‌​\s]+/, '').trim() === name;
}

/**
 * 回力鏢能量: 「若因附有這張卡的寶可夢使用的招式的效果使這張卡被丟棄，則在招式的傷害與效果的影響
 * 之後，重新附於原本的寶可夢身上。」
 * 燃料【火】能量: same trigger on a 【火】 holder, but 「這張卡放回手牌」 instead.
 *
 * Called by moves.attack before the attack resolves: records which of the two cards the attacker
 * carries going in. Between this and processAttackEnergyReturns, the only thing that can move a
 * recorded card into the discard pile — besides the attack's own effect — is the holder being
 * Knocked Out (whole stack discarded), which the process step excludes by requiring the holder to
 * still be in play, or an opposing 甲殼刺-style ability, which attackResolution excludes by
 * dropping the id from this record when it fires.
 */
export function watchAttackEnergyReturns(G: PtcgGameState, attackerOwner: 0 | 1, attacker: GameCard): void {
  const entries: NonNullable<PtcgGameState['attackEnergyReturns']> = [];
  for (const e of attacker.attachedEnergy) {
    if (hasSpecialEnergyName(e, '回力鏢能量')) {
      entries.push({ owner: attackerOwner, holderId: attacker.id, energyId: e.id, kind: 'reattach' });
    } else if (hasSpecialEnergyName(e, '燃料【火】能量') && (attacker.cardData.types ?? []).includes('Fire')) {
      entries.push({ owner: attackerOwner, holderId: attacker.id, energyId: e.id, kind: 'hand' });
    }
  }
  G.attackEnergyReturns = entries.length > 0 ? entries : null;
}

/**
 * The 「在招式的傷害與效果的影響之後」 half: runs from the central post-move wrapper at the first
 * moment no pendingChoice is open after an attack, which is exactly when the attack's damage and
 * effects have all landed. Requiring the holder to still be in play for BOTH cards is a deliberate
 * simplification: it is what stops a Knock-Out's stack discard from being mistaken for an
 * attack-effect discard, at the cost of the rare legal case where the effect discards the card
 * first and a retaliation ability then KOs the holder in the same attack.
 */
export function processAttackEnergyReturns(G: PtcgGameState): void {
  const entries = G.attackEnergyReturns;
  G.attackEnergyReturns = null;
  if (!entries) return;
  for (const entry of entries) {
    const p = G.players[entry.owner];
    const holder = [p.active, ...p.bench].find(c => c?.id === entry.holderId);
    if (!holder) continue;
    const i = p.discardPile.findIndex(c => c.id === entry.energyId);
    if (i === -1) continue; // the attack's effect never discarded it
    const card = p.discardPile.splice(i, 1)[0];
    if (entry.kind === 'hand') {
      p.hand.push(card);
    } else {
      holder.attachedEnergy.push({ id: card.id, type: card.cardData.types?.[0] ?? 'Colorless', cardData: card.cardData });
    }
    // Same push shape as attackResolution's addLog — imported it would close an import cycle
    // (attackResolution → passiveAbilities → this module).
    G.turnLog.push({
      player: entry.owner, turn: G.turn, action: 'special_energy_return', timestamp: Date.now(),
      details: entry.kind === 'hand'
        ? `${card.cardData.name} 回到了手牌`
        : `${card.cardData.name} 重新附於 ${holder.cardData.name} 身上`,
    });
  }
}

const isBasicPsychicPokemon = (c: GameCard) =>
  c.cardData.supertype === 'Pokémon'
  && c.cardData.subtypes.includes('Basic')
  && (c.cardData.types ?? []).includes('Psychic');

/**
 * 感應【超】能量: 「從手牌將這張卡附於【超】寶可夢身上時，從自己的牌庫選擇最多2張【超】屬性的
 * 【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。」
 *
 * Called from moves.attachEnergy — the only from-hand attach path — right after the card lands.
 * The search is a real decision, so it goes through a PendingChoice (resolved under effectKey
 * 'sensor_energy_bench' by resolveSensorEnergyBench). When there is nothing to decide — Bench
 * full, or no 【超】 Basic left in the deck — the deck is still shuffled, because the printed
 * effect searched it either way.
 */
export function maybeRaiseSensorEnergyBenchChoice(
  G: PtcgGameState, playerIdx: 0 | 1, target: GameCard, energy: { cardData?: GameCard['cardData'] },
): void {
  if (!hasSpecialEnergyName(energy, '感應【超】能量')) return;
  if (!(target.cardData.types ?? []).includes('Psychic')) return;
  const p = G.players[playerIdx];
  const emptySlots = p.bench.filter(s => s === null).length;
  const options = p.deck.filter(isBasicPsychicPokemon);
  if (emptySlots === 0 || options.length === 0) { shuffleDeck(p.deck); return; }
  G.pendingChoice = {
    player: playerIdx,
    effectKey: 'sensor_energy_bench',
    prompt: '感應【超】能量：從牌庫選擇最多2張【超】屬性的基礎寶可夢卡，放置於備戰區',
    choiceType: 'select_from_list',
    minCount: 0,
    maxCount: Math.min(2, emptySlots, options.length),
    options: options.map(c => ({ id: c.id, label: c.cardData.name })),
    context: {},
  };
}

/** The resolution half of the choice above: bench the picks, then the printed reshuffle.
 * Re-validates each pick (still in the deck AND actually a 【超】 Basic) rather than trusting the
 * submitted ids, and clamps to the printed 2. Returns the benched names for the battle log. */
export function resolveSensorEnergyBench(G: PtcgGameState, playerIdx: 0 | 1, selection: string[]): string[] {
  const p = G.players[playerIdx];
  const placed: string[] = [];
  for (const id of selection.slice(0, 2)) {
    const slot = p.bench.findIndex(s => s === null);
    const i = p.deck.findIndex(c => c.id === id);
    if (slot === -1 || i === -1 || !isBasicPsychicPokemon(p.deck[i])) continue;
    p.bench[slot] = p.deck.splice(i, 1)[0];
    placed.push(p.bench[slot]!.cardData.name);
  }
  shuffleDeck(p.deck);
  return placed;
}
