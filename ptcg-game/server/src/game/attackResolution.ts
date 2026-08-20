/**
 * Resolving one attack against the board, independent of whose turn it is.
 *
 * Lives outside moves.ts so that card effects can reach it too: 「選擇1個…持有的招式，作為這個
 * 招式使用」 cards resolve someone else's attack, and effects/attacks.ts cannot import moves.ts
 * without creating a cycle (moves.ts imports the attack registry).
 *
 * Nothing here touches `ctx` — ending the turn stays with moves.attack, so a copied attack
 * behaves the same however it was reached.
 */
import { Attack, DamageDetail, GameCard, TurnAction } from '@ptcg/shared';
import { PtcgGameState, PtcgPlayerState } from './GameState';
import { calculateDamageBreakdown, effectiveMaxHp, flushPreEvolutionsTo, flushPreEvolutionsToDiscard, handleKo, prizesForKo, resetCardForReentry, stackAsPreEvolution } from './damage';
import { getBonusPrizesForAttackKo, getGrudgeVortexRetaliation, getLethalOnlyRetaliation, getScaledRetaliation, getTimedRetaliationCounters, hasPassiveAbilityNamed, hasTeraBenchedImmunity, isImmuneToOpponentAttackEffects, shouldDiscardAttackerEnergy, isProtectedFromOpponentAbility, isReturnToHandBlocked } from './effects/passiveAbilities';
import { benchDamageFromEffectsBlocked, benchLimit, isStadiumActive } from './effects/stadiums';
import { getToolRetaliationDamage } from './effects/tools';
import { specialEnergyRetaliation } from './effects/specialEnergy';
import { applyStatusCondition, discardAttachedEnergy, drawCards, drawUpTo, millDeck, shuffleDeck, asAttachedEnergy } from './effects/primitives';
import { AttackBoardContext, resolveGenericAttackEffect } from './effects/genericAttacks';
import { inferEvolvesFromSpecies, evolvesFromMatches } from './evolutionChains';
import { effectiveRetreatCost } from './validation';
import { normalizeAbilityName } from './effects/types';
import { clearStatusConditionsOnLeaveActive } from './statusConditions';

export const ENERGY_TYPE_ZH_LABEL: Record<string, string> = {
  Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超',
  Fighting: '鬥', Darkness: '惡', Metal: '鋼', Fairy: '妖', Dragon: '龍', Colorless: '無',
};

export function addLog(G: PtcgGameState, player: number, action: string, details: string, damageDetail?: DamageDetail, coinFlipNote?: string) {
  G.turnLog.push({
    player: player as 0 | 1,
    turn: G.turn,
    action,
    details,
    timestamp: Date.now(),
    damageDetail,
    coinFlipNote,
  });
}

export function buildAttackBoard(
  G: PtcgGameState,
  player: PtcgPlayerState,
  opponent: PtcgPlayerState,
  attacker: GameCard,
  defender: GameCard,
  attack: Attack,
): AttackBoardContext {
  const ownBench = player.bench.filter((c): c is GameCard => c !== null);
  const attackBoard = {
    ownFieldPokemonCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).length,
    ownToolCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !!c.attachedTool).length,
    selfDamageCounters: attacker.damage / 10,
    opponentEnergyCount: defender.attachedEnergy.length,
    opponentDamageCounters: defender.damage / 10,
    ownBenchCount: ownBench.length,
    opponentBenchCount: opponent.bench.filter(c => c !== null).length,
    ownRemainingPrizes: player.prizes.length,
    opponentRemainingPrizes: opponent.prizes.length,
    defenderStatusConditionCount: defender.statusConditions.length,
    defenderIsBurned: defender.statusConditions.includes('Burned'),
    defenderIsEx: defender.cardData.subtypes.includes('ex'),
    attackerEnergyCounts: attacker.attachedEnergy.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
    ownBenchTypes: ownBench.flatMap(c => c.cardData.types || []),
    attackerTotalEnergyCount: attacker.attachedEnergy.length,
    bothActiveEnergyCount: attacker.attachedEnergy.length + defender.attachedEnergy.length,
    ownDiscardCardNames: player.discardPile.map(c => c.cardData.name),
    attackerEvolvesFrom: attacker.cardData.evolvesFrom || inferEvolvesFromSpecies(attacker.cardData.name),
    ownBenchNames: ownBench.map(c => c.cardData.name),
    opponentDiscardBasicEnergyCount: opponent.discardPile.filter(c => c.cardData.subtypes.includes('Basic Energy')).length,
    ownDeckCount: player.deck.length,
    ownFieldTotalEnergyCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).reduce((sum, c) => sum + c.attachedEnergy.length, 0),
    ownFieldEnergyCounts: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.attachedEnergy).reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
    defenderTypes: defender.cardData.types || [],
    defenderSubtypes: defender.cardData.subtypes || [],
    defenderEvolvesFrom: defender.cardData.evolvesFrom || inferEvolvesFromSpecies(defender.cardData.name),
    defenderIsConfused: defender.statusConditions.includes('Confused'),
    defenderRetreatCost: effectiveRetreatCost(G, defender),
    opponentFieldTypes: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.cardData.types || []),
    opponentHasFutureSubtype: [opponent.active, ...opponent.bench].some(c => c?.cardData.subtypes.includes('Future')),
    opponentHandCount: opponent.hand.length,
    ownPokemonFaintedLastTurn: player.lastPokemonFaintedTurn === G.turn - 1,
    defenderStatusConditions: [...defender.statusConditions],
    defenderName: defender.cardData.name,
    ownHandCount: player.hand.length,
    ownHandNames: player.hand.map(c => c.cardData.name),
    attackerStatusConditions: [...attacker.statusConditions],
    defenderHasTool: !!defender.attachedTool || !!defender.attachedTool2,
    defenderHasSpecialEnergy: defender.attachedEnergy.some(e => e.cardData?.subtypes?.includes('Special Energy')),
    attackerHasTool: !!attacker.attachedTool || !!attacker.attachedTool2,
    attackerSpecialEnergyCount: attacker.attachedEnergy.filter(e => e.cardData?.subtypes?.includes('Special Energy')).length,
    opponentFieldSpecialEnergyCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null)
      .reduce((sum, c) => sum + c.attachedEnergy.filter(e => e.cardData?.subtypes?.includes('Special Energy')).length, 0),
    attackerAttacksUsedLastTurn: player.attacksUsedLastTurn.filter(e => e.cardId === attacker.id).map(e => e.attackName),
    ownOtherAncientAttackedLastTurn: player.attacksUsedLastTurn.some(e => e.ancient && e.cardId !== attacker.id),
    ownSupporterNamesPlayedThisTurn: [...player.supporterNamesPlayedThisTurn],
    ownDiscardAncientCount: player.discardPile.filter(c => c.cardData.subtypes.includes('Ancient')).length,
    ownHandPokemonTypeCount: new Set(player.hand.filter(c => c.cardData.supertype === 'Pokémon').flatMap(c => c.cardData.types || [])).size,
    attackerRemainingHp: Math.max(0, effectiveMaxHp(G, attacker) - attacker.damage),
    ownStadiumInPlay: G.activeStadium?.owner === attacker.owner,
    ownBenchTypedDamageCounters: player.bench.reduce((acc, c) => {
      if (c) for (const ty of c.cardData.types || []) acc[ty] = (acc[ty] || 0) + c.damage / 10;
      return acc;
    }, {} as Record<string, number>),
    attackerEvolvedThisTurn: player.pokemonPlayedThisTurn.includes(attacker.id),
    ownPlayedAncientSupporter: player.discardPile.some(c => player.supporterNamesPlayedThisTurn.includes(c.cardData.name) && c.cardData.subtypes.includes('Ancient')),
    ownPlayedFutureSupporter: player.discardPile.some(c => player.supporterNamesPlayedThisTurn.includes(c.cardData.name) && c.cardData.subtypes.includes('Future')),
    opponentDiscardItemCount: opponent.discardPile.filter(c => c.cardData.subtypes.includes('Item')).length,
    defenderResistanceTypes: (defender.cardData.resistances || []).map(r => r.type),
    ownFieldDamagedNames: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.damage > 0).map(c => c.cardData.name),
    ownFieldNames: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).map(c => c.cardData.name),
    opponentFieldNames: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).map(c => c.cardData.name),
    ownFieldBasicCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('Basic')).length,
    hasActiveStadium: !!G.activeStadium,
    ownFieldTypeCounts: [player.active, ...player.bench].filter((c): c is GameCard => c !== null).reduce((acc, c) => {
      for (const ty of c.cardData.types || []) acc[ty] = (acc[ty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    opponentFieldEnergyCounts: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).flatMap(c => c.attachedEnergy).reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
    opponentFieldTotalEnergyCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null).reduce((sum, c) => sum + c.attachedEnergy.length, 0),
    opponentExCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('ex')).length,
    opponentExOrVCount: [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && (c.cardData.subtypes.includes('ex') || c.cardData.subtypes.includes('V'))).length,
    ownDamagedBenchCount: ownBench.filter(c => c.damage > 0).length,
    ownFieldDamagedCount: [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.damage > 0).length,
    ownBenchStage2Count: ownBench.filter(c => c.cardData.subtypes.includes('Stage 2')).length,
    ownBenchEnergyHolderCounts: ownBench.reduce((acc, c) => {
      for (const ty of new Set(c.attachedEnergy.map(e => e.type))) acc[ty] = (acc[ty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    attackCostCount: attack.cost.length,
    attackerPromotedFromBenchThisTurn: player.activeIdAtTurnStart !== undefined && player.activeIdAtTurnStart !== attacker.id,
    ownDiscardEnergyCounts: player.discardPile.reduce((acc, c) => {
      if (!c.cardData.subtypes.includes('Basic Energy')) return acc;
      for (const ty of c.cardData.types || []) acc[ty] = (acc[ty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    opponentTakenPrizes: 6 - opponent.prizes.length,
    ownBenchDamageCountersByName: ownBench.map(c => ({ name: c.cardData.name, counters: c.damage / 10 })),
    ownDiscardAbilityCounts: player.discardPile.reduce((acc, c) => {
      for (const a of c.cardData.abilities || []) {
        const n = normalizeAbilityName(a.name);
        acc[n] = (acc[n] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>),
    attackerEnergyCardNames: attacker.attachedEnergy.map(e => e.cardData?.name).filter((n): n is string => !!n),
    opponentBenchDamageCounters: opponent.bench.filter((c): c is GameCard => c !== null).map(c => c.damage / 10),
    defenderAttackNames: (defender.cardData.attacks || []).map(a => a.name),
    defenderIsTera: hasTeraBenchedImmunity(defender) || defender.cardData.name.includes('太晶'),
  };
  return attackBoard;
}

/**
 * Resolves `attack` against the current board and applies every outcome the generic templates
 * can produce: damage (with weakness/resistance and the modifiers), status, healing, energy
 * movement, bench spread, timed effects, and any PendingChoice the text needs.
 *
 * Deliberately free of `ctx`: it neither ends the turn nor knows whose move it is, so a copied
 * attack resolves the same way whether it came from the attacker's own card or another one.
 * moves.attack still owns the Confusion flip, the miss debuff and the turn hand-off.
 */
export function applyAttackOutcome(
  G: PtcgGameState,
  player: PtcgPlayerState,
  opponent: PtcgPlayerState,
  attacker: GameCard,
  defender: GameCard,
  attack: Attack,
  attackBoard: AttackBoardContext,
): void {
  // Re-derived rather than passed in: buildAttackBoard computes the same list, and threading it
  // through would tie the two functions together for no gain.
  const ownBench = player.bench.filter((c): c is GameCard => c !== null);
  const genericOutcome = attack.text ? resolveGenericAttackEffect(attack.text, attack.damage, attackBoard) : undefined;
  if (genericOutcome?.familyScaledDamage) {
    const { name, amount } = genericOutcome.familyScaledDamage;
    const familyCount = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.cardData.name.includes(name)).length;
    genericOutcome.baseDamage = familyCount * amount;
  }
  // Must run here, in the pre-breakdown baseDamage phase: the cost IS the damage source, so
  // the Energy has to be discarded before calculateDamageBreakdown reads baseDamage below.
  if (genericOutcome?.discardOwnFieldTypedEnergyForDamage) {
    const { type, per } = genericOutcome.discardOwnFieldTypedEnergyForDamage;
    let discarded = 0;
    for (const c of [player.active, ...player.bench].filter((x): x is GameCard => x !== null)) {
      for (let i = c.attachedEnergy.length - 1; i >= 0; i--) {
        if (c.attachedEnergy[i].type !== type) continue;
        discardAttachedEnergy(G, G.currentPlayer as 0 | 1, c.attachedEnergy.splice(i, 1)[0]);
        discarded++;
      }
    }
    genericOutcome.baseDamage = discarded * per;
  }
  if (genericOutcome?.discardPileAttackScaledDamage) {
    const { attackName, amount } = genericOutcome.discardPileAttackScaledDamage;
    const matchCount = player.discardPile.filter(c => c.cardData.attacks?.some(a => a.name === attackName)).length;
    genericOutcome.baseDamage = matchCount * amount;
  }
  if (genericOutcome?.ownFieldAttackScaledDamage) {
    const { attackName, amount } = genericOutcome.ownFieldAttackScaledDamage;
    const matchCount = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && !!c.cardData.attacks?.some(a => a.name === attackName)).length;
    genericOutcome.baseDamage = matchCount * amount;
  }
  if (genericOutcome?.ownBenchFamilyScaledDamage) {
    const { name, amount } = genericOutcome.ownBenchFamilyScaledDamage;
    const matchCount = ownBench.filter(c => c.cardData.name.includes(name)).length;
    genericOutcome.baseDamage = matchCount * amount;
  }
  if (genericOutcome?.selfMillFamilyScaledDamage) {
    const { millCount, name, amount } = genericOutcome.selfMillFamilyScaledDamage;
    let matches = 0;
    for (let i = 0; i < millCount && player.deck.length > 0; i++) {
      const milled = player.deck.pop()!;
      if (milled.cardData.name.includes(name)) matches++;
      player.discardPile.push(milled);
    }
    genericOutcome.baseDamage = matches * amount;
  }
  if (genericOutcome?.millBothTopScaledDamage) {
    const { count, per } = genericOutcome.millBothTopScaledDamage;
    let energies = 0;
    for (const [side, idx] of [[player, G.currentPlayer], [opponent, 1 - G.currentPlayer]] as [PtcgPlayerState, number][]) {
      for (const c of millDeck(G, idx as 0 | 1, count, false)) {
        if (c.cardData.supertype === 'Energy') energies++;
      }
      void side;
    }
    genericOutcome.baseDamage += energies * per;
  }
  if (genericOutcome?.attachAllNamedFromHandThenTypedScaled) {
    const { handName, type, per } = genericOutcome.attachAllNamedFromHandThenTypedScaled;
    for (let i = player.hand.length - 1; i >= 0; i--) {
      if (player.hand[i].cardData.name.includes(handName) && player.hand[i].cardData.supertype === 'Energy') {
        attacker.attachedEnergy.push(asAttachedEnergy(player.hand.splice(i, 1)[0]));
      }
    }
    genericOutcome.baseDamage = attacker.attachedEnergy.filter(e => e.type === type).length * per;
  }
  if (genericOutcome?.selfCountersScaledDamage) {
    const { max, per } = genericOutcome.selfCountersScaledDamage;
    // Auto-max without self-KO: place as many as fit while leaving at least 10 HP.
    const room = Math.max(0, Math.floor((effectiveMaxHp(G, attacker) - attacker.damage - 10) / 10));
    const placed = Math.min(max, room);
    attacker.damage += placed * 10;
    genericOutcome.baseDamage = placed * per;
  }
  if (genericOutcome?.selfMillEnergyScaledDamage) {
    const { count, per } = genericOutcome.selfMillEnergyScaledDamage;
    const milled = millDeck(G, G.currentPlayer as 0 | 1, count, false);
    genericOutcome.baseDamage += milled.filter(c => c.cardData.supertype === 'Energy').length * per;
  }
  if (genericOutcome?.familyTypedEnergyScaledBonus) {
    const { family, type, per } = genericOutcome.familyTypedEnergyScaledBonus;
    const n = [player.active, ...player.bench]
      .filter((c): c is GameCard => c !== null && c.cardData.name.includes(family))
      .reduce((sum, c) => sum + c.attachedEnergy.filter(e => e.type === type).length, 0);
    genericOutcome.baseDamage += n * per;
  }
  // The real card leaves "how many/which" up to the player; auto-maximize (discard every
  // matching Energy available, up to any printed cap) rather than opening a PendingChoice —
  // same documented simplification as the rest of this file's choice-requiring templates.
  if (genericOutcome?.selfEnergyDiscardScaledDamage) {
    const { type, max, amount } = genericOutcome.selfEnergyDiscardScaledDamage;
    const eligible = attacker.attachedEnergy.filter(e => !type || e.type === type);
    const toDiscard = eligible.slice(0, max ?? eligible.length);
    for (const e of toDiscard) {
      const idx = attacker.attachedEnergy.findIndex(x => x.id === e.id);
      if (idx >= 0) discardAttachedEnergy(G, attacker.owner, attacker.attachedEnergy.splice(idx, 1)[0]);
    }
    genericOutcome.baseDamage = toDiscard.length * amount;
  }
  if (genericOutcome?.ownFieldEnergyDiscardScaledDamage) {
    const { type, max, amount } = genericOutcome.ownFieldEnergyDiscardScaledDamage;
    let remaining = max ?? Infinity;
    let discarded = 0;
    for (const c of [player.active, ...player.bench]) {
      if (!c || remaining <= 0) continue;
      const eligible = c.attachedEnergy.filter(e => !type || e.type === type).slice(0, remaining);
      for (const e of eligible) {
        const idx = c.attachedEnergy.findIndex(x => x.id === e.id);
        if (idx >= 0) { discardAttachedEnergy(G, c.owner, c.attachedEnergy.splice(idx, 1)[0]); discarded++; remaining--; }
      }
    }
    genericOutcome.baseDamage = discarded * genericOutcome.ownFieldEnergyDiscardScaledDamage.amount;
  }
  if (genericOutcome?.handDiscardScaledDamage) {
    const { filter, max, amount } = genericOutcome.handDiscardScaledDamage;
    const matchesFilter = (c: GameCard) => {
      if (filter.kind === 'anyEnergy') return c.cardData.supertype === 'Energy';
      if (filter.kind === 'energyType') return c.cardData.supertype === 'Energy' && (c.cardData.types || []).includes(filter.type as any);
      return c.cardData.name.includes(filter.name);
    };
    const eligible = player.hand.filter(matchesFilter);
    const toDiscard = eligible.slice(0, max ?? eligible.length);
    for (const c of toDiscard) {
      const idx = player.hand.findIndex(x => x.id === c.id);
      if (idx >= 0) player.discardPile.push(player.hand.splice(idx, 1)[0]);
    }
    genericOutcome.baseDamage = toDiscard.length * amount;
  }
  if (genericOutcome?.selfRevealTopMatchDiscardRestReshuffle) {
    const { revealCount, name, amount } = genericOutcome.selfRevealTopMatchDiscardRestReshuffle;
    const revealed: typeof player.deck = [];
    for (let i = 0; i < revealCount && player.deck.length > 0; i++) revealed.push(player.deck.pop()!);
    let matches = 0;
    for (const c of revealed) {
      if (c.cardData.name.includes(name)) { matches++; player.discardPile.push(c); }
      else player.deck.push(c);
    }
    shuffleDeck(player.deck);
    genericOutcome.baseDamage = matches * amount;
  }
  const effectiveAttack = genericOutcome ? { ...attack, damage: String(genericOutcome.baseDamage) } : attack;
  const damageBreakdown = calculateDamageBreakdown(G, G.currentPlayer as 0 | 1, attacker, effectiveAttack, defender, genericOutcome?.ignoreResistance, genericOutcome?.ignoreWeakness);
  const damage = damageBreakdown.finalDamage;
  const defenderWasFullHp = defender.damage === 0;
  defender.damage += damage;
  addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} 使用「${attack.name}」，對 ${defender.cardData.name} 造成 ${damage} 點傷害`, damageBreakdown, genericOutcome?.coinFlipNote);

  // 警備濁霧 (<火箭隊的>瓦斯彈): taking opponent-attack damage while Active benches up to 2
  // 「瓦斯彈」-named Pokémon from the deck. Auto-picked (no defender-side interactive choice
  // exists mid-attacker-turn — see the KO-trigger note in damage.ts), and it fires on the
  // lethal hit too: the damage was still taken before the holder leaves play.
  if (damage > 0 && hasPassiveAbilityNamed(G, defender, '警備濁霧')) {
    const defenderIdx = (1 - G.currentPlayer) as 0 | 1;
    const dp = G.players[defenderIdx];
    const matches = dp.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('瓦斯彈'));
    let placed = 0;
    for (const card of matches) {
      if (placed >= 2) break;
      const slot = dp.bench.slice(0, benchLimit(G, defenderIdx)).findIndex(s => s === null);
      if (slot === -1) break;
      dp.deck.splice(dp.deck.indexOf(card), 1);
      dp.bench[slot] = card;
      placed++;
    }
    // 「並且重洗牌庫」 — the deck was searched whether or not anything was placed.
    shuffleDeck(dp.deck);
  }

  // 龐克頭盔-style retaliation Tool: damages the attacker back when its holder is hit,
  // regardless of whether the hit also knocked the holder out.
  // 扣殺能量: 2 counters back on the attacker whenever its holder takes attack damage.
  let retaliation = getToolRetaliationDamage(G, defender) + specialEnergyRetaliation(defender);
  // 光之翼: ability-sourced retaliation is an opponent ABILITY's effect on the attacker, so a
  // protected attacker shrugs it off — Tool (龐克頭盔) and Special-Energy (扣殺能量) retaliation
  // above are not ability effects and still land.
  const attackerAbilityImmune = isProtectedFromOpponentAbility(G, attacker);
  if (damage > 0 && !attackerAbilityImmune && hasPassiveAbilityNamed(G, defender, '反擊雞冠')) retaliation += 5;
  if (damage > 0 && !attackerAbilityImmune && (hasPassiveAbilityNamed(G, defender, '自動用武') || hasPassiveAbilityNamed(G, defender, '反擊') || hasPassiveAbilityNamed(G, defender, '反擊針'))) retaliation += 3;
  if (damage > 0 && !attackerAbilityImmune) retaliation += getScaledRetaliation(G, defender);
  // Timed 「受到招式的傷害時…放置N個傷害指示物」 set by the defender's own previous attack.
  if (damage > 0) retaliation += getTimedRetaliationCounters(G, defender);
  // retaliationMirror: 「將與受到的傷害相同數值的傷害指示物」 — counters equal to the damage taken.
  if (damage > 0 && defender.timedEffects?.some(e => e.kind === "retaliationMirror" && e.appliesOnTurn === G.turn)) retaliation += damage / 10;
  if (!attackerAbilityImmune) retaliation += getGrudgeVortexRetaliation(G, defender);
  if (retaliation > 0) {
    attacker.damage += retaliation * 10;
  }
  // 甲殼刺: being hit while Active discards 1 Energy attached to the attacker.
  if (damage > 0 && !attackerAbilityImmune && shouldDiscardAttackerEnergy(G, defender) && attacker.attachedEnergy.length > 0) {
    const removed = attacker.attachedEnergy.splice(Math.floor(Math.random() * attacker.attachedEnergy.length), 1)[0];
    discardAttachedEnergy(G, attacker.owner, removed);
    // This is an ability's discard, not 「招式的效果」 — 回力鏢/燃料【火】 must NOT come back from
    // it, so drop the id from the attack's return record.
    if (G.attackEnergyReturns) {
      const kept = G.attackEnergyReturns.filter(r => r.energyId !== removed.id);
      G.attackEnergyReturns = kept.length > 0 ? kept : null;
    }
  }
  // 炸裂針: only fires if this hit is what KOs the holder.
  if (damage > 0) {
    const defenderHpBefore = effectiveMaxHp(G, defender);
    if (defenderHpBefore > 0 && defender.damage >= defenderHpBefore) {
      const lethalRetaliation = attackerAbilityImmune ? 0 : getLethalOnlyRetaliation(G, defender);
      if (lethalRetaliation > 0) attacker.damage += lethalRetaliation * 10;
    }
  }
  // 毒刺 / 灼熱之軀-style retaliation: being hit while Active poisons/burns the attacker.
  if (damage > 0 && !attackerAbilityImmune && hasPassiveAbilityNamed(G, defender, '毒刺')) {
    attacker.statusConditions = attacker.statusConditions.filter(c => c !== 'Poisoned');
    attacker.statusConditions.push('Poisoned');
  }
  if (damage > 0 && !attackerAbilityImmune && hasPassiveAbilityNamed(G, defender, '灼熱之軀')) {
    attacker.statusConditions = attacker.statusConditions.filter(c => c !== 'Burned');
    attacker.statusConditions.push('Burned');
  }
  // 堅忍之軀: a coin flip may let a Pokémon that would be KO'd by this attack survive at 10 HP instead.
  if (hasPassiveAbilityNamed(G, defender, '堅忍之軀') || hasPassiveAbilityNamed(G, defender, '不朽身軀')) {
    const wouldBeLethal = effectiveMaxHp(G, defender) > 0 && defender.damage >= effectiveMaxHp(G, defender);
    if (wouldBeLethal) {
      const survived = Math.random() < 0.5;
      if (survived) defender.damage = effectiveMaxHp(G, defender) - 10;
      addLog(G, G.currentPlayer, 'ability', `${defender.cardData.name} 擲硬幣${survived ? '正面，以 10 HP 生還' : '反面，未能生還'}`, undefined, survived ? '正面' : '反面');
    }
  }
  // 勤奮之心 / 結實: unconditionally (no coin flip) survives a would-be-lethal hit at 10 HP,
  // but only if it entered this hit at full HP (same text, different cards).
  if ((hasPassiveAbilityNamed(G, defender, '勤奮之心') || hasPassiveAbilityNamed(G, defender, '結實')) && defenderWasFullHp) {
    const wouldBeLethal = effectiveMaxHp(G, defender) > 0 && defender.damage >= effectiveMaxHp(G, defender);
    if (wouldBeLethal) {
      defender.damage = effectiveMaxHp(G, defender) - 10;
      addLog(G, G.currentPlayer, 'ability', `${defender.cardData.name} 特性發動，以 10 HP 生還`);
    }
  }

  const defenderHp = effectiveMaxHp(G, defender);
  if (defender.damage >= defenderHp && defenderHp > 0) {
    handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
    addLog(G, G.currentPlayer, 'ko', `${defender.cardData.name} 昏厥`);
    // 貪婪食客: this Pokémon's own attack KOing an opponent's Basic Pokémon awards 1 extra prize.
    const bonus = getBonusPrizesForAttackKo(G, G.currentPlayer as 0 | 1, attacker, defender);
    for (let i = 0; i < bonus; i++) {
      const prize = player.prizes.pop();
      if (prize) { player.hand.push(prize); player.takenPrizes++; }
    }
  }
  if (retaliation > 0) {
    const attackerHp = effectiveMaxHp(G, attacker);
    if (attacker.damage >= attackerHp && attackerHp > 0) handleKo(G, G.currentPlayer, attacker.id);
  }
  // Generic attack-text side effects: status infliction / opponent-targeted effects are
  // gated on the hit actually landing (damage > 0), matching real rules for "flip a coin, if
  // heads..."-style effects; self-targeted effects (heal, draw, recoil, self-lockout,
  // self-protection) apply regardless, matching their printed text having no damage gate.
  if (genericOutcome) {
    // 「不會受到對手的寶可夢使用招式的效果的影響」 (薄霧/硬岩【鬥】能量, 純樸, 抵抗之幕, 全能硬殼):
    // computed once, gates every defender-targeted NON-damage outcome below. Damage itself is
    // never an "effect" — that's isDamageBlocked's axis.
    const defenderEffectImmune = isImmuneToOpponentAttackEffects(G, defender, attacker);
    if ((damage > 0 || genericOutcome.statusEvenAtZeroDamage) && genericOutcome.statusToInflict && !defenderEffectImmune) {
      for (const status of genericOutcome.statusToInflict) applyStatusCondition(G, defender, status);
    }
    if (genericOutcome.selfStatusToInflict) {
      for (const status of genericOutcome.selfStatusToInflict) applyStatusCondition(G, attacker, status);
    }
    if (genericOutcome.healSelfAmount) attacker.damage = Math.max(0, attacker.damage - genericOutcome.healSelfAmount);
    if (genericOutcome.drawCards) drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.drawCards);
    if (genericOutcome.selfDamage) {
      attacker.damage += genericOutcome.selfDamage;
      const selfHp = effectiveMaxHp(G, attacker);
      if (selfHp > 0 && attacker.damage >= selfHp) handleKo(G, G.currentPlayer, attacker.id);
    }
    if (genericOutcome.discardAllSelfEnergy) {
      for (const energy of attacker.attachedEnergy.splice(0)) discardAttachedEnergy(G, attacker.owner, energy);
    } else if (genericOutcome.discardSelfEnergyCount) {
      // Printed text is "選擇N個...丟棄" (CHOOSE N ... discard) — the player picks which,
      // same as retreat's own energy-cost choice. Only worth asking when there's a real
      // choice (more energy attached than the count needs); otherwise "discard everything
      // attached" isn't actually a decision, so resolve it immediately like retreat does.
      const count = genericOutcome.discardSelfEnergyCount;
      if (attacker.attachedEnergy.length > count) {
        G.pendingChoice = {
          player: G.currentPlayer as 0 | 1,
          effectKey: 'attack_self_energy_discard',
          prompt: `選擇 ${count} 張要丟棄的能量`,
          choiceType: 'select_from_list',
          count,
          options: attacker.attachedEnergy.map(e => ({ id: e.id, label: ENERGY_TYPE_ZH_LABEL[e.type] || e.type })),
          context: { attackerId: attacker.id },
        };
      } else {
        for (const energy of attacker.attachedEnergy.splice(0, count)) discardAttachedEnergy(G, attacker.owner, energy);
      }
    }
    if (damage > 0 && genericOutcome.discardOpponentEnergyCount && !defenderEffectImmune) {
      for (let i = 0; i < genericOutcome.discardOpponentEnergyCount && defender.attachedEnergy.length > 0; i++) {
        const removed = defender.attachedEnergy.splice(Math.floor(Math.random() * defender.attachedEnergy.length), 1)[0];
        discardAttachedEnergy(G, defender.owner, removed);
      }
    }
    if (genericOutcome.discardOpponentTool && defender.attachedTool && !defenderEffectImmune) {
      opponent.discardPile.push(defender.attachedTool);
      defender.attachedTool = null;
    }
    if (genericOutcome.selfTimedEffect) {
      const e = genericOutcome.selfTimedEffect;
      attacker.timedEffects = [...(attacker.timedEffects || []), { kind: e.kind, amount: e.amount, vsSubtype: e.vsSubtype, maxImmuneDamage: e.maxImmuneDamage, attackName: e.attackName, appliesOnTurn: G.turn + e.turnOffset }];
    }
    if (damage > 0 && genericOutcome.opponentTimedEffect && !defenderEffectImmune) {
      const e = genericOutcome.opponentTimedEffect;
      defender.timedEffects = [...(defender.timedEffects || []), { kind: e.kind, amount: e.amount, vsSubtype: e.vsSubtype, maxImmuneDamage: e.maxImmuneDamage, attackName: e.attackName, appliesOnTurn: G.turn + e.turnOffset }];
    }
    // Choice-requiring generic effects (deck search, switches) auto-pick randomly among
    // the valid options — see genericAttacks.ts's file header for why.
    if (genericOutcome.deckSearchBasicPokemonToBenchCount) {
      const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
      let remaining = genericOutcome.deckSearchBasicPokemonToBenchCount;
      while (remaining > 0 && matches.length > 0) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.bench[slot] = player.deck.splice(deckIdx, 1)[0];
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchBasicEnergyToHandCount) {
      const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy'));
      let remaining = genericOutcome.deckSearchBasicEnergyToHandCount;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchSupertypeToHand) {
      // 'Pokémon' is a real supertype; Item/Supporter/Stadium are SUBTYPES of Trainer — the old
      // supertype-only compare made those searches silently find nothing, ever.
      const wanted = genericOutcome.deckSearchSupertypeToHand;
      const matches = player.deck.filter(c => wanted === 'Pokémon'
        ? c.cardData.supertype === 'Pokémon'
        : c.cardData.subtypes.includes(wanted));
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.millOpponentDeckCount) {
      // Via millDeck so 整人擊落 sees an opponent-caused deck discard.
      millDeck(G, (1 - G.currentPlayer) as 0 | 1, genericOutcome.millOpponentDeckCount, true);
    }
    if (genericOutcome.discardRandomOpponentHandCount) {
      for (let i = 0; i < genericOutcome.discardRandomOpponentHandCount && opponent.hand.length > 0; i++) {
        opponent.discardPile.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
      }
    }
    if (genericOutcome.shuffleRandomOpponentHandCardIntoDeck && opponent.hand.length > 0) {
      opponent.deck.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
      shuffleDeck(opponent.deck);
    }
    if (genericOutcome.discardActiveStadium && G.activeStadium) {
      G.players[G.activeStadium.owner].discardPile.push(G.activeStadium);
      G.activeStadium = null;
    }
    // 喵喵ex::夾尾巴逃跑 — the attacker itself bounces to hand after dealing damage. Only
    // meaningful while it is still the Active (a KO from recoil already removed it). Printed
    // text is 「將這隻寶可夢與附加的卡，全部放回手牌」, and "附加的卡" covers the lower Stages
    // stacked underneath, so the whole stack goes to hand — not to the discard pile.
    // 平穩境地: the opponent's 美納斯 pins this side's Pokémon in play — the bounce half of the
    // attack simply doesn't happen (damage already dealt above).
    if (genericOutcome.returnSelfAndAttachmentsToHand && player.active?.id === attacker.id
      && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      for (const energy of attacker.attachedEnergy.splice(0)) {
        if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
      if (attacker.attachedTool) { player.hand.push(attacker.attachedTool); attacker.attachedTool = null; }
      if (attacker.attachedTool2) { player.hand.push(attacker.attachedTool2); attacker.attachedTool2 = null; }
      flushPreEvolutionsTo(attacker, player.hand);
      attacker.damage = 0;
      attacker.statusConditions = [];
      player.hand.push(attacker);
      player.active = null;
      // NOT promoteActiveIfNeeded: that raises a 'ko_promotion' pendingChoice whose
      // resolveChoice branch deliberately does NOT end the turn (correct for its real job —
      // the start-of-turn promotion applyTurnBegin does before the player's turn even
      // begins). Reusing it here left the AI stuck in phase:'attack' with G.pendingChoice
      // cleared but the turn never ended — getLegalMoves offered nothing useful (attacking
      // again needs energy the freshly-promoted Pokémon usually doesn't have yet, and
      // everything else is gated on phase:'main'), so the AI's only remaining legal move was
      // forfeit. Confirmed from a real battle log: opponent KO'd the player's Pokémon with
      // this exact attack, promoted a second Bench Pokémon, then immediately forfeited.
      const benchOptions = player.bench.filter((c): c is GameCard => c !== null);
      if (benchOptions.length === 1) {
        const idx = player.bench.indexOf(benchOptions[0]);
        player.active = benchOptions[0];
        player.bench[idx] = null;
      } else if (benchOptions.length > 1) {
        G.pendingChoice = {
          player: G.currentPlayer as 0 | 1,
          effectKey: 'attack_self_return_promotion',
          prompt: '選擇要上場的備戰寶可夢',
          choiceType: 'select_bench_pokemon',
          count: 1,
          options: benchOptions.map(c => ({ id: c.id, label: c.cardData.name })),
          context: {},
        };
      }
      // benchOptions.length === 0: active stays null — checkAndApplyWin's "no active and no
      // bench" loss condition (checked right after this move returns) handles it from here,
      // same as any other empty-bench-after-KO case.
    }
    if (genericOutcome.selfSwitchToRandomBench) {
      const benchIdxs = player.bench.map((c, i) => c ? i : -1).filter(i => i >= 0);
      if (benchIdxs.length > 0 && player.active) {
        const idx = benchIdxs[Math.floor(Math.random() * benchIdxs.length)];
        const b = player.bench[idx]!;
        clearStatusConditionsOnLeaveActive(player.active);
        player.bench[idx] = player.active;
        player.active = b;
      }
    }
    if (genericOutcome.forceOpponentSwitchToRandomBench) {
      const benchIdxs = opponent.bench.map((c, i) => c ? i : -1).filter(i => i >= 0);
      if (benchIdxs.length > 0 && opponent.active) {
        const idx = benchIdxs[Math.floor(Math.random() * benchIdxs.length)];
        const b = opponent.bench[idx]!;
        clearStatusConditionsOnLeaveActive(opponent.active);
        opponent.bench[idx] = opponent.active;
        opponent.active = b;
      }
    }
    if (genericOutcome.moveSelfEnergyToRandomBench && attacker.attachedEnergy.length > 0) {
      const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
      if (benchTargets.length > 0) {
        const target = benchTargets[Math.floor(Math.random() * benchTargets.length)];
        const i = Math.floor(Math.random() * attacker.attachedEnergy.length);
        target.attachedEnergy.push(attacker.attachedEnergy.splice(i, 1)[0]);
      }
    }
    if (genericOutcome.moveSelfEnergyToRandomBenchCount && attacker.attachedEnergy.length > 0) {
      const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
      if (benchTargets.length > 0) {
        const target = benchTargets[Math.floor(Math.random() * benchTargets.length)];
        for (let i = 0; i < genericOutcome.moveSelfEnergyToRandomBenchCount && attacker.attachedEnergy.length > 0; i++) {
          const idx = Math.floor(Math.random() * attacker.attachedEnergy.length);
          target.attachedEnergy.push(attacker.attachedEnergy.splice(idx, 1)[0]);
        }
      }
    }
    if (genericOutcome.benchSplashDamage) {
      const targets = opponent.bench.filter((c): c is GameCard => c !== null);
      if (targets.length > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        target.damage += genericOutcome.benchSplashDamage;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.selfAllBenchSplashDamage) {
      for (const target of player.bench.filter((c): c is GameCard => c !== null)) {
        target.damage += genericOutcome.selfAllBenchSplashDamage;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, G.currentPlayer, target.id);
      }
    }
    if (genericOutcome.drawToHandSize) drawUpTo(G, G.currentPlayer as 0 | 1, genericOutcome.drawToHandSize);
    if (genericOutcome.healSelfByDamageDealt && damage > 0) attacker.damage = Math.max(0, attacker.damage - damage);
    if (genericOutcome.moveOpponentEnergyToTheirBench && defender.attachedEnergy.length > 0 && !defenderEffectImmune) {
      const benchTargets = opponent.bench.filter((c): c is GameCard => c !== null);
      if (benchTargets.length > 0) {
        const target = benchTargets[Math.floor(Math.random() * benchTargets.length)];
        const i = Math.floor(Math.random() * defender.attachedEnergy.length);
        target.attachedEnergy.push(defender.attachedEnergy.splice(i, 1)[0]);
      }
    }
    if (genericOutcome.shuffleHandThenDrawCount) {
      player.deck.push(...player.hand);
      player.hand = [];
      shuffleDeck(player.deck);
      drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.shuffleHandThenDrawCount);
    }
    if (genericOutcome.deckSearchBasicEnergyToOwnPokemonCount) {
      const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy'));
      const ownTargets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
      if (matches.length > 0 && ownTargets.length > 0) {
        const target = ownTargets[Math.floor(Math.random() * ownTargets.length)];
        let remaining = genericOutcome.deckSearchBasicEnergyToOwnPokemonCount;
        while (remaining > 0 && matches.length > 0) {
          const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
          const deckIdx = player.deck.findIndex(c => c.id === pick.id);
          if (deckIdx >= 0) target.attachedEnergy.push(asAttachedEnergy(pick));
          if (deckIdx >= 0) player.deck.splice(deckIdx, 1);
          remaining--;
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchTypedEnergyToSelfCount) {
      const { type, count } = genericOutcome.deckSearchTypedEnergyToSelfCount;
      const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
      let remaining = count;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) {
          player.deck.splice(deckIdx, 1);
          attacker.attachedEnergy.push(asAttachedEnergy(pick, type));
        }
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchTypedEnergyToAllBenchEach) {
      const type = genericOutcome.deckSearchTypedEnergyToAllBenchEach;
      const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
      for (const target of benchTargets) {
        const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
        if (matches.length === 0) break; // deck ran out of that Energy type — remaining bench slots get nothing
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) {
          player.deck.splice(deckIdx, 1);
          target.attachedEnergy.push(asAttachedEnergy(pick, type));
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchToolToHand) {
      const matches = player.deck.filter(c => c.cardData.subtypes.includes('Pokémon Tool'));
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchTypedPokemonOrEnergyToHand) {
      const { type, count } = genericOutcome.deckSearchTypedPokemonOrEnergyToHand;
      const eligible = player.deck.filter(c =>
        (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes(type as any)) ||
        (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any)));
      for (let n = 0; n < count && eligible.length > 0; n++) {
        const pick = eligible.splice(Math.floor(Math.random() * eligible.length), 1)[0];
        const i = player.deck.findIndex(c => c.id === pick.id);
        if (i >= 0) player.hand.push(player.deck.splice(i, 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchAnyCardToHand) {
      if (player.deck.length > 0) {
        const i = Math.floor(Math.random() * player.deck.length);
        player.hand.push(player.deck.splice(i, 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.discardEnergyToOwnBench) {
      const { type, count } = genericOutcome.discardEnergyToOwnBench;
      const benchTargets = player.bench.filter((c): c is GameCard => c !== null);
      for (let n = 0; n < count && benchTargets.length > 0; n++) {
        const i = player.discardPile.findIndex(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
        if (i < 0) break;
        const energy = player.discardPile.splice(i, 1)[0];
        // spread them around rather than stacking on one Pokémon ("以任意方式")
        benchTargets[n % benchTargets.length].attachedEnergy.push({ id: energy.id, type: type as any, cardData: energy.cardData });
      }
    }
    if (genericOutcome.itemLockOpponentNextTurn) {
      opponent.itemLockedUntilTurn = G.turn + 1;
    }
    if (genericOutcome.evolveSelfFromDeck) {
      const matches = player.deck.filter(c => evolvesFromMatches(c.cardData, attacker.cardData.name));
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        const isActive = player.active?.id === attacker.id;
        const benchIdx = isActive ? -1 : player.bench.findIndex(c => c?.id === attacker.id);
        if (deckIdx >= 0 && (isActive || benchIdx >= 0)) {
          const evolution = player.deck.splice(deckIdx, 1)[0];
          evolution.attachedEnergy = attacker.attachedEnergy;
          evolution.damage = attacker.damage;
          evolution.attachedTool = attacker.attachedTool;
          evolution.attachedTool2 = attacker.attachedTool2;
          stackAsPreEvolution(evolution, attacker);
          if (isActive) player.active = evolution; else player.bench[benchIdx] = evolution;
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchPokemonToHandCount) {
      const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon');
      let remaining = genericOutcome.deckSearchPokemonToHandCount;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.discardPileSearchPokemonToHandCount) {
      const matches = player.discardPile.filter(c => c.cardData.supertype === 'Pokémon');
      let remaining = genericOutcome.discardPileSearchPokemonToHandCount;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const i = player.discardPile.findIndex(c => c.id === pick.id);
        if (i >= 0) {
          const card = player.discardPile.splice(i, 1)[0];
          resetCardForReentry(card, player.discardPile);
          player.hand.push(card);
        }
        remaining--;
      }
    }
    if (genericOutcome.discardPileSearchSupporterToHand) {
      const matches = player.discardPile.filter(c => c.cardData.subtypes.includes('Supporter'));
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const i = player.discardPile.findIndex(c => c.id === pick.id);
        if (i >= 0) player.hand.push(player.discardPile.splice(i, 1)[0]);
      }
    }
    if (genericOutcome.discardPileSearchAnyEnergyToSelf) {
      const matches = player.discardPile.filter(c => c.cardData.supertype === 'Energy');
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        const i = player.discardPile.findIndex(c => c.id === pick.id);
        if (i >= 0) {
          const energy = player.discardPile.splice(i, 1)[0];
          attacker.attachedEnergy.push(asAttachedEnergy(energy));
        }
      }
    }
    if (genericOutcome.millOwnDeckCount) {
      for (let i = 0; i < genericOutcome.millOwnDeckCount && player.deck.length > 0; i++) {
        player.discardPile.push(player.deck.pop()!);
      }
    }
    if (genericOutcome.healRandomOwnDamagedAmount) {
      const damaged = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && c.damage > 0);
      if (damaged.length > 0) {
        const target = damaged[Math.floor(Math.random() * damaged.length)];
        target.damage = Math.max(0, target.damage - genericOutcome.healRandomOwnDamagedAmount);
      }
    }
    if (genericOutcome.deckSearchFamilyToHandCount) {
      const { name, count } = genericOutcome.deckSearchFamilyToHandCount;
      const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
      let remaining = count;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchFamilyToBenchCount) {
      const { name, count } = genericOutcome.deckSearchFamilyToBenchCount;
      const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
      let remaining = count;
      while (remaining > 0 && matches.length > 0) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.bench[slot] = player.deck.splice(deckIdx, 1)[0];
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.discardPileSearchFamilyToBenchCount) {
      const { name, count } = genericOutcome.discardPileSearchFamilyToBenchCount;
      const matches = player.discardPile.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes(name));
      let remaining = count;
      while (remaining > 0 && matches.length > 0) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const i = player.discardPile.findIndex(c => c.id === pick.id);
        if (i >= 0) {
          const card = player.discardPile.splice(i, 1)[0];
          resetCardForReentry(card, player.discardPile);
          player.bench[slot] = card;
        }
        remaining--;
      }
    }
    if (genericOutcome.cureAllSelfStatus) {
      attacker.statusConditions = [];
    }
    if (genericOutcome.healAllOwnTeamAmount) {
      for (const c of [player.active, ...player.bench]) {
        if (c) c.damage = Math.max(0, c.damage - genericOutcome.healAllOwnTeamAmount);
      }
    }
    if (genericOutcome.deckSearchTypedEnergyToOwnPokemonCount) {
      const { type, count } = genericOutcome.deckSearchTypedEnergyToOwnPokemonCount;
      const matches = player.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(type as any));
      const ownTargets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
      if (matches.length > 0 && ownTargets.length > 0) {
        const target = ownTargets[Math.floor(Math.random() * ownTargets.length)];
        let remaining = count;
        while (remaining > 0 && matches.length > 0) {
          const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
          const deckIdx = player.deck.findIndex(c => c.id === pick.id);
          if (deckIdx >= 0) {
            player.deck.splice(deckIdx, 1);
            target.attachedEnergy.push(asAttachedEnergy(pick, type));
          }
          remaining--;
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.placeCountersOnRandomOpponent) {
      const targets = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null);
      if (targets.length > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        target.damage += genericOutcome.placeCountersOnRandomOpponent * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.placeCountersOnOpponentActive && opponent.active) {
      opponent.active.damage += genericOutcome.placeCountersOnOpponentActive * 10;
      const hp = effectiveMaxHp(G, opponent.active);
      if (hp > 0 && opponent.active.damage >= hp) handleKo(G, 1 - G.currentPlayer, opponent.active.id, attacker);
    }
    if (genericOutcome.placeCountersOnAllOpponent) {
      // Same Bench guard as damageToEachDamagedOpponentAmount below: 對戰圓形競技場 stops
      // effect-placed counters from reaching the Bench, leaving only the Active hit.
      const benchBlocked = benchDamageFromEffectsBlocked(G);
      const pool = benchBlocked ? [opponent.active] : [opponent.active, ...opponent.bench];
      for (const target of pool.filter((c): c is GameCard => c !== null)) {
        target.damage += genericOutcome.placeCountersOnAllOpponent * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.splashDamageAfterSwitch && opponent.active) {
      opponent.active.damage += genericOutcome.splashDamageAfterSwitch;
      const hp = effectiveMaxHp(G, opponent.active);
      if (hp > 0 && opponent.active.damage >= hp) handleKo(G, 1 - G.currentPlayer, opponent.active.id, attacker);
    }
    if (genericOutcome.healBenchTypedAmount) {
      const { type, amount } = genericOutcome.healBenchTypedAmount;
      const candidates = ownBench.filter(c => (c.cardData.types || []).includes(type as any));
      if (candidates.length > 0) {
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        target.damage = Math.max(0, target.damage - amount);
      }
    }
    if (genericOutcome.deckSearchTypedPokemonToHandCount) {
      const { type, count } = genericOutcome.deckSearchTypedPokemonToHandCount;
      const matches = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes(type as any));
      let remaining = count;
      while (remaining > 0 && matches.length > 0) {
        const pick = matches.splice(Math.floor(Math.random() * matches.length), 1)[0];
        const deckIdx = player.deck.findIndex(c => c.id === pick.id);
        if (deckIdx >= 0) player.hand.push(player.deck.splice(deckIdx, 1)[0]);
        remaining--;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.damageToEachDamagedOpponentAmount) {
      const benchBlocked = benchDamageFromEffectsBlocked(G);
      const pool = benchBlocked ? [opponent.active] : [opponent.active, ...opponent.bench];
      for (const target of pool.filter((c): c is GameCard => c !== null && c.damage > 0)) {
        target.damage += genericOutcome.damageToEachDamagedOpponentAmount * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.discardHandThenDrawCount) {
      player.discardPile.push(...player.hand.splice(0));
      drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.discardHandThenDrawCount);
    }
    if (genericOutcome.multiTargetOpponentFlatDamage) {
      const { count, amount } = genericOutcome.multiTargetOpponentFlatDamage;
      const benchBlocked = benchDamageFromEffectsBlocked(G);
      const pool = (benchBlocked ? [opponent.active] : [opponent.active, ...opponent.bench]).filter((c): c is GameCard => c !== null);
      const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
      for (const target of picked) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.randomOpponentHandCardToDeckBottom && opponent.hand.length > 0) {
      opponent.deck.unshift(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
    }
    if (genericOutcome.multiTargetOpponentBenchFlatDamage && !benchDamageFromEffectsBlocked(G)) {
      const { count, amount } = genericOutcome.multiTargetOpponentBenchFlatDamage;
      const pool = opponent.bench.filter((c): c is GameCard => c !== null);
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.multiTargetOpponentDamagedBenchFlatDamage && !benchDamageFromEffectsBlocked(G)) {
      const { count, amount } = genericOutcome.multiTargetOpponentDamagedBenchFlatDamage;
      const pool = opponent.bench.filter((c): c is GameCard => c !== null && c.damage > 0);
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.multiTargetSelfBenchFlatDamage) {
      const { count, amount } = genericOutcome.multiTargetSelfBenchFlatDamage;
      const pool = player.bench.filter((c): c is GameCard => c !== null);
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        // Recoil onto own Bench: the KO pays the OPPONENT, so no attacker arg (not their attack).
        if (hp > 0 && target.damage >= hp) handleKo(G, G.currentPlayer, target.id);
      }
    }
    if (damage > 0 && genericOutcome.discardOpponentSpecialEnergyCount && !defenderEffectImmune) {
      for (let i = 0; i < genericOutcome.discardOpponentSpecialEnergyCount; i++) {
        const idx = defender.attachedEnergy.findIndex(e => e.cardData?.subtypes?.includes('Special Energy'));
        if (idx === -1) break;
        discardAttachedEnergy(G, defender.owner, defender.attachedEnergy.splice(idx, 1)[0]);
      }
    }
    // 平穩境地 pins the defender side's attached cards in play, and effect-immunity blocks the
    // detach outright — both gates apply before Energy can go back to the opponent's hand.
    if (genericOutcome.returnOpponentEnergyToHandCount && !defenderEffectImmune
      && !isReturnToHandBlocked(G, (1 - G.currentPlayer) as 0 | 1)) {
      for (let i = 0; i < genericOutcome.returnOpponentEnergyToHandCount && defender.attachedEnergy.length > 0; i++) {
        const [energy] = defender.attachedEnergy.splice(Math.floor(Math.random() * defender.attachedEnergy.length), 1);
        if (energy.cardData) opponent.hand.push({ id: energy.id, cardData: energy.cardData, owner: (1 - G.currentPlayer) as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
    }
    if (genericOutcome.discardSelfTypedEnergy) {
      const { type, count } = genericOutcome.discardSelfTypedEnergy;
      for (let i = 0; i < count; i++) {
        const idx = attacker.attachedEnergy.findIndex(e => e.type === type);
        if (idx === -1) break;
        discardAttachedEnergy(G, attacker.owner, attacker.attachedEnergy.splice(idx, 1)[0]);
      }
    }
    if (genericOutcome.discardPileSearchNamedToSelfCount) {
      const { name, count } = genericOutcome.discardPileSearchNamedToSelfCount;
      for (let i = 0; i < count; i++) {
        const idx = player.discardPile.findIndex(c => c.cardData.name.includes(name));
        if (idx === -1) break;
        const card = player.discardPile[idx];
        if (card.cardData.supertype !== 'Energy') break;
        player.discardPile.splice(idx, 1);
        attacker.attachedEnergy.push(asAttachedEnergy(card));
      }
    }
    if (genericOutcome.deckSearchNamedEnergyAttachCount) {
      const { name, count, benchOnly } = genericOutcome.deckSearchNamedEnergyAttachCount;
      const pool = (benchOnly ? player.bench : [player.active, ...player.bench]).filter((c): c is GameCard => c !== null);
      if (pool.length > 0) {
        for (let i = 0; i < count; i++) {
          const di = player.deck.findIndex(c => c.cardData.name.includes(name) && c.cardData.supertype === 'Energy');
          if (di === -1) break;
          const [card] = player.deck.splice(di, 1);
          pool[Math.floor(Math.random() * pool.length)].attachedEnergy.push(asAttachedEnergy(card));
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchAnyCardsToHandCount) {
      for (let i = 0; i < genericOutcome.deckSearchAnyCardsToHandCount && player.deck.length > 0; i++) {
        player.hand.push(player.deck.splice(Math.floor(Math.random() * player.deck.length), 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.revealTopBenchPokemonCount) {
      const top = player.deck.splice(-genericOutcome.revealTopBenchPokemonCount);
      for (const card of top) {
        const slot = player.bench.findIndex(s => s === null);
        if (card.cardData.supertype === 'Pokémon' && slot !== -1) player.bench[slot] = card;
        else player.deck.push(card);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.opponentNamedFlatDamage) {
      const { name, amount, count, benchOnly } = genericOutcome.opponentNamedFlatDamage;
      const blocked = benchDamageFromEffectsBlocked(G);
      const pool = (benchOnly ? (blocked ? [] : opponent.bench) : (blocked ? [opponent.active] : [opponent.active, ...opponent.bench]))
        .filter((c): c is GameCard => c !== null && c.cardData.name.includes(name));
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.moveNamedBenchDamageToDefender && !defenderEffectImmune) {
      const { name, count } = genericOutcome.moveNamedBenchDamageToDefender;
      const sources = player.bench.filter((c): c is GameCard => c !== null && c.cardData.name.includes(name) && c.damage > 0).slice(0, count);
      let moved = 0;
      for (const s of sources) { moved += s.damage; s.damage = 0; }
      if (moved > 0) {
        defender.damage += moved;
        const hp = effectiveMaxHp(G, defender);
        if (hp > 0 && defender.damage >= hp) handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
      }
    }
    if (genericOutcome.placeCountersOnMultipleOpponents) {
      const { count, counters } = genericOutcome.placeCountersOnMultipleOpponents;
      const blocked = benchDamageFromEffectsBlocked(G);
      const pool = (blocked ? [opponent.active] : [opponent.active, ...opponent.bench]).filter((c): c is GameCard => c !== null);
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += counters * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.setDefenderRemainingHp !== undefined && !defenderEffectImmune) {
      const hp = effectiveMaxHp(G, defender);
      const targetDamage = hp - genericOutcome.setDefenderRemainingHp;
      if (hp > 0 && targetDamage > defender.damage) defender.damage = targetDamage;
    }
    if (genericOutcome.discardPileSearchTypedPokemonToBenchCount) {
      const { type, count } = genericOutcome.discardPileSearchTypedPokemonToBenchCount;
      for (let i = 0; i < count; i++) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const di = player.discardPile.findIndex(c => c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes(type as any));
        if (di === -1) break;
        const [card] = player.discardPile.splice(di, 1);
        resetCardForReentry(card, player.discardPile);
        player.bench[slot] = card;
      }
    }
    if (genericOutcome.discardNamedFromHandCount) {
      const { name, count } = genericOutcome.discardNamedFromHandCount;
      for (let i = 0; i < count; i++) {
        const hi = player.hand.findIndex(c => c.cardData.name.includes(name));
        if (hi === -1) break;
        player.discardPile.push(player.hand.splice(hi, 1)[0]);
      }
    }
    if (genericOutcome.massEvolveBenchFromDeck) {
      const { type } = genericOutcome.massEvolveBenchFromDeck;
      for (let i = 0; i < player.bench.length; i++) {
        const benched = player.bench[i];
        if (!benched) continue;
        if (type && !(benched.cardData.types || []).includes(type as any)) continue;
        const di = player.deck.findIndex(c => c.cardData.supertype === 'Pokémon'
          && evolvesFromMatches(c.cardData, benched.cardData.name));
        if (di === -1) continue;
        const [evo] = player.deck.splice(di, 1);
        evo.attachedEnergy = benched.attachedEnergy;
        evo.attachedTool = benched.attachedTool;
        evo.attachedTool2 = benched.attachedTool2;
        evo.damage = benched.damage;
        evo.statusConditions = benched.statusConditions;
        stackAsPreEvolution(evo, benched);
        player.bench[i] = evo;
        player.pokemonPlayedThisTurn.push(evo.id);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.returnSelfToHandDiscardAttachments && player.active?.id === attacker.id
      && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      // 「寶可夢以外的卡全部丟棄」 — Energy and Tools go to the discard pile; the stacked lower
      // Stages are Pokémon cards and follow the top card to hand.
      for (const energy of attacker.attachedEnergy.splice(0)) discardAttachedEnergy(G, G.currentPlayer as 0 | 1, energy);
      if (attacker.attachedTool) { player.discardPile.push(attacker.attachedTool); attacker.attachedTool = null; }
      if (attacker.attachedTool2) { player.discardPile.push(attacker.attachedTool2); attacker.attachedTool2 = null; }
      flushPreEvolutionsTo(attacker, player.hand);
      attacker.damage = 0;
      attacker.statusConditions = [];
      player.hand.push(attacker);
      player.active = null;
      // Same promotion handling as returnSelfAndAttachmentsToHand below (see its comment).
      const benchOptions = player.bench.filter((c): c is GameCard => c !== null);
      if (benchOptions.length === 1) {
        const idx = player.bench.indexOf(benchOptions[0]);
        player.active = benchOptions[0];
        player.bench[idx] = null;
      } else if (benchOptions.length > 1) {
        G.pendingChoice = {
          player: G.currentPlayer as 0 | 1,
          effectKey: 'attack_self_return_promotion',
          prompt: '選擇一隻備戰寶可夢上場',
          choiceType: 'select_bench_pokemon',
          count: 1,
          options: benchOptions.map(c => ({ id: c.id, label: c.cardData.name })),
          context: {},
        };
      }
    }
    if (genericOutcome.selfProtectNextTurnIfKo) {
      const defenderGone = opponent.active?.id !== defender.id && !opponent.bench.some(c => c?.id === defender.id);
      if (defenderGone) {
        attacker.timedEffects = [...(attacker.timedEffects || []), { kind: 'damageImmune', appliesOnTurn: G.turn + 1 }];
      }
    }
    if (genericOutcome.discardAllOpponentFieldSpecialEnergy) {
      for (const c of [opponent.active, ...opponent.bench]) {
        if (!c) continue;
        for (let i = c.attachedEnergy.length - 1; i >= 0; i--) {
          if (c.attachedEnergy[i].cardData?.subtypes?.includes('Special Energy')) {
            discardAttachedEnergy(G, c.owner, c.attachedEnergy.splice(i, 1)[0]);
          }
        }
      }
    }
    if (genericOutcome.revealTopAttachEnergiesCount) {
      const targets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
      const top = player.deck.splice(-genericOutcome.revealTopAttachEnergiesCount);
      for (const card of top) {
        if (card.cardData.supertype === 'Energy' && targets.length > 0) {
          targets[Math.floor(Math.random() * targets.length)].attachedEnergy.push(asAttachedEnergy(card));
        } else {
          player.deck.push(card);
        }
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.koDefender && !defenderEffectImmune && opponent.active?.id === defender.id) {
      handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
    }
    if (genericOutcome.discardSelfNamedEnergy) {
      const { name, count, thenDiscardDefender } = genericOutcome.discardSelfNamedEnergy;
      let discarded = 0;
      for (let i = attacker.attachedEnergy.length - 1; i >= 0 && discarded < count; i--) {
        if (attacker.attachedEnergy[i].cardData?.name?.includes(name)) {
          discardAttachedEnergy(G, attacker.owner, attacker.attachedEnergy.splice(i, 1)[0]);
          discarded++;
        }
      }
      if (discarded > 0 && thenDiscardDefender) genericOutcome.discardDefenderEntirely = true;
    }
    if (genericOutcome.discardDefenderEntirely && !defenderEffectImmune && opponent.active?.id === defender.id) {
      // 丟棄 ≠ 昏厥: the whole stack goes to the discard pile but NO prizes are taken.
      for (const energy of defender.attachedEnergy.splice(0)) discardAttachedEnergy(G, defender.owner, energy);
      if (defender.attachedTool) { opponent.discardPile.push(defender.attachedTool); defender.attachedTool = null; }
      if (defender.attachedTool2) { opponent.discardPile.push(defender.attachedTool2); defender.attachedTool2 = null; }
      flushPreEvolutionsToDiscard(defender, opponent.discardPile);
      opponent.discardPile.push(defender);
      opponent.active = null; // their own turn-begin promotion refills the spot
    }
    if (genericOutcome.discardSelfEntirely && player.active?.id === attacker.id) {
      for (const energy of attacker.attachedEnergy.splice(0)) discardAttachedEnergy(G, attacker.owner, energy);
      if (attacker.attachedTool) { player.discardPile.push(attacker.attachedTool); attacker.attachedTool = null; }
      if (attacker.attachedTool2) { player.discardPile.push(attacker.attachedTool2); attacker.attachedTool2 = null; }
      flushPreEvolutionsToDiscard(attacker, player.discardPile);
      player.discardPile.push(attacker);
      player.active = null;
      const benchOptions = player.bench.filter((c): c is GameCard => c !== null);
      if (benchOptions.length === 1) {
        const idx = player.bench.indexOf(benchOptions[0]);
        player.active = benchOptions[0];
        player.bench[idx] = null;
      } else if (benchOptions.length > 1) {
        G.pendingChoice = {
          player: G.currentPlayer as 0 | 1,
          effectKey: 'attack_self_return_promotion',
          prompt: '選擇一隻備戰寶可夢上場',
          choiceType: 'select_bench_pokemon',
          count: 1,
          options: benchOptions.map(c => ({ id: c.id, label: c.cardData.name })),
          context: {},
        };
      }
    }
    if (genericOutcome.returnSelfAndAttachmentsToDeck && player.active?.id === attacker.id) {
      for (const energy of attacker.attachedEnergy.splice(0)) {
        if (energy.cardData) player.deck.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
      if (attacker.attachedTool) { player.deck.push(attacker.attachedTool); attacker.attachedTool = null; }
      if (attacker.attachedTool2) { player.deck.push(attacker.attachedTool2); attacker.attachedTool2 = null; }
      flushPreEvolutionsTo(attacker, player.deck);
      attacker.damage = 0;
      attacker.statusConditions = [];
      player.deck.push(attacker);
      shuffleDeck(player.deck);
      player.active = null;
      const benchOptions = player.bench.filter((c): c is GameCard => c !== null);
      if (benchOptions.length === 1) {
        const idx = player.bench.indexOf(benchOptions[0]);
        player.active = benchOptions[0];
        player.bench[idx] = null;
      } else if (benchOptions.length > 1) {
        G.pendingChoice = {
          player: G.currentPlayer as 0 | 1,
          effectKey: 'attack_self_return_promotion',
          prompt: '選擇一隻備戰寶可夢上場',
          choiceType: 'select_bench_pokemon',
          count: 1,
          options: benchOptions.map(c => ({ id: c.id, label: c.cardData.name })),
          context: {},
        };
      }
    }
    if (genericOutcome.attachNamedFromHandHealFull) {
      const { name, benchOnly } = genericOutcome.attachNamedFromHandHealFull;
      const hi = player.hand.findIndex(c => c.cardData.name.includes(name) && c.cardData.supertype === 'Energy');
      const pool = (benchOnly ? player.bench : [player.active, ...player.bench]).filter((c): c is GameCard => c !== null);
      if (hi >= 0 && pool.length > 0) {
        const target = pool[Math.floor(Math.random() * pool.length)];
        target.attachedEnergy.push(asAttachedEnergy(player.hand.splice(hi, 1)[0]));
        target.damage = 0;
      }
    }
    if (genericOutcome.returnAllSelfEnergyToHandBonus && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      for (const energy of attacker.attachedEnergy.splice(0)) {
        if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
    }
    if (genericOutcome.healBenchNamedAmount) {
      const { name, amount } = genericOutcome.healBenchNamedAmount;
      const tagged = name === '古代' ? 'Ancient' : name === '未來' ? 'Future' : null;
      const pool = player.bench.filter((c): c is GameCard => c !== null && c.damage > 0
        && (tagged ? c.cardData.subtypes.includes(tagged as any) : c.cardData.name.includes(name)));
      if (pool.length > 0) {
        const target = pool[Math.floor(Math.random() * pool.length)];
        target.damage = Math.max(0, target.damage - amount);
      }
    }
    if (genericOutcome.shuffleOpponentBenchExceptCount) {
      const { keep } = genericOutcome.shuffleOpponentBenchExceptCount;
      const benched = opponent.bench.map((c, i) => ({ c, i })).filter((x): x is { c: GameCard; i: number } => x.c !== null);
      const doomed = [...benched].sort(() => Math.random() - 0.5).slice(keep);
      for (const { c, i } of doomed) {
        opponent.bench[i] = null;
        if (c.attachedTool) { opponent.deck.push(c.attachedTool); c.attachedTool = null; }
        if (c.attachedTool2) { opponent.deck.push(c.attachedTool2); c.attachedTool2 = null; }
        for (const energy of c.attachedEnergy.splice(0)) {
          if (energy.cardData) opponent.deck.push({ id: energy.id, cardData: energy.cardData, owner: (1 - G.currentPlayer) as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
        flushPreEvolutionsTo(c, opponent.deck);
        opponent.deck.push({ ...c, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, attachedTool2: null, preEvolutions: undefined });
      }
      if (doomed.length > 0) shuffleDeck(opponent.deck);
    }
    if (genericOutcome.discardNamedToDeckCountersOnOpponent) {
      const { name, per } = genericOutcome.discardNamedToDeckCountersOnOpponent;
      const matches: GameCard[] = [];
      for (let i = player.discardPile.length - 1; i >= 0; i--) {
        if (player.discardPile[i].cardData.name.includes(name)) matches.push(player.discardPile.splice(i, 1)[0]);
      }
      if (matches.length > 0) {
        const pool = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null);
        const target = pool[Math.floor(Math.random() * pool.length)];
        if (target) {
          target.damage += matches.length * per * 10;
          const hp = effectiveMaxHp(G, target);
          if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
        }
        player.deck.push(...matches);
        shuffleDeck(player.deck);
      }
    }
    if (genericOutcome.discardPileSearchNamedToHandCount) {
      const { name, count } = genericOutcome.discardPileSearchNamedToHandCount;
      for (let i = 0; i < count; i++) {
        const di = player.discardPile.findIndex(c => c.cardData.name.includes(name));
        if (di === -1) break;
        player.hand.push(player.discardPile.splice(di, 1)[0]);
      }
    }
    if (genericOutcome.devolveOpponentToHandCount && !defenderEffectImmune) {
      for (let i = 0; i < genericOutcome.devolveOpponentToHandCount; i++) {
        const targets = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && (c.preEvolutions?.length ?? 0) > 0);
        if (targets.length === 0) break;
        const target = targets[Math.floor(Math.random() * targets.length)];
        const stack = target.preEvolutions!;
        const prior = stack[stack.length - 1];
        prior.preEvolutions = stack.slice(0, -1);
        prior.attachedEnergy = target.attachedEnergy;
        prior.attachedTool = target.attachedTool;
        prior.attachedTool2 = target.attachedTool2;
        prior.damage = target.damage;
        prior.statusConditions = target.statusConditions;
        if (opponent.active?.id === target.id) opponent.active = prior;
        else {
          const bi = opponent.bench.findIndex(c => c?.id === target.id);
          if (bi >= 0) opponent.bench[bi] = prior;
        }
        opponent.hand.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, attachedTool2: null, preEvolutions: undefined });
      }
    }
    if (genericOutcome.damageAllDamagedBothSidesExceptSelf) {
      const { amount } = genericOutcome.damageAllDamagedBothSidesExceptSelf;
      for (const [side, ownerIdx] of [[player, G.currentPlayer], [opponent, 1 - G.currentPlayer]] as [PtcgPlayerState, number][]) {
        for (const c of [side.active, ...side.bench]) {
          if (!c || c.id === attacker.id || c.damage === 0) continue;
          c.damage += amount;
          const hp = effectiveMaxHp(G, c);
          if (hp > 0 && c.damage >= hp) handleKo(G, ownerIdx as 0 | 1, c.id, ownerIdx === G.currentPlayer ? undefined : attacker);
        }
      }
    }
    if (genericOutcome.opponentDelayedEffect && !defenderEffectImmune && damage >= 0) {
      const e = genericOutcome.opponentDelayedEffect;
      defender.timedEffects = [...(defender.timedEffects || []), { kind: e.kind, amount: e.amount, appliesOnTurn: G.turn + e.turnOffset }];
    }
    if (genericOutcome.selfSwitchToTypedBench && player.active?.id === attacker.id) {
      const { type } = genericOutcome.selfSwitchToTypedBench;
      const idx = player.bench.findIndex(c => c !== null && (c.cardData.types || []).includes(type as any));
      if (idx >= 0) {
        const chosen = player.bench[idx]!;
        clearStatusConditionsOnLeaveActive(player.active);
        player.bench[idx] = player.active;
        player.active = chosen;
      }
    }
    if (genericOutcome.discardOpponentHandItemsAndTools) {
      for (let i = opponent.hand.length - 1; i >= 0; i--) {
        const subs = opponent.hand[i].cardData.subtypes;
        if (subs.includes('Item') || subs.includes('Pokémon Tool')) {
          opponent.discardPile.push(opponent.hand.splice(i, 1)[0]);
        }
      }
    }
    if (genericOutcome.opponentExBenchFlatDamage && !benchDamageFromEffectsBlocked(G)) {
      const { count, amount } = genericOutcome.opponentExBenchFlatDamage;
      const pool = opponent.bench.filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('ex'));
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, count)) {
        target.damage += amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.attachAllBasicEnergyFromHand || genericOutcome.attachNamedFromHandCount) {
      const targets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null);
      const filter = genericOutcome.attachNamedFromHandCount;
      let remaining = filter?.count ?? Infinity;
      for (let i = player.hand.length - 1; i >= 0 && remaining > 0 && targets.length > 0; i--) {
        const c = player.hand[i];
        const eligible = filter
          ? c.cardData.name.includes(filter.name) && c.cardData.supertype === 'Energy'
          : c.cardData.subtypes.includes('Basic Energy');
        if (!eligible) continue;
        targets[Math.floor(Math.random() * targets.length)].attachedEnergy.push(asAttachedEnergy(player.hand.splice(i, 1)[0]));
        remaining--;
      }
    }
    if (genericOutcome.koOpponentBasicCoinSplit) {
      const heads = Math.random() < 0.5;
      if (heads) {
        if (defender.cardData.subtypes.includes('Basic') && !defenderEffectImmune && opponent.active?.id === defender.id) {
          handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
        }
      } else {
        const pool = opponent.bench.filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('Basic'));
        const target = pool[Math.floor(Math.random() * pool.length)];
        if (target) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.winGameIfOnePrizeLeft && player.prizes.length === 1 && G.winner === null) {
      G.winner = G.currentPlayer as 0 | 1;
      G.winReason = '招式效果：獎賞卡剩餘1張時直接獲勝';
    }
    if (genericOutcome.koOpponentWithCountersAtLeast) {
      const { counters } = genericOutcome.koOpponentWithCountersAtLeast;
      const pool = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && c.damage >= counters * 10);
      const target = pool[Math.floor(Math.random() * pool.length)];
      if (target) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
    }
    if (genericOutcome.copyDefenderRandomAttack && opponent.active?.id === defender.id) {
      const candidates = (defender.cardData.attacks || []).filter(a => !/^[‌​\s]*\[特性\]/.test(a.name));
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      // Same re-entry shape as the registered copy-attack handlers: resolve the picked attack
      // against the CURRENT board. Guarded against infinite self-copy by the one-level pick
      // being a printed attack of the DEFENDER (copying a copy attack fizzles on the next level
      // only if the defender also prints one — acceptable; decks like that don't exist).
      if (pick) {
        const subBoard = buildAttackBoard(G, player, opponent, attacker, defender, pick);
        applyAttackOutcome(G, player, opponent, attacker, defender, pick, subBoard);
      }
    }
    if (genericOutcome.damageOwnFamilyAll) {
      const { names, amount } = genericOutcome.damageOwnFamilyAll;
      for (const c of [player.active, ...player.bench]) {
        if (!c || !names.some(n => c.cardData.name.includes(n))) continue;
        c.damage += amount;
        const hp = effectiveMaxHp(G, c);
        if (hp > 0 && c.damage >= hp) handleKo(G, G.currentPlayer, c.id);
      }
    }
    if (genericOutcome.bothDrawCount) {
      drawCards(G, G.currentPlayer as 0 | 1, genericOutcome.bothDrawCount);
      drawCards(G, (1 - G.currentPlayer) as 0 | 1, genericOutcome.bothDrawCount);
    }
    if (genericOutcome.timedImmunityAllOwnFuture) {
      for (const c of [player.active, ...player.bench]) {
        if (!c || !c.cardData.subtypes.includes('Future')) continue;
        c.timedEffects = [...(c.timedEffects || []), { kind: 'damageImmune', vsSubtype: 'ex', appliesOnTurn: G.turn + 1 }];
      }
    }
    if (genericOutcome.timedCantAttackAll) {
      const { side, maxEnergy, turnOffset } = genericOutcome.timedCantAttackAll;
      const pools = side === 'own' ? [player] : [player, opponent];
      for (const p of pools) {
        for (const c of [p.active, ...p.bench]) {
          if (!c) continue;
          if (maxEnergy !== undefined && c.attachedEnergy.length > maxEnergy) continue;
          c.timedEffects = [...(c.timedEffects || []), { kind: 'cantAttack', appliesOnTurn: G.turn + turnOffset }];
        }
      }
    }
    if (genericOutcome.shuffleOwnBenchToDeckCount) {
      for (let n = 0; n < genericOutcome.shuffleOwnBenchToDeckCount; n++) {
        const idx = player.bench.findIndex(c => c !== null);
        if (idx === -1) break;
        const [target] = player.bench.splice(idx, 1, null);
        if (!target) continue;
        if (target.attachedTool) { player.deck.push(target.attachedTool); target.attachedTool = null; }
        if (target.attachedTool2) { player.deck.push(target.attachedTool2); target.attachedTool2 = null; }
        for (const energy of target.attachedEnergy.splice(0)) {
          if (energy.cardData) player.deck.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
        flushPreEvolutionsTo(target, player.deck);
        player.deck.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, attachedTool2: null, preEvolutions: undefined });
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.attachAnyEnergyFromHandToSelfCount) {
      for (let i = 0; i < genericOutcome.attachAnyEnergyFromHandToSelfCount; i++) {
        const hi = player.hand.findIndex(c => c.cardData.supertype === 'Energy');
        if (hi === -1) break;
        attacker.attachedEnergy.push(asAttachedEnergy(player.hand.splice(hi, 1)[0]));
      }
    }
    if (genericOutcome.countersOnAllAbilityHolders) {
      const { counters } = genericOutcome.countersOnAllAbilityHolders;
      for (const [side, ownerIdx] of [[player, G.currentPlayer], [opponent, 1 - G.currentPlayer]] as [PtcgPlayerState, number][]) {
        for (const c of [side.active, ...side.bench]) {
          if (!c || !c.cardData.abilities?.some(a => a.text)) continue;
          c.damage += counters * 10;
          const hp = effectiveMaxHp(G, c);
          if (hp > 0 && c.damage >= hp) handleKo(G, ownerIdx as 0 | 1, c.id, ownerIdx === G.currentPlayer ? undefined : attacker);
        }
      }
    }
    if (genericOutcome.deckSearchBasicEnergyToSelfCount) {
      for (let i = 0; i < genericOutcome.deckSearchBasicEnergyToSelfCount; i++) {
        const di = player.deck.findIndex(c => c.cardData.subtypes.includes('Basic Energy'));
        if (di === -1) break;
        attacker.attachedEnergy.push(asAttachedEnergy(player.deck.splice(di, 1)[0]));
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.benchOpponentHandBasicsCount) {
      for (let i = 0; i < genericOutcome.benchOpponentHandBasicsCount; i++) {
        const slot = opponent.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const hi = opponent.hand.findIndex(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
        if (hi === -1) break;
        opponent.bench[slot] = opponent.hand.splice(hi, 1)[0];
      }
    }
    if (genericOutcome.discardPileSearchTrainerToHandCount) {
      for (let i = 0; i < genericOutcome.discardPileSearchTrainerToHandCount; i++) {
        const di = player.discardPile.findIndex(c => c.cardData.supertype === 'Trainer');
        if (di === -1) break;
        player.hand.push(player.discardPile.splice(di, 1)[0]);
      }
    }
    if (genericOutcome.setAllOpponentBenchRemainingHp !== undefined && !benchDamageFromEffectsBlocked(G)) {
      for (const c of opponent.bench) {
        if (!c) continue;
        const hp = effectiveMaxHp(G, c);
        const targetDamage = hp - genericOutcome.setAllOpponentBenchRemainingHp;
        if (hp > 0 && targetDamage > c.damage) c.damage = targetDamage;
      }
    }
    if (genericOutcome.koBothActives) {
      if (opponent.active?.id === defender.id && !defenderEffectImmune) handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
      if (player.active?.id === attacker.id) handleKo(G, G.currentPlayer, attacker.id);
    }
    if (genericOutcome.discardSelfTool && attacker.attachedTool) {
      player.discardPile.push(attacker.attachedTool);
      attacker.attachedTool = null;
    }
    if (genericOutcome.placeCountersOnRandomOpponentBench && !benchDamageFromEffectsBlocked(G)) {
      const pool = opponent.bench.filter((c): c is GameCard => c !== null);
      const target = pool[Math.floor(Math.random() * pool.length)];
      if (target) {
        target.damage += genericOutcome.placeCountersOnRandomOpponentBench * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.attachOpponentDiscardEnergyToTheirPokemonCount) {
      const targets = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null);
      for (let i = 0; i < genericOutcome.attachOpponentDiscardEnergyToTheirPokemonCount && targets.length > 0; i++) {
        const di = opponent.discardPile.findIndex(c => c.cardData.supertype === 'Energy');
        if (di === -1) break;
        targets[Math.floor(Math.random() * targets.length)].attachedEnergy.push(asAttachedEnergy(opponent.discardPile.splice(di, 1)[0]));
      }
    }
    if (genericOutcome.discardPileTypedEnergyToAllBenchEach) {
      const type = genericOutcome.discardPileTypedEnergyToAllBenchEach;
      for (const c of player.bench) {
        if (!c) continue;
        const di = player.discardPile.findIndex(x => x.cardData.subtypes.includes('Basic Energy') && (x.cardData.types || []).includes(type as any));
        if (di === -1) break;
        c.attachedEnergy.push(asAttachedEnergy(player.discardPile.splice(di, 1)[0]));
      }
    }
    if (genericOutcome.discardOpponentFieldToolsCount) {
      let left = genericOutcome.discardOpponentFieldToolsCount;
      for (const c of [opponent.active, ...opponent.bench]) {
        if (!c || left === 0) continue;
        if (c.attachedTool) { opponent.discardPile.push(c.attachedTool); c.attachedTool = null; left--; }
        if (left > 0 && c.attachedTool2) { opponent.discardPile.push(c.attachedTool2); c.attachedTool2 = null; left--; }
      }
    }
    if (genericOutcome.discardPileNamedToDeckCount) {
      const { name, count } = genericOutcome.discardPileNamedToDeckCount;
      let moved = 0;
      for (let i = player.discardPile.length - 1; i >= 0 && moved < count; i--) {
        if (player.discardPile[i].cardData.name.includes(name)) {
          player.deck.push(player.discardPile.splice(i, 1)[0]);
          moved++;
        }
      }
      if (moved > 0) shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchAnyEnergyToHandCount) {
      for (let i = 0; i < genericOutcome.deckSearchAnyEnergyToHandCount; i++) {
        const di = player.deck.findIndex(c => c.cardData.supertype === 'Energy');
        if (di === -1) break;
        player.hand.push(player.deck.splice(di, 1)[0]);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.takeOwnPrizeCount) {
      for (let i = 0; i < genericOutcome.takeOwnPrizeCount; i++) {
        const prize = player.prizes.pop();
        if (!prize) break;
        player.hand.push(prize);
        player.takenPrizes++;
      }
    }
    if (genericOutcome.deckSearchAnyEnergyToSelfCount) {
      for (let i = 0; i < genericOutcome.deckSearchAnyEnergyToSelfCount; i++) {
        const di = player.deck.findIndex(c => c.cardData.supertype === 'Energy');
        if (di === -1) break;
        attacker.attachedEnergy.push(asAttachedEnergy(player.deck.splice(di, 1)[0]));
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.bothShuffleHandDrawCount) {
      for (const [p, idx] of [[player, G.currentPlayer], [opponent, 1 - G.currentPlayer]] as [PtcgPlayerState, number][]) {
        p.deck.push(...p.hand.splice(0));
        shuffleDeck(p.deck);
        drawCards(G, idx as 0 | 1, genericOutcome.bothShuffleHandDrawCount);
      }
    }
    if (genericOutcome.revealOpponentTopBenchBasicsCount) {
      const top = opponent.deck.splice(-genericOutcome.revealOpponentTopBenchBasicsCount);
      for (const card of top) {
        const slot = opponent.bench.findIndex(s => s === null);
        if (card.cardData.supertype === 'Pokémon' && card.cardData.subtypes.includes('Basic') && slot !== -1) {
          opponent.bench[slot] = card;
        } else {
          opponent.deck.push(card);
        }
      }
      shuffleDeck(opponent.deck);
    }
    if (genericOutcome.gustOpponentBenchThenSplash) {
      const idx = opponent.bench.findIndex(c => c !== null);
      if (idx >= 0 && opponent.active) {
        const chosen = opponent.bench[idx]!;
        clearStatusConditionsOnLeaveActive(opponent.active);
        opponent.bench[idx] = opponent.active;
        opponent.active = chosen;
        chosen.damage += genericOutcome.gustOpponentBenchThenSplash.splash;
        const hp = effectiveMaxHp(G, chosen);
        if (hp > 0 && chosen.damage >= hp) handleKo(G, 1 - G.currentPlayer, chosen.id, attacker);
      }
    }
    if (genericOutcome.deckSearchPokemonToBenchCount) {
      for (let i = 0; i < genericOutcome.deckSearchPokemonToBenchCount; i++) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const di = player.deck.findIndex(c => c.cardData.supertype === 'Pokémon');
        if (di === -1) break;
        player.bench[slot] = player.deck.splice(di, 1)[0];
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.discardPileSearchBasicToBenchCount) {
      for (let i = 0; i < genericOutcome.discardPileSearchBasicToBenchCount; i++) {
        const slot = player.bench.findIndex(s => s === null);
        if (slot === -1) break;
        const di = player.discardPile.findIndex(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
        if (di === -1) break;
        const [card] = player.discardPile.splice(di, 1);
        resetCardForReentry(card, player.discardPile);
        player.bench[slot] = card;
      }
    }
    if (genericOutcome.opponentSpecialEnergyHolderSplash) {
      const blocked = benchDamageFromEffectsBlocked(G);
      const pool = (blocked ? [opponent.active] : [opponent.active, ...opponent.bench])
        .filter((c): c is GameCard => c !== null && c.attachedEnergy.some(e => e.cardData?.subtypes?.includes('Special Energy')));
      const target = pool[Math.floor(Math.random() * pool.length)];
      if (target) {
        target.damage += genericOutcome.opponentSpecialEnergyHolderSplash.amount;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.bothAttachHandBasicsCount) {
      for (const p of [player, opponent] as PtcgPlayerState[]) {
        const targets = [p.active, ...p.bench].filter((c): c is GameCard => c !== null);
        let left = genericOutcome.bothAttachHandBasicsCount;
        for (let i = p.hand.length - 1; i >= 0 && left > 0 && targets.length > 0; i--) {
          if (!p.hand[i].cardData.subtypes.includes('Basic Energy')) continue;
          targets[Math.floor(Math.random() * targets.length)].attachedEnergy.push(asAttachedEnergy(p.hand.splice(i, 1)[0]));
          left--;
        }
      }
    }
    if (genericOutcome.healAllBothSidesAmount) {
      for (const p of [player, opponent] as PtcgPlayerState[]) {
        for (const c of [p.active, ...p.bench]) {
          if (c) c.damage = Math.max(0, c.damage - genericOutcome.healAllBothSidesAmount);
        }
      }
    }
    if (genericOutcome.koAllOpponentRemainingHpAtMost !== undefined) {
      const limit = genericOutcome.koAllOpponentRemainingHpAtMost;
      const victims = [opponent.active, ...opponent.bench]
        .filter((c): c is GameCard => c !== null && effectiveMaxHp(G, c) > 0 && effectiveMaxHp(G, c) - c.damage <= limit);
      for (const v of victims) handleKo(G, 1 - G.currentPlayer, v.id, attacker);
    }
    if (genericOutcome.discardOpponentHandDownTo !== undefined) {
      while (opponent.hand.length > genericOutcome.discardOpponentHandDownTo) {
        opponent.discardPile.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
      }
    }
    if (genericOutcome.discardOpponentTypedEnergy && !defenderEffectImmune) {
      const { type, count } = genericOutcome.discardOpponentTypedEnergy;
      for (let i = 0; i < count; i++) {
        const idx = defender.attachedEnergy.findIndex(e => e.type === type);
        if (idx === -1) break;
        discardAttachedEnergy(G, defender.owner, defender.attachedEnergy.splice(idx, 1)[0]);
      }
    }
    if (genericOutcome.doubleAllOpponentCounters) {
      for (const c of [opponent.active, ...opponent.bench]) {
        if (!c || c.damage === 0) continue;
        c.damage *= 2;
        const hp = effectiveMaxHp(G, c);
        if (hp > 0 && c.damage >= hp) handleKo(G, 1 - G.currentPlayer, c.id, attacker);
      }
    }
    if (genericOutcome.koRandomOpponent) {
      const pool = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null);
      const target = pool[Math.floor(Math.random() * pool.length)];
      if (target) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
    }
    if (genericOutcome.healOneOwnFullHeal) {
      const pool = (genericOutcome.healOneOwnFullHeal.benchOnly ? player.bench : [player.active, ...player.bench])
        .filter((c): c is GameCard => c !== null && c.damage > 0);
      if (pool.length > 0) pool.sort((a, b) => b.damage - a.damage)[0].damage = 0;
    }
    if (genericOutcome.koLowestRemainingHpExceptSelf) {
      const pool = [player.active, ...player.bench, opponent.active, ...opponent.bench]
        .filter((c): c is GameCard => c !== null && c.id !== attacker.id && effectiveMaxHp(G, c) > 0);
      if (pool.length > 0) {
        const target = pool.sort((a, b) => (effectiveMaxHp(G, a) - a.damage) - (effectiveMaxHp(G, b) - b.damage))[0];
        const ownerIdx = target.owner;
        handleKo(G, ownerIdx, target.id, ownerIdx !== G.currentPlayer ? attacker : undefined);
      }
    }
    if (genericOutcome.healAllOwnBasicsAmount) {
      for (const c of [player.active, ...player.bench]) {
        if (c?.cardData.subtypes.includes('Basic')) c.damage = Math.max(0, c.damage - genericOutcome.healAllOwnBasicsAmount);
      }
    }
    if (genericOutcome.returnOwnBenchToHandCount && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      for (let n = 0; n < genericOutcome.returnOwnBenchToHandCount; n++) {
        const idx = player.bench.findIndex(c => c !== null);
        if (idx === -1) break;
        const [target] = player.bench.splice(idx, 1, null);
        if (!target) continue;
        if (target.attachedTool) { player.hand.push(target.attachedTool); target.attachedTool = null; }
        if (target.attachedTool2) { player.hand.push(target.attachedTool2); target.attachedTool2 = null; }
        for (const energy of target.attachedEnergy.splice(0)) {
          if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
        flushPreEvolutionsTo(target, player.hand);
        player.hand.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, attachedTool2: null, preEvolutions: undefined });
      }
    }
    if (genericOutcome.evolveOneFieldFromDeck) {
      for (const c of [player.active, ...player.bench]) {
        if (!c) continue;
        const di = player.deck.findIndex(x => x.cardData.supertype === 'Pokémon' && evolvesFromMatches(x.cardData, c.cardData.name));
        if (di === -1) continue;
        const [evo] = player.deck.splice(di, 1);
        evo.attachedEnergy = c.attachedEnergy;
        evo.attachedTool = c.attachedTool;
        evo.attachedTool2 = c.attachedTool2;
        evo.damage = c.damage;
        evo.statusConditions = c.statusConditions;
        stackAsPreEvolution(evo, c);
        if (player.active?.id === c.id) player.active = evo;
        else {
          const bi = player.bench.findIndex(x => x?.id === c.id);
          if (bi >= 0) player.bench[bi] = evo;
        }
        player.pokemonPlayedThisTurn.push(evo.id);
        break;
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.discardPileSearchAnyToHandCount) {
      for (let i = 0; i < genericOutcome.discardPileSearchAnyToHandCount && player.discardPile.length > 0; i++) {
        player.hand.push(player.discardPile.splice(Math.floor(Math.random() * player.discardPile.length), 1)[0]);
      }
    }
    if (genericOutcome.drawFromBottomCount) {
      for (let i = 0; i < genericOutcome.drawFromBottomCount && player.deck.length > 0; i++) {
        player.hand.push(player.deck.shift()!);
      }
    }
    if (genericOutcome.revealTopPokemonToHandCount) {
      const top = player.deck.splice(-genericOutcome.revealTopPokemonToHandCount);
      for (const card of top) {
        if (card.cardData.supertype === 'Pokémon') player.hand.push(card);
        else player.deck.push(card);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.quadrupleCountersOnOpponents) {
      const pool = [opponent.active, ...opponent.bench].filter((c): c is GameCard => c !== null && c.damage > 0);
      for (const target of [...pool].sort(() => Math.random() - 0.5).slice(0, genericOutcome.quadrupleCountersOnOpponents.count)) {
        target.damage *= 4;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.copyFromOpponentDeckTop) {
      const top = opponent.deck.splice(-genericOutcome.copyFromOpponentDeckTop.count);
      const candidates = top.filter(c => c.cardData.supertype === 'Pokémon')
        .flatMap(c => c.cardData.attacks || [])
        .filter(a => !/^[‌​\s]*\[特性\]/.test(a.name));
      opponent.deck.push(...top);
      shuffleDeck(opponent.deck);
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      if (pick && opponent.active?.id === defender.id) {
        const subBoard = buildAttackBoard(G, player, opponent, attacker, defender, pick);
        applyAttackOutcome(G, player, opponent, attacker, defender, pick, subBoard);
      }
    }
    if (genericOutcome.setBonusPrizeNextKo) {
      player.bonusPrizeNextKo += genericOutcome.setBonusPrizeNextKo;
    }
    if (genericOutcome.opponentTimedEffects && !defenderEffectImmune) {
      for (const e of genericOutcome.opponentTimedEffects) {
        defender.timedEffects = [...(defender.timedEffects || []), { kind: e.kind, amount: e.amount, vsSubtype: e.vsSubtype, maxImmuneDamage: e.maxImmuneDamage, attackName: e.attackName, appliesOnTurn: G.turn + e.turnOffset }];
      }
    }
    if (genericOutcome.discardOpponentStadiumThenLock) {
      if (G.activeStadium && G.activeStadium.owner !== G.currentPlayer) {
        opponent.discardPile.push(G.activeStadium);
        G.activeStadium = null;
        opponent.stadiumLockedUntilTurn = G.turn + 1;
      }
    }
    if (genericOutcome.supporterLockOpponentNextTurn) opponent.supporterLockedUntilTurn = G.turn + 1;
    if (genericOutcome.evolutionLockOpponentNextTurn) opponent.evolutionLockedUntilTurn = G.turn + 1;
    if (genericOutcome.benchBasicFromDeckThenMoveEnergy) {
      const slot = player.bench.findIndex(s => s === null);
      const di = player.deck.findIndex(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
      if (slot !== -1 && di !== -1) {
        const [card] = player.deck.splice(di, 1);
        player.bench[slot] = card;
        const e = attacker.attachedEnergy.pop();
        if (e) card.attachedEnergy.push(e);
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.poisonCounterOverride && genericOutcome.statusToInflict?.includes('Poisoned') && !defenderEffectImmune && damage > 0) {
      // applyStatusCondition (run at the statusToInflict site) resets the override; set it after.
      if (defender.statusConditions.includes('Poisoned')) defender.poisonCounterOverride = genericOutcome.poisonCounterOverride;
    }
    // 死亡終局-style: the printed condition reads the defender's damage counters BEFORE this
    // attack's own damage lands (the pre-attack board snapshot), not after — a live re-read
    // here would compare against the wrong value once this attack's own base damage has
    // already been added a few lines above.
    if (genericOutcome.koDefenderIfDamageCountersEqual && attackBoard.opponentDamageCounters === genericOutcome.koDefenderIfDamageCountersEqual) {
      handleKo(G, 1 - G.currentPlayer, defender.id, attacker);
    }
    if (genericOutcome.opponentBenchDamageScaledSplash) {
      const targets = opponent.bench.filter((c): c is GameCard => c !== null);
      if (targets.length > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        target.damage += (target.damage / 10) * genericOutcome.opponentBenchDamageScaledSplash.multiplier;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
    if (genericOutcome.returnSelfEnergyToHandTypeBonus && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      const { type } = genericOutcome.returnSelfEnergyToHandTypeBonus;
      const idx = attacker.attachedEnergy.findIndex(e => e.type === type);
      if (idx >= 0) {
        const [energy] = attacker.attachedEnergy.splice(idx, 1);
        if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
    }
    if (genericOutcome.optionalEnergyToDeckForBenchDamage && attacker.attachedEnergy.length > 0) {
      const { max, benchDamage } = genericOutcome.optionalEnergyToDeckForBenchDamage;
      let moved = 0;
      for (let i = 0; i < max && attacker.attachedEnergy.length > 0; i++) {
        const [energy] = attacker.attachedEnergy.splice(0, 1);
        if (energy.cardData) player.deck.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        moved++;
      }
      if (moved > 0) {
        shuffleDeck(player.deck);
        const targets = opponent.bench.filter((c): c is GameCard => c !== null);
        if (targets.length > 0) {
          const target = targets[Math.floor(Math.random() * targets.length)];
          target.damage += benchDamage;
          const hp = effectiveMaxHp(G, target);
          if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
        }
      }
    }
    if (genericOutcome.returnSelfEnergyToHandCount && attacker.attachedEnergy.length > 0
      && !isReturnToHandBlocked(G, G.currentPlayer as 0 | 1)) {
      for (let i = 0; i < genericOutcome.returnSelfEnergyToHandCount && attacker.attachedEnergy.length > 0; i++) {
        const idx = Math.floor(Math.random() * attacker.attachedEnergy.length);
        const [energy] = attacker.attachedEnergy.splice(idx, 1);
        if (energy.cardData) player.hand.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
    }
    if (genericOutcome.discardRandomSelfHandCount) {
      for (let i = 0; i < genericOutcome.discardRandomSelfHandCount && player.hand.length > 0; i++) {
        player.discardPile.push(player.hand.splice(Math.floor(Math.random() * player.hand.length), 1)[0]);
      }
    }
    if (genericOutcome.shuffleOpponentBenchToDeckCount) {
      for (let i = 0; i < genericOutcome.shuffleOpponentBenchToDeckCount; i++) {
        const idx = opponent.bench.findIndex(c => c !== null);
        if (idx === -1) break;
        const [target] = opponent.bench.splice(idx, 1, null);
        if (!target) continue;
        if (target.attachedTool) opponent.deck.push(target.attachedTool);
        if (target.attachedTool2) opponent.deck.push(target.attachedTool2);
        for (const energy of target.attachedEnergy.splice(0)) {
          if (energy.cardData) opponent.deck.push({ id: energy.id, cardData: energy.cardData, owner: (1 - G.currentPlayer) as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
        }
        // 「將那隻寶可夢與附加的卡，全部放回對手的牌庫」 (甜甜螢::慢芬香, 仙子伊布::奧密迴旋,
        // 狡猾天狗::驅趕龍捲風…) — an evolved Bench target takes its lower Stages back into the
        // deck with it, so a Stage 2 is not silently stripped down to a one-card return.
        flushPreEvolutionsTo(target, opponent.deck);
        opponent.deck.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, attachedTool2: null, preEvolutions: undefined });
      }
      while (opponent.bench.length < 5) opponent.bench.push(null);
      shuffleDeck(opponent.deck);
    }
    if (genericOutcome.healAllOwnBenchAmount) {
      for (const c of ownBench) c.damage = Math.max(0, c.damage - genericOutcome.healAllOwnBenchAmount);
    }
    if (genericOutcome.flipUntilTailsDiscardOpponentEnergy) {
      let heads = 0;
      for (let i = 0; i < 20 && Math.random() < 0.5; i++) heads++;
      for (let i = 0; i < heads && defender.attachedEnergy.length > 0; i++) {
        const [energy] = defender.attachedEnergy.splice(Math.floor(Math.random() * defender.attachedEnergy.length), 1);
        discardAttachedEnergy(G, (1 - G.currentPlayer) as 0 | 1, energy);
      }
    }
    if (genericOutcome.shuffleAllSelfEnergyToDeck && attacker.attachedEnergy.length > 0) {
      for (const energy of attacker.attachedEnergy.splice(0)) {
        if (energy.cardData) player.deck.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
      shuffleDeck(player.deck);
    }
    if (genericOutcome.deckSearchAnyCardsToTopOfDeck) {
      let remaining = Math.min(genericOutcome.deckSearchAnyCardsToTopOfDeck, player.deck.length);
      const picked: GameCard[] = [];
      while (remaining > 0 && player.deck.length > 0) {
        picked.push(player.deck.splice(Math.floor(Math.random() * player.deck.length), 1)[0]);
        remaining--;
      }
      player.deck.push(...picked);
    }
    if (genericOutcome.shuffleRandomOpponentHandCardsIntoDeckCount) {
      for (let i = 0; i < genericOutcome.shuffleRandomOpponentHandCardsIntoDeckCount && opponent.hand.length > 0; i++) {
        opponent.deck.push(opponent.hand.splice(Math.floor(Math.random() * opponent.hand.length), 1)[0]);
      }
      shuffleDeck(opponent.deck);
    }
    if (genericOutcome.flipCoinsDiscardSelfEnergyByTailsCount) {
      for (let i = 0; i < genericOutcome.flipCoinsDiscardSelfEnergyByTailsCount && attacker.attachedEnergy.length > 0; i++) {
        const [energy] = attacker.attachedEnergy.splice(Math.floor(Math.random() * attacker.attachedEnergy.length), 1);
        discardAttachedEnergy(G, G.currentPlayer as 0 | 1, energy);
      }
    }
    if (genericOutcome.opponentAllBenchSplashDamage && !benchDamageFromEffectsBlocked(G)) {
      for (const target of opponent.bench.filter((c): c is GameCard => c !== null)) {
        target.damage += genericOutcome.opponentAllBenchSplashDamage;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, 1 - G.currentPlayer, target.id, attacker);
      }
    }
  }
}

