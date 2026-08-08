import { EnergyType, GameCard } from '@ptcg/shared';
import { PtcgGameState } from '../GameState';
import { normalizeAbilityName } from './types';

/**
 * Most real Pokémon abilities are NOT "use once per turn" triggered effects (the shape
 * abilities.ts/EffectHandler was originally built for) — they're passive, always-on field
 * effects worded "只要...在場上" (as long as ... is in play): damage boosts, retreat-cost
 * waivers, damage immunity, weakness overrides. Those need to be queried continuously from
 * damage.ts/validation.ts/statusConditions.ts rather than fired once by a use_ability move,
 * the same way Tool cards (tools.ts) are queried rather than resolved through a PendingChoice.
 * This module is that query surface for abilities.
 */

function hasAbility(card: GameCard | null | undefined, name: string): boolean {
  if (!card) return false;
  return !!card.cardData.abilities?.some(a => a.text && normalizeAbilityName(a.name) === name);
}

function teamOf(G: PtcgGameState, idx: 0 | 1): GameCard[] {
  const p = G.players[idx];
  return [p.active, ...p.bench].filter((c): c is GameCard => c !== null);
}

function ownerIndexOf(G: PtcgGameState, card: GameCard): 0 | 1 {
  return card.owner;
}

function isActivePokemon(G: PtcgGameState, card: GameCard): boolean {
  return G.players[ownerIndexOf(G, card)].active?.id === card.id;
}

function isBenchedPokemon(G: PtcgGameState, card: GameCard): boolean {
  return G.players[ownerIndexOf(G, card)].bench.some(c => c?.id === card.id);
}

/** Extra damage `attacker` deals to `defender`, from any of the attacker's own team's passive abilities. */
export function getPassiveDamageBonus(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard): number {
  let bonus = 0;
  for (const holder of teamOf(G, attackerIdx)) {
    if (hasAbility(holder, '輝煌聲援') && attacker.cardData.name.includes('竹蘭的')) bonus += 30;
    if (hasAbility(holder, '閃焰象徵') && holder.id !== attacker.id
      && attacker.cardData.types?.includes('Fire') && attacker.cardData.subtypes.includes('Basic')) bonus += 10;
    if (hasAbility(holder, '鈷藍指令') && holder.id !== attacker.id
      && attacker.cardData.subtypes.includes('Future')) bonus += 20;
    if (hasAbility(holder, '腎上腺力量') && holder.id === attacker.id
      && attacker.attachedEnergy.some(e => e.type === 'Darkness')) bonus += 100;
    if (hasAbility(holder, '皇家聲援')) bonus += 20;
    if (hasAbility(holder, '大方') && attacker.cardData.name.includes('赫普的')) bonus += 30;
    if (hasAbility(holder, '力之鹽') && (attacker.cardData.types || []).includes('Fighting')) bonus += 30;
    if (hasAbility(holder, '同步脈衝') && holder.id === attacker.id
      && G.players[attackerIdx].hand.length === G.players[(1 - attackerIdx) as 0 | 1].hand.length) bonus += 80;
    // 激動力量: gated on own field having a Darkness-type "超級進化...ex" (Mega ex) anywhere,
    // boosts THIS Pokémon's (the ability holder's) own attacks specifically.
    if (hasAbility(holder, '激動力量') && holder.id === attacker.id
      && teamOf(G, attackerIdx).some(c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex') && (c.cardData.types || []).includes('Darkness'))) bonus += 120;
    // 勝利聲援: +10 for own Fire-type evolved-stage Pokémon's attacks specifically.
    if (hasAbility(holder, '勝利聲援') && (attacker.cardData.types || []).includes('Fire') && !!attacker.cardData.evolvesFrom) bonus += 10;
    // 憤怒穴: self-only, +120 while holding 2+ damage counters.
    if (hasAbility(holder, '憤怒穴') && holder.id === attacker.id && attacker.damage >= 20) bonus += 120;
  }
  // 原始心得: +30 vs an opponent's evolved-stage Active Pokémon specifically.
  if (teamOf(G, attackerIdx).some(c => hasAbility(c, '原始心得')) && !!defender.cardData.evolvesFrom) bonus += 30;
  // 複眼: +50 vs an opponent Active that itself holds any ability.
  if (teamOf(G, attackerIdx).some(c => hasAbility(c, '複眼')) && defender.cardData.abilities?.some(a => a.text)) bonus += 50;
  // 大晴天: +20 for own Grass or Fire attackers.
  if (teamOf(G, attackerIdx).some(c => hasAbility(c, '大晴天'))
    && ((attacker.cardData.types || []).includes('Grass') || (attacker.cardData.types || []).includes('Fire'))) bonus += 20;
  // 大將: +30 per prize the opponent has already taken.
  if (teamOf(G, attackerIdx).some(c => hasAbility(c, '大將'))) bonus += G.players[(1 - attackerIdx) as 0 | 1].takenPrizes * 30;
  return bonus;
}

/** True if `defender` takes zero damage (and, per real rules for these two, zero attack effects)
 * from `attacker`'s attack. `attackPrintedDamage` (the attack's raw printed damage number,
 * before any modifiers) is optional and only needed for damage-threshold abilities like 鐵壁硬殼. */
export function isDamageBlocked(G: PtcgGameState, attacker: GameCard, defender: GameCard, attackPrintedDamage?: number): boolean {
  // 鐵壁硬殼: immune to attacks with 200+ printed damage.
  if (hasAbility(defender, '鐵壁硬殼') && (attackPrintedDamage ?? 0) >= 200) return true;
  // 礎石之勢: immune to damage from any Pokémon that itself has an ability.
  if (hasAbility(defender, '礎石之勢') && attacker.cardData.abilities?.some(a => a.text)) return true;
  // 藏隱: while benched, untouchable by opponent attacks entirely (relevant to bench-hitting attacks).
  if (hasAbility(defender, '藏隱') && isBenchedPokemon(G, defender)) return true;
  // 化隱: untouchable regardless of board position (a stronger, unconditional variant of 藏隱).
  if (hasAbility(defender, '化隱')) return true;
  // 花之帷幔: own non-rule-box Benched Pokémon are immune to opponent attack damage.
  if (isBenchedPokemon(G, defender) && !isRuleBoxPokemon(defender)
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '花之帷幔'))) return true;
  // 神秘石居: immune to damage specifically from an opponent's "ex" Pokémon.
  if (hasAbility(defender, '神秘石居') && attacker.cardData.subtypes.includes('ex')) return true;
  // 神秘守護: immune to damage from an opponent's "ex" OR "V" Pokémon (a broader variant of 神秘石居/尾甲).
  if (hasAbility(defender, '神秘守護') && (attacker.cardData.subtypes.includes('ex') || attacker.cardData.subtypes.includes('V'))) return true;
  // 腎上腺費洛蒙: while holding Darkness Energy, a coin flip may negate the hit entirely.
  if (hasAbility(defender, '腎上腺費洛蒙') && defender.attachedEnergy.some(e => e.type === 'Darkness') && Math.random() < 0.5) return true;
  // 順滑大衣: unconditional coin-flip immunity.
  if (hasAbility(defender, '順滑大衣') && Math.random() < 0.5) return true;
  // 太古防壁: while its own holder is Benched, the whole team is immune to attackers holding 2 or fewer Energy.
  if (attacker.attachedEnergy.length <= 2
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '太古防壁') && isBenchedPokemon(G, c))) return true;
  // 球形盾牌: own Benched Pokémon are immune to opponent attack damage, unconditionally.
  if (isBenchedPokemon(G, defender) && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '球形盾牌'))) return true;
  // 深度下潛: self-only, while Benched, immune to opponent attack damage AND their attack effects
  // (the "effects" half isn't separately enforceable — there's no generic attack-effect-targeting
  // hook — but blocking damage here also prevents any effect that's gated on `damage > 0`).
  if (hasAbility(defender, '深度下潛') && isBenchedPokemon(G, defender)) return true;
  // 尾甲: immune to damage from an opponent's Basic-stage "ex" Pokémon specifically (a narrower
  // variant of 神秘石居, which is immune to any opponent ex regardless of stage).
  if (hasAbility(defender, '尾甲') && attacker.cardData.subtypes.includes('Basic') && attacker.cardData.subtypes.includes('ex')) return true;
  // 躲藏高手: unconditional coin-flip immunity (same shape as 順滑大衣, different card).
  if (hasAbility(defender, '躲藏高手') && Math.random() < 0.5) return true;
  return false;
}

/** Rule-box Pokémon (ex/V/VMAX/VSTAR/GX/Mega/TAG TEAM) — local copy to avoid a cross-module import cycle. */
function isRuleBoxPokemon(card: GameCard): boolean {
  const subs = card.cardData.subtypes || [];
  const ruleBoxSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'TAG TEAM'];
  if (subs.some(s => ruleBoxSubtypes.includes(s))) return true;
  return card.cardData.name.startsWith('超級');
}

/** Flat damage reduction (before floor-at-0) applied to hits `defender` takes, from its own or its team's ability. */
export function getPassiveDamageReduction(G: PtcgGameState, defender: GameCard, attacker?: GameCard): number {
  let reduction = 0;
  // 凍原堡壘: -50 for any own Pokémon holding Water Energy, gated on the ability's own holder
  // being in play; non-stacking across multiple holders.
  if (defender.attachedEnergy.some(e => e.type === 'Water')
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '凍原堡壘'))) reduction += 50;
  if (hasAbility(defender, '毛皮大衣')) reduction += 20;
  // 厚脂肪: -30, only against Fire or Water attackers specifically.
  if (hasAbility(defender, '厚脂肪') && attacker && ((attacker.cardData.types || []).includes('Fire') || (attacker.cardData.types || []).includes('Water'))) reduction += 30;
  // 高密度盔甲: -60, only while entering the hit at full HP.
  if (hasAbility(defender, '高密度盔甲') && defender.damage === 0) reduction += 60;
  // 垃圾洩氣: -20, only against an attacker that itself holds an attached Pokémon Tool.
  if (attacker?.attachedTool && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '垃圾洩氣'))) reduction += 20;
  // 岩石宮殿: -30 for own "大吾的" family Pokémon, gated on its own holder being Benched; non-stacking.
  if (defender.cardData.name.includes('大吾的')
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '岩石宮殿') && isBenchedPokemon(G, c))) reduction += 30;
  // 守護之鐘: -10 for the whole team, non-stacking.
  if (teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '守護之鐘'))) reduction += 10;
  if (hasAbility(defender, '爆炸頭防守')) reduction += 20;
  if (hasAbility(defender, '堅堅之軀')) reduction += 30;
  // 齒輪塗層: any own Pokémon holding Metal Energy takes -20, as long as the ability's holder is in play.
  if (defender.attachedEnergy.some(e => e.type === 'Metal')
    && teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '齒輪塗層'))) reduction += 20;
  if (hasAbility(defender, '密林之軀')) reduction += 30;
  if (hasAbility(defender, '堅硬甲殼')) reduction += 20;
  if (hasAbility(defender, '泥巴膜')) reduction += 30;
  // 岩石盔甲: -30 only while holding at least 1 attached Energy card.
  if (hasAbility(defender, '岩石盔甲') && defender.attachedEnergy.length > 0) reduction += 30;
  if (hasAbility(defender, '堅硬身軀')) reduction += 20;
  if (hasAbility(defender, '柔軟羊毛')) reduction += 30;
  // 捲牆: gated on 2+ copies of its own named holder ("爆炸頭水牛") in play; -60 for own
  // Colorless-type Basic Pokémon defenders. Doesn't stack across multiple holder pairs.
  if (defender.cardData.subtypes.includes('Basic') && (defender.cardData.types || []).includes('Colorless')
    && teamOf(G, ownerIndexOf(G, defender)).filter(c => c.cardData.name === '爆炸頭水牛').length >= 2) reduction += 60;
  // 威嚇之牙: -30, only while its holder is the one being hit as Active.
  if (hasAbility(defender, '威嚇之牙') && isActivePokemon(G, defender)) reduction += 30;
  if (hasAbility(defender, '鑽石膜')) reduction += 30;
  return reduction;
}

/** Retaliation counters placed on the attacker, scaled by the defender's own attached Energy
 * (as opposed to the flat-amount retaliation abilities handled via hasPassiveAbilityNamed). */
export function getScaledRetaliation(defender: GameCard): number {
  // 快掃拳返: 2 counters per attached Metal Energy.
  if (hasAbility(defender, '快掃拳返')) {
    return defender.attachedEnergy.filter(e => e.type === 'Metal').length * 2;
  }
  // 尖刺盔甲: 3 counters per attached Grass Energy.
  if (hasAbility(defender, '尖刺盔甲')) {
    return defender.attachedEnergy.filter(e => e.type === 'Grass').length * 3;
  }
  return 0;
}

/** 甲殼刺: whenever this Pokémon (while Active) takes attack damage, discard 1 Energy attached
 * to the attacker. Returns true if a discard should happen (the caller picks which one, since
 * this module has no PendingChoice access). */
export function shouldDiscardAttackerEnergy(defender: GameCard): boolean {
  return hasAbility(defender, '甲殼刺');
}

/** 海之詛咒: while its holder is the OPPONENT's Active Pokémon, `playerIndex` can't play Item
 * cards from hand or attach Pokémon Tool cards at all. */
export function isItemAndToolPlayBlocked(G: PtcgGameState, playerIndex: 0 | 1): boolean {
  const oppActive = G.players[(1 - playerIndex) as 0 | 1].active;
  return !!oppActive && hasAbility(oppActive, '海之詛咒');
}

/** 威迫目光: while its holder is the OPPONENT's Active Pokémon, `playerIndex` can't play Item
 * cards from hand at all (narrower than 海之詛咒, which also blocks Tool attachment). */
export function isItemPlayBlocked(G: PtcgGameState, playerIndex: 0 | 1): boolean {
  const oppActive = G.players[(1 - playerIndex) as 0 | 1].active;
  return !!oppActive && hasAbility(oppActive, '威迫目光');
}

/** 瞪眼效用: while its holder is the OPPONENT's Active Pokémon, `playerIndex` can't play any
 * ability-holding Pokémon from hand onto the field, except ones named with "火箭隊的". */
export function isAbilityPokemonPlayBlocked(G: PtcgGameState, playerIndex: 0 | 1, card: GameCard): boolean {
  if (!card.cardData.abilities?.some(a => a.text) || card.cardData.name.includes('火箭隊的')) return false;
  const oppActive = G.players[(1 - playerIndex) as 0 | 1].active;
  return !!oppActive && hasAbility(oppActive, '瞪眼效用');
}

/** 鬆口氣: when this Pokémon is KO'd by an attack, the opposing side's awarded prizes are
 * reduced by 1, gated on this Pokémon's own team also having "桃歹郎 ex" in play. Simplified to
 * apply on any KO cause (not just attack damage specifically) since handleKo doesn't carry a
 * KO-cause flag — a documented over-application rather than a silent no-op.
 * 影藏 / 脆弱蛻殼 both specifically require the KO to come from an opponent "ex" Pokémon's attack —
 * `attackerCard`, when provided by an attack-KO call site, makes that precise instead of an
 * over-application: 影藏 reduces by 1 (Darkness-type holder team only), 脆弱蛻殼 negates prizes
 * entirely (a large sentinel, floored at 0 by the caller). */
export function getPrizeReduction(G: PtcgGameState, koPlayerIndex: 0 | 1, koCard: GameCard, attackerCard?: GameCard): number {
  let reduction = 0;
  if (hasAbility(koCard, '鬆口氣') && teamOf(G, koPlayerIndex).some(c => c.cardData.name === '桃歹郎ex')) reduction += 1;
  const attackerIsEx = !!attackerCard?.cardData.subtypes.includes('ex');
  if (attackerIsEx && (koCard.cardData.types || []).includes('Darkness')
    && teamOf(G, koPlayerIndex).some(c => hasAbility(c, '影藏'))) reduction += 1;
  if (attackerIsEx && hasAbility(koCard, '脆弱蛻殼')) reduction += 99;
  return reduction;
}

/** 炸裂針: when a lethal hit KOs its holder, place 6 damage counters on the attacker (checked by the caller only once the hit is confirmed lethal). */
export function getLethalOnlyRetaliation(defender: GameCard): number {
  return hasAbility(defender, '炸裂針') ? 6 : 0;
}

/** 熔岩波動: opponent's Burned Pokémon take +3 counters (30 damage) instead of the normal 2 (20), as long as the holder is in play. */
export function getBurnCounterBonus(G: PtcgGameState, burnedIdx: 0 | 1): number {
  const opponentActive = G.players[(1 - burnedIdx) as 0 | 1].active;
  if (opponentActive && hasAbility(opponentActive, '熔岩波動')) return 3;
  return 0;
}

/** 出道演出: lets its holder attack even on the game's first turn. */
export function canAttackOnFirstTurn(card: GameCard): boolean {
  return hasAbility(card, '出道演出');
}

/** Retreat cost is fully waived for `card` by any of its own team's passive abilities. */
export function getPassiveRetreatWaiver(G: PtcgGameState, idx: 0 | 1, card: GameCard): boolean {
  for (const holder of teamOf(G, idx)) {
    if ((hasAbility(holder, '天空徑線') || hasAbility(holder, '棉花搬運')) && card.cardData.subtypes.includes('Basic')) return true;
    if (hasAbility(holder, '鋼之橋') && card.attachedEnergy.some(e => e.type === 'Metal')) return true;
  }
  // 溶化流動 / 一身輕: self-only, waived while holding no Energy at all (same shape, different cards).
  if ((hasAbility(card, '溶化流動') || hasAbility(card, '一身輕')) && card.attachedEnergy.length === 0) return true;
  // 懦弱: self-only, waived whenever the opponent has a "V" Pokémon in play.
  if (hasAbility(card, '懦弱')) {
    const oppIdx = (1 - idx) as 0 | 1;
    if (teamOf(G, oppIdx).some(c => c.cardData.subtypes.includes('V'))) return true;
  }
  return false;
}

/** 黏滑失足: while in play, whenever the OPPONENT's Active retreats, a coin flip may cancel the
 * retreat entirely (Energy not discarded, no swap). Doesn't stack across multiple holders. */
export function isRetreatBlockedByOpponent(G: PtcgGameState, retreatingIdx: 0 | 1): boolean {
  const oppIdx = (1 - retreatingIdx) as 0 | 1;
  if (!teamOf(G, oppIdx).some(c => hasAbility(c, '黏滑失足'))) return false;
  return Math.random() < 0.5;
}

/** 凹洞: whenever the OPPONENT's Active retreats (during the opponent's own turn), 2 damage
 * counters land on the Pokémon that just retreated. */
export function getRetreatPunishmentCounters(G: PtcgGameState, retreatingIdx: 0 | 1): number {
  const oppIdx = (1 - retreatingIdx) as 0 | 1;
  return teamOf(G, oppIdx).some(c => hasAbility(c, '凹洞')) ? 2 : 0;
}

/** 漩渦言靈: while its holder is the OPPONENT's Active, whenever this side retreats, the newly
 * promoted Pokémon is Confused. */
export function shouldConfuseOnOpponentRetreat(G: PtcgGameState, retreatingIdx: 0 | 1): boolean {
  const oppIdx = (1 - retreatingIdx) as 0 | 1;
  const oppActive = G.players[oppIdx].active;
  return !!oppActive && hasAbility(oppActive, '漩渦言靈');
}

/** 熔岩地域: whenever the OPPONENT retreats (holder just needs to be in play, any position),
 * the newly promoted Pokémon is Burned instead of Confused (same shape as 漩渦言靈). */
export function shouldBurnOnOpponentRetreat(G: PtcgGameState, retreatingIdx: 0 | 1): boolean {
  const oppIdx = (1 - retreatingIdx) as 0 | 1;
  return teamOf(G, oppIdx).some(c => hasAbility(c, '熔岩地域'));
}

/** 森林秘道: -2 retreat cost for the OWN Active Pokémon, gated on its holder being Benched. */
export function getPassiveRetreatCostReduction(G: PtcgGameState, card: GameCard): number {
  if (!isActivePokemon(G, card)) return 0;
  return teamOf(G, ownerIndexOf(G, card)).some(c => hasAbility(c, '森林秘道') && isBenchedPokemon(G, c)) ? 2 : 0;
}

/** 咒縛火焰: +1 retreat cost for the OPPONENT's Active Pokémon, as long as the holder is in play. */
export function getPassiveRetreatCostIncrease(G: PtcgGameState, card: GameCard): number {
  if (!isActivePokemon(G, card)) return 0;
  const oppIdx = (1 - ownerIndexOf(G, card)) as 0 | 1;
  let increase = teamOf(G, oppIdx).some(c => hasAbility(c, '咒縛火焰')) ? 1 : 0;
  // 大網: +1, only for evolved-stage opponent Active Pokémon (anything with evolvesFrom set).
  if (!!card.cardData.evolvesFrom && teamOf(G, oppIdx).some(c => hasAbility(c, '大網'))) increase += 1;
  return increase;
}

/** 化身團結: full Colorless-cost waiver, gated by all 4 named Forces of Nature being in play. */
export function hasPassiveColorlessCostWaiver(G: PtcgGameState, card: GameCard): boolean {
  if (!hasAbility(card, '化身團結')) return false;
  const names = new Set(teamOf(G, ownerIndexOf(G, card)).map(c => c.cardData.name));
  return ['龍捲雲', '雷電雲', '土地雲', '眷戀雲'].every(n => names.has(n));
}

/** Extra max-HP `card` gains from its own passive ability. */
export function getPassiveMaxHpBonus(G: PtcgGameState, card: GameCard): number {
  if (hasAbility(card, '腎上腺力量') && card.attachedEnergy.some(e => e.type === 'Darkness')) return 100;
  if (hasAbility(card, '雜草魂')) return G.players[(1 - ownerIndexOf(G, card)) as 0 | 1].takenPrizes * 50;
  if (hasAbility(card, '大師工藝')) return card.attachedEnergy.filter(e => e.type === 'Fighting').length * 40;
  // 生機森巴: +40 max HP for every own Pokémon, doesn't stack across multiple holders.
  if (teamOf(G, ownerIndexOf(G, card)).some(c => hasAbility(c, '生機森巴'))) return 40;
  return 0;
}

/** False if `card`'s passive ability makes its own attacks currently unusable (e.g. 力量抑制者's family-count gate). */
export function canUsePassiveGatedAttack(G: PtcgGameState, card: GameCard): boolean {
  if (hasAbility(card, '力量抑制者')) {
    const rocketCount = teamOf(G, ownerIndexOf(G, card)).filter(c => c.cardData.name.includes('火箭隊的')).length;
    return rocketCount >= 4;
  }
  // 懶怠個性: can't attack unless the opponent has an ex/V Pokémon in play.
  if (hasAbility(card, '懶怠個性')) {
    const oppIdx = (1 - ownerIndexOf(G, card)) as 0 | 1;
    return teamOf(G, oppIdx).some(c => isRuleBoxPokemon(c) && (c.cardData.subtypes.includes('ex') || c.cardData.subtypes.includes('V')));
  }
  // 啟動限制: can't attack unless own hand size is 10+.
  if (hasAbility(card, '啟動限制')) {
    return G.players[ownerIndexOf(G, card)].hand.length >= 10;
  }
  return true;
}

/** 提升進化: lets `target` evolve even on the game's first turn, or the turn it was just played.
 * 刺激進化 grants the same exemption, conditional on "小嘴蝸" also being in play. */
export function canEvolveOnFirstTurnOrJustPlayed(G: PtcgGameState, target: GameCard): boolean {
  if (hasAbility(target, '提升進化')) return true;
  if (hasAbility(target, '刺激進化')) {
    return teamOf(G, ownerIndexOf(G, target)).some(c => c.cardData.name === '小嘴蝸');
  }
  // 鬥志戰吼: bypassed if the opponent's Active is an "ex" Pokémon.
  if (hasAbility(target, '鬥志戰吼')) {
    const oppActive = G.players[(1 - ownerIndexOf(G, target)) as 0 | 1].active;
    return !!oppActive && oppActive.cardData.subtypes.includes('ex');
  }
  return false;
}

/** 自動治癒 / 侵蝕詛咒: reacts to a hand Energy attach. Heals `target` 90 if its own team holds
 * 自動治癒 (only while `target` is Active); places 2 damage counters on `target` if the
 * OPPONENT of `attachingIdx` holds 侵蝕詛咒 (unconditional on position, per printed text). */
export function onEnergyAttachedFromHand(G: PtcgGameState, attachingIdx: 0 | 1, target: GameCard): void {
  if (isActivePokemon(G, target) && teamOf(G, attachingIdx).some(c => hasAbility(c, '自動治癒'))) {
    target.damage = Math.max(0, target.damage - 90);
  }
  const oppIdx = (1 - attachingIdx) as 0 | 1;
  if (teamOf(G, oppIdx).some(c => hasAbility(c, '侵蝕詛咒'))) {
    target.damage += 20;
  }
}

/** 冰冷之帳: each Between-Turns check, every ability-holding Pokémon (both sides, except the
 * 冰冷之帳 holder itself) takes 1 damage counter, as long as its holder is in play. */
export function getColdCurtainVictims(G: PtcgGameState): GameCard[] {
  if (!everyPokemonBothSides(G).some(c => hasAbility(c, '冰冷之帳'))) return [];
  return everyPokemonBothSides(G).filter(c => !hasAbility(c, '冰冷之帳') && c.cardData.abilities?.some(a => a.text));
}

function everyPokemonBothSides(G: PtcgGameState): GameCard[] {
  return [...teamOf(G, 0), ...teamOf(G, 1)];
}

/** 揚沙: each Between-Turns check, every opponent Basic Pokémon takes 1 damage counter, gated
 * on the holder being its own side's Active. */
export function getSandstormVictims(G: PtcgGameState): GameCard[] {
  const victims: GameCard[] = [];
  for (const idx of [0, 1] as const) {
    const holder = G.players[idx].active;
    if (!holder || !hasAbility(holder, '揚沙')) continue;
    const oppIdx = (1 - idx) as 0 | 1;
    victims.push(...teamOf(G, oppIdx).filter(c => c.cardData.subtypes.includes('Basic')));
  }
  return victims;
}

/** 黑暗脈衝: whenever the OPPONENT completes an evolution by playing a card from hand, 4 damage
 * counters land on the newly evolved Pokémon. Doesn't stack across multiple holders. */
export function getEvolveCountersFromOpponent(G: PtcgGameState, evolvingIdx: 0 | 1): number {
  const oppIdx = (1 - evolvingIdx) as 0 | 1;
  return teamOf(G, oppIdx).some(c => hasAbility(c, '黑暗脈衝')) ? 4 : 0;
}

/** Extra prizes awarded to `attackerIdx` when their attack KOs `defender` (beyond the normal count). */
export function getBonusPrizesForAttackKo(G: PtcgGameState, attackerIdx: 0 | 1, attacker: GameCard, defender: GameCard): number {
  // 貪婪食客: +1 prize if this Pokémon's own attack KOs an opponent's Basic Pokémon.
  if (hasAbility(attacker, '貪婪食客') && defender.cardData.subtypes.includes('Basic')) return 1;
  return 0;
}

/** Coin-flip bonus prize (奇跡之吻-style): whenever the opponent's Active Pokémon faints (any cause),
 * `victimIdx`'s opponent flips a coin for +1 prize if any of their own team has this ability.
 * Doesn't stack across multiple holders per the printed text. */
export function rollBonusPrizeOnActiveKo(G: PtcgGameState, victimIdx: 0 | 1): number {
  const beneficiaryIdx = (1 - victimIdx) as 0 | 1;
  if (!teamOf(G, beneficiaryIdx).some(c => hasAbility(c, '奇跡之吻'))) return 0;
  return Math.random() < 0.5 ? 1 : 0;
}

/** If an opponent's passive ability overrides `defender`'s weakness type, returns that type. */
export function getWeaknessTypeOverride(G: PtcgGameState, defenderIdx: 0 | 1, defender: GameCard): EnergyType | undefined {
  const attackerIdx = (1 - defenderIdx) as 0 | 1;
  for (const holder of teamOf(G, attackerIdx)) {
    if (hasAbility(holder, '妖精領域') && defender.cardData.types?.includes('Dragon')) return 'Psychic';
  }
  return undefined;
}

/** Extra damage counters (on top of the normal 1) placed on `poisoned` by Between-Turns poison tick. */
export function getPoisonCounterBonus(G: PtcgGameState, poisonedIdx: 0 | 1): number {
  const opponentActive = G.players[(1 - poisonedIdx) as 0 | 1].active;
  if (opponentActive && hasAbility(opponentActive, '劇毒支配') && isActivePokemon(G, opponentActive)) return 5;
  return 0;
}

/** Colorless-cost reduction for a specific Pokémon+attack combo, from the attacker's own passive ability. */
export function getPassiveAttackCostReduction(G: PtcgGameState, ownerIdx: 0 | 1, card: GameCard, attackName: string): number {
  if (hasAbility(card, '老練招式') && card.cardData.name === '月月熊 赫月 ex' && attackName === '血月') {
    return G.players[(1 - ownerIdx) as 0 | 1].takenPrizes;
  }
  // 喧鬧競技: Colorless cost reduced by the opponent's Benched Pokémon count.
  if (hasAbility(card, '喧鬧競技')) {
    return G.players[(1 - ownerIdx) as 0 | 1].bench.filter(c => c !== null).length;
  }
  // 事先準備: Colorless cost reduced by the count of "海岱" in this Pokémon's own discard pile.
  if (hasAbility(card, '事先準備')) {
    return G.players[ownerIdx].discardPile.filter(c => c.cardData.name === '海岱').length;
  }
  // 調諧迴響: full Colorless-cost waiver for a specific named attack ("恐慌嚎鳴"), gated on own
  // hand count equaling the opponent's hand count. A large flat number stands in for "full
  // waiver" the same way 化身團結 zeroes out just the Colorless portion elsewhere.
  if (hasAbility(card, '調諧迴響') && attackName === '恐慌嚎鳴'
    && G.players[ownerIdx].hand.length === G.players[(1 - ownerIdx) as 0 | 1].hand.length) return 99;
  // 狙擊手之眼: full Colorless-cost waiver for ANY of this Pokémon's attacks, gated on the
  // opponent's hand size being exactly 4.
  if (hasAbility(card, '狙擊手之眼') && G.players[(1 - ownerIdx) as 0 | 1].hand.length === 4) return 99;
  return 0;
}

/** 虹色DNA: 伊布ex lets any "Eevee"-evolution ex be played from hand directly onto it, as if it evolved from 伊布. */
export function canEvolveViaPassive(target: GameCard, evolutionCardData: GameCard['cardData']): boolean {
  if (!hasAbility(target, '虹色DNA')) return false;
  return evolutionCardData.evolvesFrom === '伊布';
}

/** 放逐區障礙: if `defenderIdx`'s side has this ability in play, the attacking side's prizes are exiled, not drawn to hand. */
export function shouldExilePrizes(G: PtcgGameState, koVictimIdx: 0 | 1): boolean {
  return teamOf(G, koVictimIdx).some(c => hasAbility(c, '放逐區障礙'));
}

/** 崗哨: while `card` is Benched and its own team has this ability in play, its attached Energy
 * can't be discarded by the opponent's Item/Supporter effects (e.g. 粉碎之錘, 改造之錘). Real
 * text only protects Basic Energy specifically, but attachedEnergy doesn't retain whether the
 * source card was Basic vs Special — so this protects all attached Energy on the Pokémon,
 * a documented over-protection rather than under-protection. */
export function isEnergyDiscardProtected(G: PtcgGameState, card: GameCard): boolean {
  if (!isBenchedPokemon(G, card)) return false;
  return teamOf(G, ownerIndexOf(G, card)).some(c => hasAbility(c, '崗哨'));
}

/** 怨恨旋渦: whenever the OWN Active Darkness Pokémon takes attack damage, the attacker gets 1
 * counter — the ability's holder need not be the one hit, just present on the same team. */
export function getGrudgeVortexRetaliation(G: PtcgGameState, defender: GameCard): number {
  if (!isActivePokemon(G, defender) || !(defender.cardData.types || []).includes('Darkness')) return 0;
  return teamOf(G, ownerIndexOf(G, defender)).some(c => hasAbility(c, '怨恨旋渦')) ? 1 : 0;
}

export { hasAbility as hasPassiveAbilityNamed };

/** Every ability name this module gives real, non-default behavior to — used by coverage-report.ts. */
export const PASSIVE_ABILITY_NAMES = new Set([
  '輝煌聲援', '閃焰象徵', '鈷藍指令', '腎上腺力量', '礎石之勢', '藏隱', '天空徑線', '鋼之橋',
  '妖精領域', '劇毒支配', '老練招式', '虹色DNA', '放逐區障礙', '祭典樂舞', '崗哨',
  '皇家聲援', '化隱', '花之帷幔', '神秘石居', '腎上腺費洛蒙', '爆炸頭防守', '雜草魂',
  '力量抑制者', '貪婪食客', '奇跡之吻', '毒刺',
  '堅堅之軀', '溶化流動', '喧鬧競技', '事先準備', '懶怠個性', '提升進化', '自動治癒',
  '侵蝕詛咒', '冰冷之帳', '大方', '灼熱之軀',
  '化身團結', '刺激進化', '咒縛火焰', '太古防壁', '同步脈衝', '順滑大衣', '力之鹽',
  '怨恨旋渦', '齒輪塗層', '堅忍之軀', '反擊雞冠', '大師工藝',
  '密林之軀', '堅硬甲殼', '炸裂針', '自動用武', '反擊', '球形盾牌', '熔岩波動', '出道演出',
  '生機森巴', '深度下潛', '尾甲', '泥巴膜', '岩石盔甲', '勤奮之心',
  '神秘守護', '堅硬身軀', '柔軟羊毛', '捲牆', '快掃拳返', '海之詛咒', '鬆口氣', '懦弱', '一身輕', '結實', '反擊針',
  '威嚇之牙', '躲藏高手', '激動力量', '鑽石膜', '調諧迴響', '狙擊手之眼', '不眠', '黏滑失足',
  '凍原堡壘', '毛皮大衣', '厚脂肪', '大網', '凹洞', '漩渦言靈', '影藏', '脆弱蛻殼',
  '勝利聲援', '憤怒穴', '原始心得', '鐵壁硬殼', '威迫目光', '瞪眼效用', '熔岩地域', '揚沙', '啟動限制', '黑暗脈衝',
  '高密度盔甲', '棉花搬運', '不朽身軀', '尖刺盔甲', '垃圾洩氣', '甲殼刺', '鬥志戰吼', '複眼', '無限之影',
  '大將', '岩石宮殿', '大晴天', '森林秘道', '守護之鐘', '憨憨臉',
]);
