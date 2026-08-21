import { Attack, DamageDetail, GameCard } from '@ptcg/shared';
import { PtcgGameState, PtcgPlayerState, PendingChoice } from './GameState';
import { canPlayPokemon, canEvolve, canAttachEnergy, canRetreat, canAttack, effectiveRetreatCost, usableAttacks, FIRST_TURN_SUPPORTER_EXCEPTIONS } from './validation';
import { clearBenchStatusConditions, clearStatusConditionsOnLeaveActive } from './statusConditions';
import { calculateDamageBreakdown, effectiveMaxHp, flushPreEvolutionsTo, flushPreEvolutionsToDiscard, handleKo, prizesForKo, promoteActiveIfNeeded, resetCardForReentry, stackAsPreEvolution, sweepKnockedOut } from './damage';
import { areAbilitiesNegated, getBonusPrizesForAttackKo, getEvolveCountersFromOpponent, getGrudgeVortexRetaliation, getLethalOnlyRetaliation, getRetreatPunishmentCounters, getScaledRetaliation, getCoinFlipAttackMissCoins, hasPassiveAbilityNamed, hasTeraBenchedImmunity, isRetreatBlockedByOpponent, isStadiumPlayBlocked, onEnergyAttachedFromHand, shouldBurnOnOpponentRetreat, shouldConfuseOnOpponentRetreat, shouldDiscardAttackerEnergy, isProtectedFromOpponentAbility, canHoldSecondTool } from './effects/passiveAbilities';
import { benchDamageFromEffectsBlocked, benchLimit, enforceBenchLimit, isStadiumActive, sweepStadiumStatusCures } from './effects/stadiums';
import { getToolRetaliationDamage } from './effects/tools';
import { applyStatusCondition, discardAttachedEnergy, drawCards, drawUpTo, shuffleDeck, asAttachedEnergy } from './effects/primitives';
import { maybeRaiseSensorEnergyBenchChoice, processAttackEnergyReturns, resolveSensorEnergyBench, watchAttackEnergyReturns } from './effects/specialEnergy';
import { AttackBoardContext, resolveGenericAttackEffect } from './effects/genericAttacks';
import { inferEvolvesFromSpecies, evolvesFromMatches } from './evolutionChains';
import { ENERGY_TYPE_ZH_LABEL, addLog, applyAttackOutcome, buildAttackBoard } from './attackResolution';
import { isFossilCard, fossilAsPokemon } from './fossils';
import { canOpenAsSetupActive } from './setup';
import {
  EffectContext, EffectStep,
  hasTrainerEffect, canPlayTrainer, startTrainerEffect, resumeTrainerEffect,
  hasAbilityEffect, startAbilityEffect, resumeAbilityEffect, isAbilityUnlimitedUse, canUseAbility, FROM_HAND_ABILITY_NAMES,
  hasAttackEffect, startAttackEffect, resumeAttackEffect,
  normalizeAbilityName,
} from './effects';

function applyEffectStep(G: PtcgGameState, player: 0 | 1, effectKey: string, step: EffectStep, sourceCardId?: string): void {
  if (step === 'done') {
    G.pendingChoice = null;
  } else {
    // `owner` is always the effect's own seat; `player` is whoever has to answer, which for
    // "the opponent chooses/answers" effects is the other one.
    const { player: answerer, ...rest } = step;
    G.pendingChoice = { player: answerer ?? player, owner: player, effectKey, sourceCardId, ...rest };
  }
}

/** Best-effort card name for an instance id anywhere on the board, for log messages that would
 *  otherwise print a raw id like "SV6a-050_101" to the player. Returns null when the id names
 *  something not in a visible zone (a pending-choice option key, a deck card, a plain string). */
function findCardNameById(G: PtcgGameState, id: string): string | null {
  for (const p of G.players) {
    for (const zone of [p.hand, p.discardPile, p.deck, p.prizes, p.exileZone]) {
      const hit = zone.find(c => c.id === id);
      if (hit) return hit.cardData.name;
    }
    for (const card of [p.active, ...p.bench]) {
      if (!card) continue;
      if (card.id === id) return card.cardData.name;
      if (card.attachedTool?.id === id) return card.attachedTool.cardData.name;
      const e = card.attachedEnergy.find(x => x.id === id);
      if (e?.cardData) return e.cardData.name;
      // Lower Stages stacked under an evolved Pokémon are still real cards a choice can name.
      const pre = card.preEvolutions?.find(x => x.id === id);
      if (pre) return pre.cardData.name;
    }
  }
  return null;
}


/** Executes an already-decided retreat: pays the energy cost (specific ids if given, else the
 * first `retreatCost` attached) and swaps in the given (or first available) bench Pokémon. */
function performRetreat(G: PtcgGameState, targetBenchPosition: number | undefined, discardEnergyIds: string[] | undefined): void {
  const player = G.players[G.currentPlayer];
  const activePokemon = player.active;
  if (!activePokemon) return;

  const retreatCost = effectiveRetreatCost(G, activePokemon);
  if (discardEnergyIds && discardEnergyIds.length > 0) {
    for (const id of discardEnergyIds.slice(0, retreatCost)) {
      const idx = activePokemon.attachedEnergy.findIndex(e => e.id === id);
      if (idx >= 0) discardAttachedEnergy(G, G.currentPlayer as 0 | 1, activePokemon.attachedEnergy.splice(idx, 1)[0]);
    }
  } else {
    for (const energy of activePokemon.attachedEnergy.splice(0, retreatCost)) {
      discardAttachedEnergy(G, G.currentPlayer as 0 | 1, energy);
    }
  }

  let benchIdx = targetBenchPosition ?? -1;
  if (benchIdx < 0 || benchIdx >= 5 || player.bench[benchIdx] === null) {
    benchIdx = player.bench.findIndex(s => s !== null);
  }
  if (benchIdx < 0) return;

  const benchPokemon = player.bench[benchIdx];
  clearStatusConditionsOnLeaveActive(activePokemon);
  player.bench[benchIdx] = player.active;
  player.active = benchPokemon;
  player.retreatedThisTurn = true;
  addLog(G, G.currentPlayer, 'retreat', `撤退，換上 ${benchPokemon!.cardData.name}`);

  // 凹洞: 2 damage counters land on the Pokémon that just retreated (now benched).
  // All three retreat punishments below are opponent ABILITY effects — 光之翼 walks through them.
  const punishCounters = isProtectedFromOpponentAbility(G, activePokemon) ? 0 : getRetreatPunishmentCounters(G, G.currentPlayer as 0 | 1);
  if (punishCounters > 0) {
    activePokemon.damage += punishCounters * 10;
    const hp = effectiveMaxHp(G, activePokemon);
    if (hp > 0 && activePokemon.damage >= hp) handleKo(G, G.currentPlayer, activePokemon.id);
  }
  // 漩渦言靈: the newly promoted Pokémon gets Confused.
  if (shouldConfuseOnOpponentRetreat(G, G.currentPlayer as 0 | 1) && player.active && !isProtectedFromOpponentAbility(G, player.active)) {
    applyStatusCondition(G, player.active, 'Confused');
  }
  // 熔岩地域: the newly promoted Pokémon gets Burned.
  if (shouldBurnOnOpponentRetreat(G, G.currentPlayer as 0 | 1) && player.active && !isProtectedFromOpponentAbility(G, player.active)) {
    applyStatusCondition(G, player.active, 'Burned');
  }
}

/** Plain Active<->Bench swap, no retreat cost — same shape as playTrainer's 'Switch' handling.
 * Used by 衝浪海灘 Stadium's own-turn action. */
function performActiveBenchSwap(G: PtcgGameState, benchIdx: number): void {
  const player = G.players[G.currentPlayer];
  if (!player.active || !player.bench[benchIdx]) return;
  const benchPokemon = player.bench[benchIdx];
  clearStatusConditionsOnLeaveActive(player.active);
  player.bench[benchIdx] = player.active;
  player.active = benchPokemon;
}

/** After every human Active is placed: raise the next queued mulligan compensation (one at a
 * time — local 2P can owe BOTH sides), or, once the queue is empty, hand turn 1 to the coin
 * flip's decided first player. */
function raiseNextMulliganBonusOrFinish(G: PtcgGameState): void {
  const entry = G.pendingMulliganBonuses?.shift();
  if (entry) {
    G.currentPlayer = entry.player;
    G.pendingChoice = {
      player: entry.player,
      effectKey: 'mulligan_bonus',
      prompt: `對手重抽懲罰補償：選擇補抽張數（最多 ${entry.max} 張）`,
      choiceType: 'select_from_list',
      count: 1,
      options: Array.from({ length: entry.max + 1 }, (_, i) => ({ id: String(i), label: `補抽 ${i} 張` })),
      context: {},
    };
    return;
  }
  if (G.firstPlayer !== undefined) G.currentPlayer = G.firstPlayer;
}

/**
 * Snapshot of everything the generic attack templates can ask about the board.
 *
 * Extracted from moves.attack together with applyAttackOutcome below so an attack can be
 * resolved for a Pokemon OTHER than the one whose turn it is — 「選擇1個…持有的招式，作為這個
 * 招式使用」 cards (呆呆王 耀閃挑戰, N的索羅亞克ex 暗黑底牌, 火箭隊的謎擬Q 扮晶晶酒) need exactly
 * that, and while this logic lived inline they were unimplementable.
 */
const rawMoves = {
  /** The coin-flip winner (an interactive player — AI winners decide in setup) picks first/second. */
  chooseFirst: ({ G, ctx }: { G: PtcgGameState; ctx: any }, goFirst: boolean) => {
    if (G.phase !== 'choose_first') return;
    const chooser = parseInt(ctx.currentPlayer) as 0 | 1;
    if (G.coinWinner !== chooser) return;
    G.firstPlayer = goFirst ? chooser : ((1 - chooser) as 0 | 1);
    G.phase = 'choose_active';
    addLog(G, chooser, 'choose_first', goFirst ? '選擇先攻' : '選擇後攻');
    // Next actor: the first human seat without an Active (the chooser itself in vs-AI;
    // seat order 0 -> 1 in local 2P).
    const next = (G.interactivePlayers ?? []).find(p => !G.players[p].active);
    if (next !== undefined) G.currentPlayer = next;
  },

  chooseActive: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    if (G.phase !== 'choose_active') return;
    const player = G.players[parseInt(ctx.currentPlayer) as 0 | 1];
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const card = player.hand[idx];
    // Basic, or a 瞬間爆發力 card — the one non-Basic real rules allow as the opening Active.
    if (!canOpenAsSetupActive(card)) return;

    player.hand.splice(idx, 1);
    player.active = card;
    addLog(G, parseInt(ctx.currentPlayer), 'choose_active', `將 ${card.cardData.name} 放置為戰鬥寶可夢`);
    // Local 2P: the other human seat may still need to place its Active — hand the phase over.
    const next = (G.interactivePlayers ?? []).find(p => !G.players[p].active);
    if (next !== undefined) {
      G.currentPlayer = next;
      return; // phase stays 'choose_active'
    }
    // Every Active is placed — deferred mulligan compensations resolve one at a time before
    // turn 1; once the queue is empty the coin flip's decided first player takes over. When
    // that's the AI, humanBattle's move endpoint sees currentPlayer === 1 and runs its turn.
    G.phase = 'draw';
    raiseNextMulliganBonusOrFinish(G);
  },

  drawCard: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    if (G.phase !== 'draw') return;
    if (G.currentPlayer !== parseInt(ctx.currentPlayer)) return;

    const player = G.players[G.currentPlayer];

    if (player.deck.length === 0) {
      // Deck-out: one of the three standard ways to lose. This must be decided HERE, not left
      // for a caller to notice afterward — every engine's post-move win-check only ever looks
      // at G.winner directly (all four gate on `if (G.winner !== null) return true/G.winner`
      // as their first line), and none of them re-derive "was this a failed draw" from G.phase,
      // since by the time any of them run, G.phase has already moved on to 'main' below.
      G.winner = (1 - G.currentPlayer) as 0 | 1;
      G.winReason = 'deck empty at draw';
      addLog(G, G.currentPlayer, 'draw_card', '牌庫已空，無法抽牌');
      G.phase = 'main';
      return;
    }

    const card = player.deck.pop()!;
    player.hand.push(card);
    G.phase = 'main';
    addLog(G, G.currentPlayer, 'draw_card', `抽到 ${card.cardData.name}`);
  },

  playPokemon: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, benchPosition?: number) => {
    if (!canPlayPokemon(G, G.currentPlayer, cardId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const card = player.hand.splice(cardIndex, 1)[0];
    // Fossils are printed as Trainer/Item cards — swap in the Pokémon-shaped view (see
    // fossils.ts) only for the copy that actually enters play; a card search/discard effect
    // that later looks at this same card in the discard pile still sees the real Item card.
    if (isFossilCard(card.cardData)) card.cardData = fossilAsPokemon(card.cardData);
    // 零之大空洞 can raise this player's limit to 8; the bench array is created at the default
    // size, so grow it to match before looking for a slot.
    const limit = benchLimit(G, G.currentPlayer as 0 | 1);
    while (player.bench.length < limit) player.bench.push(null);
    let pos = benchPosition;
    if (pos === undefined || pos < 0 || pos >= limit || player.bench[pos] !== null) {
      pos = player.bench.findIndex(s => s === null);
    }
    if (pos === -1 || pos >= limit) {
      player.hand.push(card);
      return;
    }

    player.bench[pos] = card;
    player.cardsPlayedThisTurn++;
    player.basicPokemonPlayedThisTurn++;
    player.pokemonPlayedThisTurn.push(card.id);
    addLog(G, G.currentPlayer, 'play_pokemon', `將 ${card.cardData.name} 放置於備戰區`);

    // 險惡廢墟 Stadium: every Basic Pokémon (except Darkness-type) placed on the Bench takes 2
    // damage counters immediately, including a freshly-played one — so this can KO on arrival.
    if (isStadiumActive(G, '險惡廢墟') && card.cardData.subtypes.includes('Basic') && !(card.cardData.types || []).includes('Darkness')) {
      card.damage += 20;
      const hp = effectiveMaxHp(G, card);
      if (hp > 0 && card.damage >= hp) handleKo(G, G.currentPlayer, card.id);
    }
  },

  evolvePokemon: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, targetId: string) => {
    if (!canEvolve(G, G.currentPlayer, cardId, targetId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const evolution = player.hand.splice(cardIndex, 1)[0];

    const isActive = player.active?.id === targetId;
    const benchIdx = isActive ? -1 : player.bench.findIndex(c => c?.id === targetId);
    if (!isActive && benchIdx === -1) {
      player.hand.push(evolution);
      return;
    }

    const oldCard = isActive ? player.active! : player.bench[benchIdx]!;
    const savedEnergy = oldCard.attachedEnergy;
    const savedDamage = oldCard.damage;
    const savedTool = oldCard.attachedTool;
    const savedTool2 = oldCard.attachedTool2;
    // Note: status conditions (Asleep/Paralyzed/Confused/Poisoned/Burned) are cured on evolution per real rules, not carried over.

    stackAsPreEvolution(evolution, oldCard);

    if (isActive) {
      player.active = evolution;
    } else {
      player.bench[benchIdx] = evolution;
    }

    evolution.attachedEnergy = savedEnergy;
    evolution.damage = savedDamage;
    evolution.attachedTool = savedTool;
    evolution.attachedTool2 = savedTool2;
    player.cardsPlayedThisTurn++;
    // Without this, canEvolve()'s "already evolved/played this turn" check never sees the new
    // card's id, so a Pokémon that just evolved could illegally evolve again the same turn
    // (e.g. Basic -> Stage 1 -> Stage 2 in one turn) whenever the next evolution card was in hand.
    player.pokemonPlayedThisTurn.push(evolution.id);
    addLog(G, G.currentPlayer, 'evolve', `進化成 ${evolution.cardData.name}`);

    // 黑暗脈衝: the opponent's ability may place 4 damage counters on the newly evolved Pokémon.
    const evolveCounters = isProtectedFromOpponentAbility(G, evolution) ? 0 : getEvolveCountersFromOpponent(G, G.currentPlayer as 0 | 1);
    if (evolveCounters > 0) {
      evolution.damage += evolveCounters * 10;
      const hp = effectiveMaxHp(G, evolution);
      if (hp > 0 && evolution.damage >= hp) handleKo(G, G.currentPlayer, evolution.id);
    }
  },

  attachEnergy: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string, targetId: string) => {
    if (!canAttachEnergy(G, G.currentPlayer, cardId, targetId)) return;

    const player = G.players[G.currentPlayer];
    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const energyCard = player.hand.splice(cardIndex, 1)[0];

    const target = player.active?.id === targetId
      ? player.active
      : player.bench.find(c => c?.id === targetId);
    if (!target) {
      player.hand.push(energyCard);
      return;
    }

    const energyType = energyCard.cardData.types?.[0] || 'Colorless';
    target.attachedEnergy.push({
      id: energyCard.id,
      type: energyType,
      cardData: energyCard.cardData,
    });
    onEnergyAttachedFromHand(G, G.currentPlayer as 0 | 1, target, energyCard);
    // 「每次對手從手牌將能量卡附於受到這個招式的寶可夢身上時，在那隻寶可夢身上放置N個傷害指示物」
    for (const e of target.timedEffects ?? []) {
      if (e.kind === 'attachPunishCounters' && e.appliesOnTurn === G.turn) {
        target.damage += (e.amount ?? 0) * 10;
        const hp = effectiveMaxHp(G, target);
        if (hp > 0 && target.damage >= hp) handleKo(G, G.currentPlayer, target.id);
      }
    }
    // 祭典會場: this Pokémon now has Energy, so any Condition already on it is cured.
    sweepStadiumStatusCures(G);

    player.energyAttachedThisTurn++;
    player.cardsPlayedThisTurn++;
    addLog(G, G.currentPlayer, 'attach_energy', `將 ${energyCard.cardData.name} 附加於 ${target.cardData.name}`);
    // 感應【超】能量: attaching it from hand onto a 【超】 Pokémon opens a deck search.
    maybeRaiseSensorEnergyBenchChoice(G, G.currentPlayer as 0 | 1, target, energyCard);
  },

  playTrainer: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    const player = G.players[G.currentPlayer];
    if (G.phase !== 'main') return;
    if (G.currentPlayer !== parseInt(ctx.currentPlayer)) return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const trainerCard = player.hand.splice(cardIndex, 1)[0];
    if (trainerCard.cardData.supertype !== 'Trainer') {
      player.hand.push(trainerCard);
      return;
    }

    const isSupporter = trainerCard.cardData.subtypes.includes('Supporter');
    const firstTurnBlocked = G.turn === 1 && !FIRST_TURN_SUPPORTER_EXCEPTIONS.has(trainerCard.cardData.name);
    if (isSupporter && (player.supporterPlayedThisTurn || firstTurnBlocked)) {
      player.hand.push(trainerCard);
      return;
    }
    if (G.pendingChoice) {
      player.hand.push(trainerCard);
      return;
    }

    const cardName = trainerCard.cardData.name;
    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: trainerCard.id };

    // Belt-and-braces re-check of the handler's canPlay gate — getLegalMoves already filters
    // these out, but playTrainer is reachable from paths that never consulted it. An unplayable
    // card goes straight back to hand consuming nothing: no discard, no cardsPlayedThisTurn,
    // and (returning before the isSupporter bookkeeping below) no supporter slot.
    if (!canPlayTrainer(cardName, ctxInfo)) {
      player.hand.push(trainerCard);
      return;
    }

    // Stadium cards enter a shared field slot instead of the discard pile; only one is in play
    // at a time — playing a new one discards whichever was there (to its own owner's pile).
    if (trainerCard.cardData.subtypes.includes('Stadium') && !hasTrainerEffect(cardName)) {
      // 爆大身軀: refund, same shape as the canPlayTrainer bail-out above — validation already
      // hides the move, but playTrainer is reachable from paths that never consulted it.
      if (isStadiumPlayBlocked(G, G.currentPlayer as 0 | 1)) {
        player.hand.push(trainerCard);
        return;
      }
      if (G.activeStadium) {
        const ownerIdx = G.activeStadium.owner;
        G.players[ownerIdx].discardPile.push(G.activeStadium);
      }
      G.activeStadium = trainerCard;
      // 祭典會場's cure half applies the moment it hits the field, to Pokémon already Conditioned.
      sweepStadiumStatusCures(G);
      // 零之大空洞 leaving (or arriving) changes both sides' Bench limits immediately.
      enforceBenchLimit(G, flushPreEvolutionsTo);
      // A Stadium arriving or leaving can move max HP (激動競技場 +30 to Basics, 引力山岳 -30 to
      // Stage 2s), so re-check for Pokémon the change has just pushed past their ceiling.
      sweepKnockedOut(G);
      player.cardsPlayedThisTurn++;
      addLog(G, G.currentPlayer, 'play_trainer', `使出競技場「${cardName}」`);
      return;
    }

    // Pokémon Tool cards attach persistently instead of resolving once and going to discard.
    if (trainerCard.cardData.subtypes.includes('Pokémon Tool') && !hasTrainerEffect(cardName)) {
      // 多重轉接: a 洛托姆-named Pokémon with the permission active may take a second Tool.
      const targets = [player.active, ...player.bench].filter((c): c is GameCard => c !== null
        && (!c.attachedTool || (!c.attachedTool2 && canHoldSecondTool(G, c))));
      if (targets.length === 0) { player.hand.push(trainerCard); return; }
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'tool_attach',
        prompt: `選擇要附加 ${cardName} 的寶可夢`,
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { toolCard: trainerCard },
      };
      player.cardsPlayedThisTurn++;
      addLog(G, G.currentPlayer, 'play_trainer', `使出「${cardName}」（附加中）`);
      return;
    }

    if (hasTrainerEffect(cardName)) {
      const step = startTrainerEffect(cardName, ctxInfo);
      applyEffectStep(G, G.currentPlayer as 0 | 1, `trainer:${cardName}`, step, trainerCard.id);
    } else if (cardName.includes('Professor') && cardName.includes('Research')) {
      player.discardPile.push(...player.hand);
      player.hand = [];
      for (let i = 0; i < 7; i++) {
        if (player.deck.length === 0) break;
        player.hand.push(player.deck.pop()!);
      }
    } else if (cardName === 'Switch') {
      if (!player.active || !player.bench.some(s => s !== null)) {
        player.hand.push(trainerCard);
        return;
      }
      const benchIdx = player.bench.findIndex(s => s !== null);
      const benchPokemon = player.bench[benchIdx];
      clearStatusConditionsOnLeaveActive(player.active);
      player.bench[benchIdx] = player.active;
      player.active = benchPokemon;
    }

    player.discardPile.push(trainerCard);
    player.cardsPlayedThisTurn++;
    if (isSupporter) {
      player.supporterPlayedThisTurn = true;
      player.supporterNamesPlayedThisTurn.push(cardName);
    }
    addLog(G, G.currentPlayer, 'play_trainer', `使出「${cardName}」`);
  },

  useAbility: ({ G, ctx }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    if (G.pendingChoice) return;
    const player = G.players[G.currentPlayer];
    // 緊急迴轉/激動俯衝: abilities printed 「若手牌有這張卡」 resolve from the HAND — the only
    // names the hand fallback accepts (any other hand card's ability stays unusable from there).
    const inPlaySource = player.active?.id === cardId ? player.active : player.bench.find(c => c?.id === cardId);
    const source = inPlaySource
      ?? player.hand.find(c => c.id === cardId && (c.cardData.abilities || []).some(a => a.text && FROM_HAND_ABILITY_NAMES.has(normalizeAbilityName(a.name))));
    if (!source) return;
    const ability = source.cardData.abilities?.find(a => hasAbilityEffect(normalizeAbilityName(a.name)));
    if (!ability) return;
    // 暗夜羽擊: an Active facing the opponent's 暗夜羽擊 Active has all its abilities negated.
    // Hand cards are exempt on purpose — negation effects read 「場上」.
    if (inPlaySource && areAbilitiesNegated(G, source)) return;
    const name = normalizeAbilityName(ability.name);
    if (player.abilitiesUsedThisTurn.includes(source.id) && !isAbilityUnlimitedUse(name)) return;

    const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: source.id };
    // Belt-and-braces re-check of the handler's own gate — getLegalMoves already filters these
    // out, but useAbility is reachable from paths that never consulted it. Returning here (rather
    // than letting start() bail out below) is what keeps the once-per-turn use unspent.
    if (!canUseAbility(name, ctxInfo)) return;
    const step = startAbilityEffect(name, ctxInfo);
    applyEffectStep(G, G.currentPlayer as 0 | 1, `ability:${name}`, step, source.id);
    // An unlimited-use ability that immediately resolves to 'done' (no interactive step at all)
    // had nothing left to do this call — e.g. excitedTurbine with no energy/targets left. Without
    // marking it used here too, getLegalMoves keeps offering the same always-legal no-op move
    // forever, since alreadyUsed is never true for unlimited-use abilities otherwise. Left
    // unguarded, an AI whose heuristic keeps re-picking that no-op spins until the turn-level
    // safety cap in humanBattle.ts/battleRunner.ts — for ClaudeAI that's hundreds of sequential
    // API calls, which reads to the human opponent as the game just hanging/timing out.
    if (!isAbilityUnlimitedUse(name) || step === 'done') player.abilitiesUsedThisTurn.push(source.id);
    addLog(G, G.currentPlayer, 'use_ability', `${source.cardData.name} 使用特性「${ability.name}」`);
  },

  /** Once-per-own-turn Stadium field actions (see validation.ts's getLegalMoves for the
   * eligibility check this mirrors) — `effectKey` picks which Stadium's behavior to run. Opens a
   * pendingChoice for whatever the player needs to pick; stadiumActionUsedThisTurn is set once
   * resolveChoice actually finishes the effect, not here, same as how useAbility only marks
   * abilitiesUsedThisTurn after a real effect (not a rejected/no-op attempt). */
  useStadiumAction: ({ G }: { G: PtcgGameState; ctx: any }, effectKey: string) => {
    if (G.phase !== 'main' || G.pendingChoice) return;
    const player = G.players[G.currentPlayer];
    if (player.stadiumActionUsedThisTurn) return;

    if (effectKey === 'prism_tower_draw') {
      if (!isStadiumActive(G, '稜鏡塔') || player.hand.length < 2) return;
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'stadium:prism_tower_draw',
        prompt: '稜鏡塔：選擇要丟棄的 2 張手牌',
        choiceType: 'select_hand_cards',
        count: 2,
        options: player.hand.map(c => ({ id: c.id, label: c.cardData.name })),
        context: {},
      };
    }

    if (effectKey === 'mystery_garden_draw') {
      const energyOptions = player.hand.filter(c => c.cardData.supertype === 'Energy');
      if (!isStadiumActive(G, '神秘花園') || energyOptions.length === 0) return;
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'stadium:mystery_garden_draw',
        prompt: '神秘花園：選擇要丟棄的 1 張能量卡',
        choiceType: 'select_from_list',
        count: 1,
        options: energyOptions.map(c => ({ id: c.id, label: c.cardData.name })),
        context: {},
      };
    }

    if (effectKey === 'spike_town_gym_search') {
      const options = player.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('瑪俐的'));
      if (!isStadiumActive(G, '尖釘鎮道館') || options.length === 0) return;
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'stadium:spike_town_gym_search',
        prompt: '尖釘鎮道館：從牌庫選 1 張「瑪俐的寶可夢」加入手牌',
        choiceType: 'select_from_list',
        count: 1,
        options: options.map(c => ({ id: c.id, label: c.cardData.name })),
        context: {},
      };
    }

    if (effectKey === 'night_school_topdeck') {
      if (!isStadiumActive(G, '夜間學院') || player.hand.length === 0) return;
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'stadium:night_school_topdeck',
        prompt: '夜間學院：選擇 1 張手牌放回牌庫上方',
        choiceType: 'select_hand_cards',
        count: 1,
        options: player.hand.map(c => ({ id: c.id, label: c.cardData.name })),
        context: {},
      };
    }

    if (effectKey === 'surf_beach_swap') {
      if (!isStadiumActive(G, '衝浪海灘') || !player.active || !(player.active.cardData.types || []).includes('Water')) return;
      const waterBench = player.bench
        .map((c, i) => ({ c, i }))
        .filter((x): x is { c: GameCard; i: number } => x.c !== null && (x.c.cardData.types || []).includes('Water'));
      if (waterBench.length === 0) return;
      if (waterBench.length === 1) {
        performActiveBenchSwap(G, waterBench[0].i);
        player.stadiumActionUsedThisTurn = true;
        addLog(G, G.currentPlayer, 'resolve_choice', `衝浪海灘：與 ${waterBench[0].c.cardData.name} 互換`);
        return;
      }
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'stadium:surf_beach_swap',
        prompt: '衝浪海灘：選擇要與戰鬥場互換的【水】寶可夢',
        choiceType: 'select_bench_pokemon',
        count: 1,
        options: waterBench.map(({ c }) => ({ id: c.id, label: c.cardData.name })),
        context: {},
      };
    }

    if (effectKey === 'rocket_factory_draw') {
      if (!isStadiumActive(G, '火箭隊的工廠') || !player.supporterNamesPlayedThisTurn.some(n => n.includes('火箭隊'))) return;
      drawCards(G, G.currentPlayer as 0 | 1, 2);
      player.stadiumActionUsedThisTurn = true;
      addLog(G, G.currentPlayer, 'resolve_choice', '火箭隊的工廠：抽 2 張卡');
      return;
    }

    if (effectKey === 'resident_hall_heal') {
      if (!isStadiumActive(G, '居民會館') || !player.supporterPlayedThisTurn) return;
      for (const c of [player.active, ...player.bench]) {
        if (c) c.damage = Math.max(0, c.damage - 10);
      }
      player.stadiumActionUsedThisTurn = true;
      addLog(G, G.currentPlayer, 'resolve_choice', '居民會館：自己的所有寶可夢各恢復 10 HP');
      return;
    }
  },

  resolveChoice: ({ G, ctx }: { G: PtcgGameState; ctx: any }, selection: string[]) => {
    if (!G.pendingChoice) return;
    // A pendingChoice belongs to whoever it names, which is NOT always the player whose turn it
    // is — "the opponent chooses" effects raise one against the other seat. Everything below acts
    // for `chooser` rather than G.currentPlayer for that reason; the two are identical whenever a
    // player is resolving their own turn's choice.
    const chooser = G.pendingChoice.player;
    // `ctx.playerID` is the seat the engine says is acting. humanBattle sets it (its client is
    // untrusted); the headless engines don't, and are trusted — they only ever route the action to
    // the seat getLegalMoves offered it to.
    const actor = ctx?.playerID !== undefined ? Number(ctx.playerID) : chooser;
    if (chooser !== actor) return;

    const { effectKey, context } = G.pendingChoice;

    // Interactive mulligan compensation, stage 1: how many bonus cards to draw (0..max).
    // Stage 2 (below) optionally benches any Basics among the drawn cards — reference-site
    // behavior. Only after both stages does turn 1 hand over to the coin flip's firstPlayer.
    if (effectKey === 'mulligan_bonus') {
      const player = G.players[chooser];
      const n = parseInt(selection[0] ?? '0', 10) || 0;
      const drawnIds: string[] = [];
      for (let i = 0; i < n && player.deck.length > 0; i++) {
        const card = player.deck.pop()!;
        player.hand.push(card);
        drawnIds.push(card.id);
      }
      addLog(G, chooser, 'mulligan_bonus_draw', `選擇補抽 ${n} 張（對手重抽懲罰補償）`);
      const drawnBasics = player.hand.filter(c => drawnIds.includes(c.id)
        && c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
      const freeSlots = player.bench.filter(s => s === null).length;
      if (drawnBasics.length > 0 && freeSlots > 0) {
        G.pendingChoice = {
          player: chooser,
          effectKey: 'mulligan_bonus_bench',
          prompt: '可將補抽到的基礎寶可夢直接放上備戰區（可不選）',
          choiceType: 'select_from_list',
          minCount: 0,
          maxCount: Math.min(drawnBasics.length, freeSlots),
          options: drawnBasics.map(c => ({ id: c.id, label: c.cardData.name })),
          context: {},
        };
      } else {
        G.pendingChoice = null;
        raiseNextMulliganBonusOrFinish(G);
      }
      return;
    }
    if (effectKey === 'mulligan_bonus_bench') {
      const player = G.players[chooser];
      const placed: string[] = [];
      for (const id of selection) {
        const idx = player.hand.findIndex(c => c.id === id);
        const slot = player.bench.findIndex(s => s === null);
        if (idx === -1 || slot === -1) continue;
        const card = player.hand.splice(idx, 1)[0];
        player.bench[slot] = card;
        placed.push(card.cardData.name);
      }
      if (placed.length > 0) addLog(G, chooser, 'mulligan_bonus_bench', `放到備戰區：${placed.join('、')}`);
      G.pendingChoice = null;
      raiseNextMulliganBonusOrFinish(G);
      return;
    }

    if (effectKey === 'sensor_energy_bench') {
      const placed = resolveSensorEnergyBench(G, chooser, selection);
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice',
        placed.length > 0 ? `感應【超】能量：${placed.join('、')} 放上備戰區` : '感應【超】能量：未選擇寶可夢');
      return;
    }

    if (effectKey === 'tool_attach') {
      const player = G.players[chooser];
      const toolCard = context.toolCard as GameCard;
      const target = player.active?.id === selection[0] ? player.active : player.bench.find(c => c?.id === selection[0]);
      if (target && !target.attachedTool) target.attachedTool = toolCard;
      // 多重轉接: the second slot, only while the permission is live.
      else if (target && !target.attachedTool2 && canHoldSecondTool(G, target)) target.attachedTool2 = toolCard;
      else player.hand.push(toolCard);
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', `將道具「${toolCard.cardData.name}」附加於 ${target?.cardData.name ?? '?'}`);
      return;
    }

    if (effectKey === 'retreat') {
      const player = G.players[chooser];
      if (context.step === 'pick_bench') {
        const benchIdx = player.bench.findIndex(c => c?.id === selection[0]);
        if (context.needsEnergyChoice && player.active) {
          const retreatCost = effectiveRetreatCost(G, player.active);
          G.pendingChoice = {
            player: chooser,
            effectKey: 'retreat',
            prompt: `選擇 ${retreatCost} 張要棄置的能量（撤退費用）`,
            choiceType: 'select_from_list',
            count: retreatCost,
            options: player.active.attachedEnergy.map(e => ({ id: e.id, label: ENERGY_TYPE_ZH_LABEL[e.type] || e.type })),
            context: { step: 'pick_energy', benchIdx },
          };
          addLog(G, chooser, 'resolve_choice', '撤退：已選擇要換上場的備戰寶可夢');
        } else {
          G.pendingChoice = null;
          performRetreat(G, benchIdx, undefined);
        }
        return;
      }
      if (context.step === 'pick_energy') {
        const benchIdx = context.benchIdx as number | undefined;
        G.pendingChoice = null;
        performRetreat(G, benchIdx, selection);
        return;
      }
      G.pendingChoice = null;
      return;
    }

    if (effectKey === 'ko_promotion') {
      const player = G.players[chooser];
      const idx = player.bench.findIndex(c => c?.id === selection[0]);
      if (idx >= 0) {
        player.active = player.bench[idx];
        player.bench[idx] = null;
      }
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', `${player.active?.cardData.name ?? '?'} 上場成為新的戰鬥寶可夢`);
      return;
    }

    if (effectKey === 'mighty_transform') {
      // 全能變身: swap the freshly-benched 海豚俠 with 海豚俠ex from the deck. Everything on it
      // (energy, Tool, damage, conditions, the stacked lower Stage) carries over — only the
      // 海豚俠 top card itself returns to the deck.
      const player = G.players[chooser];
      const benchIdx = player.bench.findIndex(c => c?.id === G.pendingChoice!.sourceCardId);
      const pickedId = selection[0];
      if (benchIdx >= 0 && pickedId) {
        const dolphin = player.bench[benchIdx]!;
        const di = player.deck.findIndex(c => c.id === pickedId && normalizeAbilityName(c.cardData.name) === '海豚俠ex');
        if (di >= 0 && hasPassiveAbilityNamed(G, dolphin, '全能變身')) {
          const ex = player.deck.splice(di, 1)[0];
          ex.attachedEnergy = dolphin.attachedEnergy;
          ex.attachedTool = dolphin.attachedTool;
          ex.attachedTool2 = dolphin.attachedTool2;
          ex.damage = dolphin.damage;
          ex.statusConditions = dolphin.statusConditions;
          ex.preEvolutions = dolphin.preEvolutions;
          player.bench[benchIdx] = ex;
          player.deck.push({ ...dolphin, attachedEnergy: [], attachedTool: null, attachedTool2: null, damage: 0, statusConditions: [], preEvolutions: undefined });
          player.abilitiesUsedThisTurn.push(ex.id);
          addLog(G, chooser, 'use_ability', `全能變身：海豚俠 與 海豚俠ex 互換`);
        }
      }
      // The deck was searched to build the options either way — reshuffle even on a decline.
      shuffleDeck(player.deck);
      G.pendingChoice = null;
      return;
    }

    if (effectKey === 'stadium:prism_tower_draw') {
      const player = G.players[chooser];
      for (const id of selection) {
        const idx = player.hand.findIndex(c => c.id === id);
        if (idx >= 0) player.discardPile.push(player.hand.splice(idx, 1)[0]);
      }
      drawCards(G, chooser, 1);
      player.stadiumActionUsedThisTurn = true;
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', '稜鏡塔：丟棄2張手牌，抽1張卡');
      return;
    }

    if (effectKey === 'stadium:mystery_garden_draw') {
      const player = G.players[chooser];
      const idx = player.hand.findIndex(c => c.id === selection[0]);
      if (idx >= 0) player.discardPile.push(player.hand.splice(idx, 1)[0]);
      const ownPsychicCount = [player.active, ...player.bench].filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Psychic')).length;
      const toDraw = Math.max(0, ownPsychicCount - player.hand.length);
      drawCards(G, chooser, toDraw);
      player.stadiumActionUsedThisTurn = true;
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', `神秘花園：丟棄能量卡，抽${toDraw}張卡`);
      return;
    }

    if (effectKey === 'stadium:spike_town_gym_search') {
      const player = G.players[chooser];
      const idx = player.deck.findIndex(c => c.id === selection[0]);
      if (idx >= 0) player.hand.push(player.deck.splice(idx, 1)[0]);
      shuffleDeck(player.deck);
      player.stadiumActionUsedThisTurn = true;
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', '尖釘鎮道館：搜尋「瑪俐的寶可夢」加入手牌');
      return;
    }

    if (effectKey === 'stadium:night_school_topdeck') {
      const player = G.players[chooser];
      const idx = player.hand.findIndex(c => c.id === selection[0]);
      if (idx >= 0) player.deck.push(player.hand.splice(idx, 1)[0]);
      player.stadiumActionUsedThisTurn = true;
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', '夜間學院：將手牌放回牌庫上方');
      return;
    }

    if (effectKey === 'stadium:surf_beach_swap') {
      const player = G.players[chooser];
      const benchIdx = player.bench.findIndex(c => c?.id === selection[0]);
      if (benchIdx >= 0) performActiveBenchSwap(G, benchIdx);
      player.stadiumActionUsedThisTurn = true;
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', '衝浪海灘：與備戰區的【水】寶可夢互換');
      return;
    }

    // Generic attack template "選擇N個這隻寶可夢身上附加的能量，將其丟棄" (e.g. 超級快龍ex's
    // 龍之滑翔) — see the pendingChoice raised in moves.attack's discardSelfEnergyCount handling.
    // Finishes the turn immediately after, same as the custom attackEffects path below does once
    // its own pendingChoice clears — this choice IS the last thing the attack has left to do.
    if (effectKey === 'attack_self_energy_discard') {
      const player = G.players[chooser];
      const attackerId = context.attackerId as string;
      const attacker = player.active?.id === attackerId ? player.active : player.bench.find(c => c?.id === attackerId);
      if (attacker) {
        for (const id of selection) {
          const idx = attacker.attachedEnergy.findIndex(e => e.id === id);
          if (idx >= 0) discardAttachedEnergy(G, chooser, attacker.attachedEnergy.splice(idx, 1)[0]);
        }
      }
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', `從 ${attacker?.cardData.name ?? '?'} 身上丟棄了 ${selection.length} 張能量`);
      G.phase = 'end';
      ctx.events?.endTurn?.();
      return;
    }

    // 喵喵ex::夾尾巴逃跑-style "attacker bounces to hand, choose the new Active from 2+ Bench
    // options" — see the pendingChoice raised in moves.attack's returnSelfAndAttachmentsToHand
    // handling. Ends the turn immediately after, since this choice is the last thing the attack
    // has left to do (this is NOT the shared 'ko_promotion' key — that one's resolveChoice branch
    // deliberately doesn't end the turn, which is correct for its own start-of-turn job but was
    // exactly the bug here when reused mid-attack).
    if (effectKey === 'attack_self_return_promotion') {
      const player = G.players[chooser];
      const idx = player.bench.findIndex(c => c?.id === selection[0]);
      if (idx >= 0) { player.active = player.bench[idx]; player.bench[idx] = null; }
      G.pendingChoice = null;
      addLog(G, chooser, 'resolve_choice', `${player.active?.cardData.name ?? '?'} 上場成為新的戰鬥寶可夢`);
      G.phase = 'end';
      ctx.events?.endTurn?.();
      return;
    }

    const colonIdx = effectKey.indexOf(':');
    const kind = effectKey.slice(0, colonIdx);
    const name = effectKey.slice(colonIdx + 1);
    // Restore the same sourceCardId the effect started with — several handlers' resume()
    // need it (e.g. to re-find the Pokémon that triggered the effect).
    // The effect belongs to `owner`, which is not the answering seat for 「對手回答…」 effects —
    // resume() must keep running as the player who used the card.
    const owner = (G.pendingChoice.owner ?? chooser) as 0 | 1;
    const ctxInfo: EffectContext = { G, playerIndex: owner, sourceCardId: G.pendingChoice.sourceCardId || '' };

    let step: EffectStep;
    if (kind === 'trainer') step = resumeTrainerEffect(name, ctxInfo, context, selection);
    else if (kind === 'ability') step = resumeAbilityEffect(name, ctxInfo, context, selection);
    else {
      const [pokemonName, attackName] = name.split('::');
      step = resumeAttackEffect(pokemonName, attackName, ctxInfo, context, selection);
    }
    applyEffectStep(G, owner, effectKey, step, ctxInfo.sourceCardId);
    // Fallback line for effects with no custom log message. `effectKey` is an internal
    // discriminator ("ability:支配鎖鏈", "trainer:艾莉絲的鬥志") and `selection` holds instance ids
    // ("SV6a-050_101") — both were going straight to the player's battle log. Show the card name
    // and resolve each selected id to a name where the board knows one.
    const prettyName = name.replace('::', '的');
    const chosenLabels = selection.map(id => findCardNameById(G, id) ?? id);
    addLog(G, chooser, 'resolve_choice', `「${prettyName}」結算：${chosenLabels.join('、') || '(未選擇)'}`);

    // An attack's pending choices (e.g. distributing damage counters) block the rest of the
    // turn; once they're all resolved, finish the turn exactly like a normal attack would.
    if (kind === 'attack' && !G.pendingChoice) {
      G.phase = 'end';
      ctx.events?.endTurn?.();
    }
  },

  // Fossils ("陳舊的○○化石"): the printed rule lets the owner voluntarily discard one from play
  // on their own turn, no cost, no prize awarded (this is NOT a KO — handleKo would wrongly
  // hand the opponent a prize). Mirrors 寶可夢旋風回收機's own field-removal pattern in
  // trainers.ts, but to the discard pile instead of hand.
  discardFossil: ({ G }: { G: PtcgGameState; ctx: any }, cardId: string) => {
    const player = G.players[G.currentPlayer];
    const isActive = player.active?.id === cardId;
    const benchIdx = isActive ? -1 : player.bench.findIndex(c => c?.id === cardId);
    const target = isActive ? player.active : (benchIdx >= 0 ? player.bench[benchIdx] : null);
    if (!target || !target.cardData.isFossil) return;
    if (target.attachedTool) player.discardPile.push(target.attachedTool);
    for (const energy of target.attachedEnergy.splice(0)) {
      if (energy.cardData) {
        player.discardPile.push({ id: energy.id, cardData: energy.cardData, owner: G.currentPlayer as 0 | 1, damage: 0, statusConditions: [], attachedEnergy: [] });
      }
    }
    flushPreEvolutionsToDiscard(target, player.discardPile);
    player.discardPile.push(target);
    if (isActive) player.active = null; else player.bench[benchIdx] = null;
    // Discarding the Active leaves the slot empty mid-turn — immediately promote from the
    // Bench like a KO does, rather than leaving a gap until the next turn boundary. If the
    // Bench is also empty, checkGameOver's usual "no Active and no Bench" loss condition
    // takes it from here.
    if (isActive) promoteActiveIfNeeded(G, G.currentPlayer as 0 | 1);
    addLog(G, G.currentPlayer, 'discard_fossil', `將場上的 ${target.cardData.name} 丟棄`);
  },

  retreat: ({ G, ctx }: { G: PtcgGameState; ctx: any }, targetBenchPosition?: number, discardEnergyIds?: string[]) => {
    if (!canRetreat(G, G.currentPlayer)) return;
    // 黏滑失足: opponent's ability may cancel this retreat outright on a coin flip.
    if (isRetreatBlockedByOpponent(G, G.currentPlayer as 0 | 1)) {
      addLog(G, G.currentPlayer, 'retreat', "Retreat was cancelled by the opponent's 黏滑失足");
      return;
    }

    const player = G.players[G.currentPlayer];
    const activePokemon = player.active;
    if (!activePokemon) return;

    // Explicit args mean the caller already made its choice (resuming below via resolveChoice,
    // or a direct legacy call) — skip straight to execution.
    if (targetBenchPosition !== undefined || discardEnergyIds !== undefined) {
      performRetreat(G, targetBenchPosition, discardEnergyIds);
      return;
    }

    // A player is entitled to choose BOTH which Benched Pokémon comes up AND which attached
    // energy pays the retreat cost — auto-picking "first bench slot" / "first N energies
    // attached" (the old behavior) silently took that choice away whenever more than one
    // option existed. Only ask when there's a real choice to make; otherwise resolve instantly
    // to keep the common case (one bench Pokémon, cost fully covered) a single click.
    const retreatCost = effectiveRetreatCost(G, activePokemon);
    const benchSlots: number[] = [];
    player.bench.forEach((c, i) => { if (c) benchSlots.push(i); });
    const needsBenchChoice = benchSlots.length > 1;
    const needsEnergyChoice = retreatCost > 0 && activePokemon.attachedEnergy.length > retreatCost;

    if (!needsBenchChoice && !needsEnergyChoice) {
      performRetreat(G, benchSlots[0], undefined);
      return;
    }

    if (needsBenchChoice) {
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'retreat',
        prompt: '選擇要換上場的備戰寶可夢',
        choiceType: 'select_bench_pokemon',
        count: 1,
        options: benchSlots.map(i => ({ id: player.bench[i]!.id, label: player.bench[i]!.cardData.name })),
        context: { step: 'pick_bench', needsEnergyChoice },
      };
    } else {
      G.pendingChoice = {
        player: G.currentPlayer as 0 | 1,
        effectKey: 'retreat',
        prompt: `選擇 ${retreatCost} 張要棄置的能量（撤退費用）`,
        choiceType: 'select_from_list',
        count: retreatCost,
        options: activePokemon.attachedEnergy.map(e => ({ id: e.id, label: ENERGY_TYPE_ZH_LABEL[e.type] || e.type })),
        context: { step: 'pick_energy', benchIdx: benchSlots[0] },
      };
    }
  },

  attack: ({ G, ctx }: { G: PtcgGameState; ctx: any }, attackIndex: number) => {
    if (G.phase !== 'main' && G.phase !== 'attack') return;
    if (!canAttack(G, G.currentPlayer, attackIndex)) return;

    G.phase = 'attack';
    const player = G.players[G.currentPlayer];
    const opponent = G.players[1 - G.currentPlayer];
    if (!player.active || !opponent.active) return;

    const attacker = player.active;
    // usableAttacks, not cardData.attacks: 潛入記憶 appends pre-evolution attacks after the
    // printed ones, and canAttack above validated the index against that same combined list.
    const attack = usableAttacks(G, attacker)[attackIndex];
    const defender = opponent.active;

    // Confused: flip a coin before the attack connects. Tails = it fails and hits its own user for 30 instead.
    if (attacker.statusConditions.includes('Confused') && Math.random() < 0.5) {
      attacker.damage += 30;
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} 因【混亂】攻擊失敗，對自己造成 30 點傷害！`);
      const selfHp = effectiveMaxHp(G, attacker);
      if (selfHp > 0 && attacker.damage >= selfHp) handleKo(G, G.currentPlayer, attacker.id);
      G.phase = 'end';
      ctx.events?.endTurn?.();
      return;
    }

    // Timed "next attack has a 50% chance to fail" debuff (e.g. from an opponent's earlier
    // attack) — consumed (removed) the moment it's checked, whether it fires or not, since it
    // only ever covers exactly one attack attempt.
    const missCoins = getCoinFlipAttackMissCoins(G, attacker);
    if (missCoins > 0) {
      attacker.timedEffects = (attacker.timedEffects || []).filter(e => !(e.kind === 'coinFlipAttackMiss' && e.appliesOnTurn === G.turn));
      // Any tails fails it, so more coins is strictly worse for the attacker.
      if (Array.from({ length: missCoins }, () => Math.random() < 0.5).some(tails => tails)) {
        addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} 的攻擊失敗了！`);
        G.phase = 'end';
        ctx.events?.endTurn?.();
        return;
      }
    }

    // 回力鏢能量/燃料【火】能量: record the attacker's copies before the attack resolves, so the
    // post-move wrapper can return whichever ones the attack's own effect discards.
    watchAttackEnergyReturns(G, G.currentPlayer as 0 | 1, attacker);

    // Feeds 「在上個自己的回合，若…使用了「X」」 templates; rotated ThisTurn -> LastTurn once
    // per turn transition in processBetweenTurns.
    player.attacksUsedThisTurn.push({
      cardId: attacker.id,
      attackName: attack.name,
      ancient: attacker.cardData.subtypes.includes('Ancient'),
    });

    if (hasAttackEffect(attacker.cardData.name, attack.name)) {
      const ctxInfo: EffectContext = { G, playerIndex: G.currentPlayer as 0 | 1, sourceCardId: attacker.id };
      const step = startAttackEffect(attacker.cardData.name, attack.name, ctxInfo);
      applyEffectStep(G, G.currentPlayer as 0 | 1, `attack:${attacker.cardData.name}::${attack.name}`, step, attacker.id);
      addLog(G, G.currentPlayer, 'attack', `${attacker.cardData.name} 使用了「${attack.name}」！`);
    } else {
      // Generic attack-text templates (coin-flip-scaled damage, status infliction, self-heal,
      // draw, energy discard, board-scaled damage, timed self-protection/lockout) — resolved
      // from the printed text/damage string directly, no per-card registration needed. See
      // genericAttacks.ts for what is and isn't covered by this.
      const attackBoard = buildAttackBoard(G, player, opponent, attacker, defender, attack);
      applyAttackOutcome(G, player, opponent, attacker, defender, attack, attackBoard);
    }

    // 祭典樂舞: while 祭典會場 is active, this Pokémon may attack a second time this turn.
    // Simplified vs. the printed text's KO/promote timing nuance — just allows one bonus
    // attack this turn rather than modeling the exact "opponent must first promote" sequencing.
    if (!G.pendingChoice && !player.usedBonusAttackThisTurn
      && hasPassiveAbilityNamed(G, attacker, '祭典樂舞') && isStadiumActive(G, '祭典會場')) {
      player.usedBonusAttackThisTurn = true;
      addLog(G, G.currentPlayer, 'ability', `${attacker.cardData.name}'s 祭典樂舞 grants a second attack this turn`);
      return;
    }

    if (!G.pendingChoice) {
      G.phase = 'end';
      ctx.events?.endTurn?.();
    }
  },

  endTurn: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    addLog(G, G.currentPlayer, 'end_turn', '回合結束');
    G.phase = 'end';
    ctx.events?.endTurn?.();
  },

  forfeit: ({ G, ctx }: { G: PtcgGameState; ctx: any }) => {
    G.winner = (1 - G.currentPlayer) as 0 | 1;
    G.winReason = 'forfeit';
    addLog(G, G.currentPlayer, 'forfeit', '玩家投降');
  },
};

/**
 * Every move runs a state-based Knock Out sweep afterwards.
 *
 * Damage is checked when it lands, but a Pokémon's max HP is not fixed: discarding a Tool that
 * granted HP (道具拆除器), swapping the Stadium (激動競技場 / 引力山岳), or an HP-granting
 * ability holder leaving play can all drop the ceiling below the damage already on a Pokémon.
 * playtest-soak found survivors sitting at 130/120 after a dozen different moves, so hooking
 * each cause individually would keep missing new ones.
 *
 * Wrapping the shared `moves` object is deliberate: all three engines (battleRunner,
 * humanBattle, PtcgGame) call these same functions, so this is the one place that covers every
 * path without adding a fourth copy of anything — the failure mode CLAUDE.md warns about.
 *
 * Skipped while a pendingChoice is open: a multi-step effect is mid-resolution and the real
 * rules only apply state-based checks between actions, so the sweep runs on the move that
 * finally clears the choice.
 */
/** 全能變身 (海豚俠): fires when the holder moved from its owner's Active Spot to their Bench
 * during the owner's own turn — retreat, switch Trainers, Stadium swaps and multi-step choice
 * resolutions all funnel through some wrapped move, so ONE transition check here covers every
 * path without per-handler hooks. Offers swapping it with 海豚俠ex from the deck (attachments,
 * damage, conditions and the stacked lower Stage all carry over — see the resolveChoice branch). */
function maybeRaiseMightyTransformChoice(G: PtcgGameState, ownerIdx: 0 | 1, previousActiveId: string | null): void {
  if (!previousActiveId || G.pendingChoice || G.currentPlayer !== ownerIdx) return;
  const p = G.players[ownerIdx];
  const moved = p.bench.find(c => c?.id === previousActiveId);
  if (!moved || !hasPassiveAbilityNamed(G, moved, '全能變身')) return;
  if (p.abilitiesUsedThisTurn.includes(moved.id)) return;
  const options = p.deck
    .filter(c => normalizeAbilityName(c.cardData.name) === '海豚俠ex')
    .map(c => ({ id: c.id, label: c.cardData.name }));
  if (options.length === 0) return;
  G.pendingChoice = {
    player: ownerIdx,
    effectKey: 'mighty_transform',
    sourceCardId: moved.id,
    prompt: '全能變身：從牌庫選擇 1 張「海豚俠ex」與這張卡互換（可不選）',
    choiceType: 'select_from_list',
    minCount: 0,
    maxCount: 1,
    options,
    context: {},
  };
}

/** 多重轉接's printed parenthetical: the moment the second-Tool permission lapses (the 洛托姆ex
 * holder left play or its ability is negated), the extra Tool is discarded. */
function sweepLapsedSecondTools(G: PtcgGameState): void {
  for (const p of G.players) {
    for (const card of [p.active, ...p.bench]) {
      if (card?.attachedTool2 && !canHoldSecondTool(G, card)) {
        p.discardPile.push(card.attachedTool2);
        card.attachedTool2 = null;
      }
    }
  }
}

export const moves = Object.fromEntries(
  Object.entries(rawMoves).map(([name, fn]) => [
    name,
    (arg: { G: PtcgGameState; ctx: any }, ...rest: unknown[]) => {
      // Snapshot for the 全能變身 transition watch below — who was Active for the player about
      // to move, before the move ran.
      const moverIdx = arg.G.currentPlayer as 0 | 1;
      const activeBefore = arg.G.players[moverIdx]?.active?.id ?? null;
      const result = (fn as (...a: unknown[]) => unknown)(arg, ...rest);
      if (arg.G.winner === null && !arg.G.pendingChoice) {
        // 回力鏢能量/燃料【火】能量 come back 「在招式的傷害與效果的影響之後」 — this is that
        // moment, whether the attack finished synchronously or through a pendingChoice.
        processAttackEnergyReturns(arg.G);
        // Order matters: clear Conditions off the Bench first, then check for Knock Outs, so a
        // Pokémon that was just switched out isn't KO'd on Poison damage it should no longer have.
        clearBenchStatusConditions(arg.G);
        sweepKnockedOut(arg.G);
        sweepLapsedSecondTools(arg.G);
        maybeRaiseMightyTransformChoice(arg.G, moverIdx, activeBefore);
      }
      return result;
    },
  ]),
) as typeof rawMoves;
