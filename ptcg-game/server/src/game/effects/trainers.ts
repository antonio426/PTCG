import { GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, allPokemon, normalizeCardName, opponent, player, shuffleDeck } from './types';
import { applyStatusCondition, discardAttachedEnergy, discardFromHand, drawCards, drawUpTo, flipCoin, hasNoRuleBox, healDamage, moveDiscardCardToHand } from './primitives';
import { clearStatusConditionsOnLeaveActive } from '../statusConditions';
import { isEnergyDiscardProtected } from './passiveAbilities';
import { handleKo, stackAsPreEvolution, flushPreEvolutionsToDiscard, resetCardForReentry } from '../damage';
import { hasEvolvesFrom, evolvesFromMatches, inferEvolvesFromSpecies, chainTracesBackTo } from '../evolutionChains';

function deckOptions(deck: GameCard[], filter: (c: GameCard) => boolean): { id: string; label: string }[] {
  return deck.filter(filter).map(c => ({ id: c.id, label: c.cardData.name }));
}

function moveFromDeckToHand(G: EffectContext['G'], idx: 0 | 1, cardId: string, reshuffle = true): GameCard | null {
  const p = player(G, idx);
  const i = p.deck.findIndex(c => c.id === cardId);
  if (i === -1) return null;
  const [card] = p.deck.splice(i, 1);
  p.hand.push(card);
  if (reshuffle) shuffleDeck(p.deck);
  return card;
}

/** 高級球 Ultra Ball: discard 2 cards, then search any 1 Pokémon from deck to hand. */
const ultraBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length < 2) return 'done';
    return {
      prompt: '高級球：選擇 2 張手牌丟棄',
      choiceType: 'select_hand_cards',
      count: 2,
      context: { step: 'discard' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'discard') {
      for (const id of selection) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
      }
      const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon');
      if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return {
        prompt: '高級球：從牌庫選 1 張寶可夢加入手牌（可不選）',
        choiceType: 'select_from_list',
        maxCount: 1,
        options,
        context: { step: 'search' },
      };
    }
    if (context.step === 'search' && selection[0]) {
      moveFromDeckToHand(ctx.G, ctx.playerIndex, selection[0]);
    } else {
      shuffleDeck(p.deck);
    }
    return 'done';
  },
};

/** 老大的指令 Boss's Orders: force-switch one of the opponent's benched Pokémon to active. */
const bosssOrders: EffectHandler = {
  canPlay(ctx) { return opponent(ctx.G, ctx.playerIndex).bench.some(c => c !== null); },
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (benched.length === 0) return 'done';
    return {
      prompt: "老大的指令：選 1 隻對手備戰寶可夢換上場",
      choiceType: 'select_pokemon',
      count: 1,
      options: benched.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    } else if (idx >= 0 && !opp.active) {
      opp.active = opp.bench[idx];
      opp.bench[idx] = null;
    }
    return 'done';
  },
};

/** 神奇糖果 Rare Candy: evolve a Basic Pokémon in play directly into a Stage 2 from hand. */
const rareCandy: EffectHandler = {
  // Basic straight to Stage 2 only (never Stage 1 -> Stage 2), never on turn 1, and only
  // when some Stage 2 in hand actually evolves from a Basic already in play that wasn't
  // played this turn. All public/own information, so an impossible play is simply illegal.
  canPlay(ctx) {
    if (ctx.G.turn === 1) return false;
    const p = player(ctx.G, ctx.playerIndex);
    return p.hand
      .filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Stage 2'))
      .some(stage2 =>
        [p.active, ...p.bench].some(t =>
          t && t.cardData.subtypes.includes('Basic') && !p.pokemonPlayedThisTurn.includes(t.id)
            && chainTracesBackTo(stage2.cardData, t.cardData.name)
        )
      );
  },
  start(ctx) {
    // "無法對自己的最初回合...使用" — Rare Candy can't be used on your own first turn at all.
    if (ctx.G.turn === 1) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const stage2InHand = p.hand.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Stage 2'));
    if (stage2InHand.length === 0) return 'done';
    return {
      prompt: '神奇糖果：選擇要使用的 2 階寶可夢卡',
      choiceType: 'select_from_list',
      count: 1,
      options: stage2InHand.map(c => ({ id: c.id, label: `${c.cardData.name}（進化自 ${c.cardData.evolvesFrom ?? inferEvolvesFromSpecies(c.cardData.name) ?? '?'} 的前一階）` })),
      context: { step: 'pick_card' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_card') {
      const cardId = selection[0];
      const card = p.hand.find(c => c.id === cardId);
      if (!card) return 'done';
      // Target must be a Basic Pokémon not played this turn, whose evolution line eventually reaches this Stage 2.
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(
        t => t.cardData.subtypes.includes('Basic') && !p.pokemonPlayedThisTurn.includes(t.id)
          && chainTracesBackTo(card.cardData, t.cardData.name)
      );
      if (targets.length === 0) return 'done';
      return {
        prompt: `神奇糖果：選擇要進化的基礎寶可夢`,
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', cardId },
      };
    }
    if (context.step === 'pick_target') {
      const cardId = context.cardId as string;
      const targetId = selection[0];
      const handIdx = p.hand.findIndex(c => c.id === cardId);
      if (handIdx === -1) return 'done';
      const evolution = p.hand.splice(handIdx, 1)[0];
      const isActive = p.active?.id === targetId;
      const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === targetId);
      const old = isActive ? p.active : (benchIdx >= 0 ? p.bench[benchIdx] : null);
      if (!old) { p.hand.push(evolution); return 'done'; }
      evolution.attachedEnergy = old.attachedEnergy;
      evolution.damage = old.damage;
      evolution.attachedTool = old.attachedTool;
      stackAsPreEvolution(evolution, old);
      if (isActive) p.active = evolution; else p.bench[benchIdx] = evolution;
    }
    return 'done';
  },
};

/**
 * 莉莉艾的決意 Lillie's Determination: shuffle hand into deck, draw 6 —
 * or 8 if you haven't taken any prizes yet (still at 6 remaining).
 */
const lilliesDetermination: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    p.deck.push(...p.hand);
    p.hand = [];
    shuffleDeck(p.deck);
    const drawCount = p.prizes.length === 6 ? 8 : 6;
    for (let i = 0; i < drawCount && p.deck.length > 0; i++) p.hand.push(p.deck.pop()!);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 夜間擔架 Night Stretcher: retrieve 1 Pokémon or Basic Energy from discard to hand. */
const nightStretcher: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => c.cardData.supertype === 'Pokémon' || c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(
      p.discardPile,
      c => c.cardData.supertype === 'Pokémon' || c.cardData.subtypes.includes('Basic Energy')
    );
    if (options.length === 0) return 'done';
    return {
      prompt: '夜間擔架：從棄牌區選 1 張寶可夢或基本能量加手牌',
      choiceType: 'select_from_list',
      count: 1,
      options,
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.discardPile.findIndex(c => c.id === selection[0]);
    if (i >= 0) {
      const card = p.discardPile.splice(i, 1)[0];
      resetCardForReentry(card);
      p.hand.push(card);
    }
    return 'done';
  },
};

/** 寶可平板: search 1 "no rule box" basic Pokémon from deck to hand. */
const pokeTablet: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && hasNoRuleBox(c));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '寶可平板：從牌庫選 1 張「非擁有規則」寶可夢加入手牌',
      choiceType: 'select_from_list',
      maxCount: 1,
      options,
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveFromDeckToHand(ctx.G, ctx.playerIndex, selection[0]);
    else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 好友寶芬 Buddy-Buddy Poffin: search up to 2 Basic Pokémon with HP<=70 onto the bench. */
const buddyPoffin: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).bench.some(s => s === null); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const freeSlots = p.bench.filter(s => s === null).length;
    if (freeSlots === 0) return 'done';
    const options = deckOptions(
      p.deck,
      c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && parseInt(c.cardData.hp || '999', 10) <= 70
    );
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '好友寶芬：從牌庫選至多 2 隻 HP≤70 基礎寶可夢到備戰區',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, freeSlots),
      options,
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i === -1) continue;
      const slot = p.bench.findIndex(s => s === null);
      if (slot === -1) break;
      p.bench[slot] = p.deck.splice(i, 1)[0];
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 艾莉絲的鬥志: discard 1 card from hand, draw back up to 6. */
const alicesResolve: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).hand.some(c => c.id !== ctx.sourceCardId); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return {
      prompt: '艾莉絲的鬥志：選 1 張手牌丟棄，再抽至 6 張',
      choiceType: 'select_hand_cards',
      count: 1,
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
    while (p.hand.length < 6 && p.deck.length > 0) p.hand.push(p.deck.pop()!);
    return 'done';
  },
};

/** 赤松: search up to 2 Basic Energy, keep 1 in hand, attach the other to a chosen Pokémon. */
const akamatsu: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '赤松：從牌庫選最多 2 張基本能量',
      choiceType: 'select_from_list',
      maxCount: 2,
      options,
      context: { step: 'search' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'search') {
      const found: GameCard[] = [];
      for (const id of selection) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i >= 0) found.push(p.deck.splice(i, 1)[0]);
      }
      shuffleDeck(p.deck);
      if (found.length === 0) return 'done';
      p.hand.push(...found);
      if (found.length === 1) return 'done';
      return {
        prompt: '赤松：選 1 張能量留在手牌（剩餘附給寶可夢）',
        choiceType: 'select_from_list',
        count: 1,
        options: found.map(c => ({ id: c.id, label: c.cardData.name })),
        context: { step: 'keep', foundIds: found.map(c => c.id) },
      };
    }
    if (context.step === 'keep') {
      const keepId = selection[0];
      const foundIds = context.foundIds as string[];
      const attachId = foundIds.find(id => id !== keepId);
      if (!attachId) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      if (targets.length === 0) return 'done';
      return {
        prompt: '赤松：請選 1 隻寶可夢附加能量',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'attach', attachId },
      };
    }
    if (context.step === 'attach') {
      const attachId = context.attachId as string;
      const cardIdx = p.hand.findIndex(c => c.id === attachId);
      if (cardIdx === -1) return 'done';
      const target = ctx.G.players[ctx.playerIndex].active?.id === selection[0]
        ? ctx.G.players[ctx.playerIndex].active
        : ctx.G.players[ctx.playerIndex].bench.find(c => c?.id === selection[0]);
      if (!target) return 'done';
      const energy = p.hand.splice(cardIdx, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
};

/** 寶可夢交替 Pokémon Exchange: switch your own Active with a Benched Pokémon. */
const pokemonExchange: EffectHandler = {
  canPlay(ctx) { const p = player(ctx.G, ctx.playerIndex); return !!p.active && p.bench.some(c => c !== null); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active || !p.bench.some(s => s !== null)) return 'done';
    return {
      prompt: '寶可夢交替：選擇要換上場的備戰寶可夢',
      choiceType: 'select_bench_pokemon',
      count: 1,
      options: p.bench.filter((s): s is GameCard => s !== null).map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const idx = p.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && p.active) { const b = p.bench[idx]!; clearStatusConditionsOnLeaveActive(p.active); p.bench[idx] = p.active; p.active = b; }
    return 'done';
  },
};

/** 傷藥 Potion: heal 30 HP off one of your own Pokémon. */
const potion: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return {
      prompt: '傷藥：選擇自己的 1 隻寶可夢恢復 30 HP',
      choiceType: 'select_pokemon',
      count: 1,
      options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) healDamage(target, 30);
    return 'done';
  },
};

/** 能量轉移 Energy Transfer: move one attached Basic Energy from one of your Pokémon to another. */
const energyTransfer: EffectHandler = {
  canPlay(ctx) { return allPokemon(ctx.G, ctx.playerIndex).some(c => c.attachedEnergy.length > 0); },
  start(ctx) {
    const withEnergy = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.attachedEnergy.length > 0);
    if (withEnergy.length === 0) return 'done';
    const options: { id: string; label: string }[] = [];
    for (const c of withEnergy) for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` });
    return {
      prompt: '能量轉移：選擇要移動的基本能量',
      choiceType: 'select_from_list',
      count: 1,
      options,
      context: { step: 'pick_energy' },
    };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return {
        prompt: '能量轉移：選擇要附加到哪隻寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyId: selection[0] },
      };
    }
    const energyId = context.energyId as string;
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === energyId));
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (source && target && source.id !== target.id) {
      const eIdx = source.attachedEnergy.findIndex(e => e.id === energyId);
      if (eIdx >= 0) target.attachedEnergy.push(source.attachedEnergy.splice(eIdx, 1)[0]);
    }
    return 'done';
  },
};

/** 能量輸送 Energy Delivery: search deck for 1 Basic Energy to hand, reshuffle. */
const energyDelivery: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '能量輸送：從牌庫選 1 張基本能量卡加入手牌', choiceType: 'select_from_list', maxCount: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveFromDeckToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 寶可夢捕捉器 Pokémon Catcher: flip a coin; if heads, Boss's-Orders-style force switch. */
const pokemonCatcher: EffectHandler = {
  // even heads does nothing vs an empty bench
  canPlay(ctx) { return opponent(ctx.G, ctx.playerIndex).bench.some(c => c !== null); },
  start(ctx) {
    if (!flipCoin()) return 'done';
    return bosssOrders.start(ctx);
  },
  resume(ctx, context, selection) { return bosssOrders.resume(ctx, context, selection); },
};

/** 寶可裝置3.0 Poké Gear 3.0: look at top 7, take 1 Supporter card to hand. */
const pokeGear3: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-7);
    const supporters = top.filter(c => c.cardData.subtypes.includes('Supporter'));
    if (supporters.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '寶可裝置3.0：查看牌庫上方 7 張，選 1 張支援者卡加入手牌',
      choiceType: 'select_from_list',
      maxCount: 1,
      options: supporters.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveFromDeckToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 裁判 Judge: both players shuffle their hand into their deck and draw 4. */
const judge: EffectHandler = {
  start(ctx) {
    for (const idx of [0, 1] as const) {
      const p = player(ctx.G, idx);
      p.deck.push(...p.hand);
      p.hand = [];
      shuffleDeck(p.deck);
      drawCards(ctx.G, idx, 4);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 能量回收 Energy Retrieval: from discard, choose up to 2 Basic Energy to hand. */
const energyRetrieval: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) return 'done';
    return { prompt: '能量回收：從棄牌區選最多 2 張基本能量卡加入手牌', choiceType: 'select_from_list', maxCount: 2, options, context: {} };
  },
  resume(ctx, _context, selection) {
    for (const id of selection) moveDiscardCardToHand(ctx.G, ctx.playerIndex, id);
    return 'done';
  },
};

/** 能量回收器 Energy Recycling System: from discard, choose up to 5 Basic Energy back into the deck (reshuffled). */
const energyRecyclingSystem: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) return 'done';
    return { prompt: '能量回收器：從棄牌區選最多 5 張基本能量卡放回牌庫', choiceType: 'select_from_list', maxCount: 5, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.discardPile.findIndex(c => c.id === id);
      if (i >= 0) p.deck.push(p.discardPile.splice(i, 1)[0]);
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** "Choose 1 Energy attached to an opponent's Pokémon and discard it" — the shared body behind
 * 粉碎之錘 (coin-gated) and 鏽蝕組手下 (not). Kept separate from the coin flip so a card whose
 * printed text has no flip can't inherit one. */
const discardOneOpponentEnergy: EffectHandler = {
  start(ctx) {
    // 崗哨: benched Pokémon protected by this ability can't have their Energy targeted.
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => c.attachedEnergy.length > 0 && !isEnergyDiscardProtected(ctx.G, c));
    if (targets.length === 0) return 'done';
    const options: { id: string; label: string }[] = [];
    for (const c of targets) for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` });
    return { prompt: '選擇要丟棄對手身上的哪個能量', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const c of [opp.active, ...opp.bench]) {
      if (!c) continue;
      const i = c.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) { discardAttachedEnergy(ctx.G, c.owner, c.attachedEnergy.splice(i, 1)[0]); break; }
    }
    return 'done';
  },
};

/** 粉碎之錘 Crushing Hammer: flip a coin; if heads, discard 1 energy attached to an opponent's Pokémon. */
const crushingHammer: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    return discardOneOpponentEnergy.start(ctx);
  },
  resume: discardOneOpponentEnergy.resume,
};

/** An attached Energy that is a Special Energy card rather than a basic one. AttachedEnergy keeps
 * the original card in `cardData` precisely so this stays answerable after attaching; the legacy
 * no-cardData case is treated as basic, which is the conservative reading (never discards more
 * than the card allows). */
const isSpecialEnergy = (e: { cardData?: { subtypes?: string[] } }) =>
  !!e.cardData?.subtypes?.includes('Special Energy');

/** 改造之錘: discard 1 SPECIAL Energy attached to an opponent's Pokémon (no coin flip). */
const modifiedHammer: EffectHandler = {
  canPlay(ctx) {
    return allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1)
      .some(c => c.attachedEnergy.some(isSpecialEnergy) && !isEnergyDiscardProtected(ctx.G, c));
  },
  start(ctx) {
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => !isEnergyDiscardProtected(ctx.G, c));
    const options: { id: string; label: string }[] = [];
    // 特殊能量 only — this used to offer every attached Energy, so it could discard basic Energy
    // the printed text never allowed it to touch.
    for (const c of targets) for (const e of c.attachedEnergy) {
      if (isSpecialEnergy(e)) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.cardData!.name}` });
    }
    if (options.length === 0) return 'done';
    return { prompt: '改造之錘：選擇要丟棄對手身上的哪張特殊能量', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: discardOneOpponentEnergy.resume,
};

/** 水蓮的照顧 Erika's Hospitality: from discard, up to 3 total of (non-rule-box Pokémon + Basic Energy) to hand. */
const erikasHospitality: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => (c.cardData.supertype === 'Pokémon' && hasNoRuleBox(c)) || c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => (c.cardData.supertype === 'Pokémon' && hasNoRuleBox(c)) || c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) return 'done';
    return { prompt: '水蓮的照顧：從棄牌區選最多 3 張寶可夢／基本能量卡加入手牌', choiceType: 'select_from_list', maxCount: 3, options, context: {} };
  },
  resume(ctx, _context, selection) {
    for (const id of selection) moveDiscardCardToHand(ctx.G, ctx.playerIndex, id);
    return 'done';
  },
};

/** 松葉的信心 Matsuba's Conviction: discard 1 card, draw cards equal to the opponent's bench count. */
const matsubasConviction: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).hand.some(c => c.id !== ctx.sourceCardId); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return { prompt: '松葉的信心：選 1 張手牌丟棄', choiceType: 'select_hand_cards', count: 1, context: {} };
  },
  resume(ctx, _context, selection) {
    discardFromHand(ctx.G, ctx.playerIndex, selection);
    const benchCount = opponent(ctx.G, ctx.playerIndex).bench.filter(s => s !== null).length;
    drawCards(ctx.G, ctx.playerIndex, benchCount);
    return 'done';
  },
};

/** 紫竽 (draw supporter): shuffle hand, draw 4 — or 8 if the opponent has 3 or fewer prizes left. */
const shuffleDrawConditional8: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    p.deck.push(...p.hand);
    p.hand = [];
    shuffleDeck(p.deck);
    const oppPrizes = opponent(ctx.G, ctx.playerIndex).prizes.length;
    drawCards(ctx.G, ctx.playerIndex, oppPrizes <= 3 ? 8 : 4);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 鬥子 Toshi: search deck for 1 Evolution Pokémon card + 1 Energy card to hand. */
const toshi: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c =>
      (c.cardData.supertype === 'Pokémon' && (c.cardData.subtypes.includes('Stage 1') || c.cardData.subtypes.includes('Stage 2'))) ||
      c.cardData.supertype === 'Energy'
    );
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '鬥子：從牌庫選 1 張進化寶可夢卡與 1 張能量卡加入手牌', choiceType: 'select_from_list', maxCount: 2, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 杜若 Durand: look at top 7, take up to 1 Pokémon + 1 Trainer to hand. */
const durand: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-7);
    const options = top.filter(c => c.cardData.supertype === 'Pokémon' || c.cardData.supertype === 'Trainer');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '杜若：查看牌庫上方 7 張，選最多 1 張寶可夢卡與 1 張訓練家卡加入手牌', choiceType: 'select_from_list', maxCount: 2, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 阿克羅瑪的執著 Akroma's Persistence: search deck for 1 Stadium + 1 Energy to hand. */
const akromasPersistence: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Stadium') || c.cardData.supertype === 'Energy');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '阿克羅瑪的執著：從牌庫選 1 張競技場卡與 1 張能量卡加入手牌', choiceType: 'select_from_list', maxCount: 2, options, context: {} };
  },
  resume: toshi.resume,
};

/** 悟松 Gosho: both players shuffle hand into deck, then each flips a coin — heads draws 6, tails draws 3. */
const gosho: EffectHandler = {
  start(ctx) {
    for (const idx of [0, 1] as const) {
      const p = player(ctx.G, idx);
      p.deck.push(...p.hand);
      p.hand = [];
      shuffleDeck(p.deck);
      drawCards(ctx.G, idx, flipCoin() ? 6 : 3);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 朵拉塞娜 Dorasena: shuffle hand into deck, flip a coin — heads draw 8, tails draw 3. */
const dorasena: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    p.deck.push(...p.hand);
    p.hand = [];
    shuffleDeck(p.deck);
    drawCards(ctx.G, ctx.playerIndex, flipCoin() ? 8 : 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 頂尖捕捉器 Top Catcher: force-switch an opponent's benched Pokémon to active, then switch your own. */
const topCatcher: EffectHandler = {
  // full no-op only when neither half can act
  canPlay(ctx) { return bosssOrders.canPlay!(ctx) || pokemonExchange.canPlay!(ctx); },
  start(ctx) {
    const step = bosssOrders.start(ctx);
    return step === 'done' ? pokemonExchange.start(ctx) : { ...step, context: { ...step.context, step: 'opponent' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'opponent') {
      bosssOrders.resume(ctx, context, selection);
      return pokemonExchange.start(ctx);
    }
    return pokemonExchange.resume(ctx, context, selection);
  },
};

/** 沙儷 Shari: return up to 2 Pokémon cards from hand to the deck, then search that many Pokémon back. */
const shari: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const pokemonInHand = p.hand.filter(c => c.cardData.supertype === 'Pokémon');
    if (pokemonInHand.length === 0) return 'done';
    return { prompt: '沙儷：從手牌選最多 2 張寶可夢卡放回牌庫', choiceType: 'select_from_list', maxCount: 2, options: pokemonInHand.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'return' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'return') {
      let n = 0;
      for (const id of selection) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i >= 0) { p.deck.push(p.hand.splice(i, 1)[0]); n++; }
      }
      shuffleDeck(p.deck);
      if (n === 0) return 'done';
      const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon');
      if (options.length === 0) return 'done';
      return { prompt: `沙儷：從牌庫選最多 ${n} 張寶可夢卡加入手牌`, choiceType: 'select_from_list', maxCount: n, options, context: { step: 'search' } };
    }
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 火箭隊的接收器 Team Rocket's Receiver: search deck for a Supporter card whose name contains "火箭隊" to hand. */
const rocketReceiver: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Supporter') && c.cardData.name.includes('火箭隊'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '火箭隊的接收器：從牌庫選 1 張名稱中有「火箭隊」的支援者卡加入手牌', choiceType: 'select_from_list', maxCount: 1, options, context: {} };
  },
  resume: energyDelivery.resume,
};

/** 火箭隊的拉姆達 Team Rocket's Lambda: search deck for any 1 Trainer card to hand. */
const rocketLambda: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Trainer');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '火箭隊的拉姆達：從牌庫選 1 張訓練家卡加入手牌', choiceType: 'select_from_list', maxCount: 1, options, context: {} };
  },
  resume: energyDelivery.resume,
};

/** 探險家的嚮導 Explorer's Guide: look at top 6, take 2 cards to hand, discard the rest. */
const explorersGuide: EffectHandler = {
  // deck COUNT is public
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).deck.length > 0; },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-6);
    if (top.length === 0) return 'done';
    return { prompt: '探險家的嚮導：查看牌庫上方 6 張，選 2 張加入手牌（其餘丟棄）', choiceType: 'select_from_list', maxCount: Math.min(2, top.length), options: top.map(c => ({ id: c.id, label: c.cardData.name })), context: { seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i === -1) continue;
      const [card] = p.deck.splice(i, 1);
      if (selection.includes(id)) p.hand.push(card); else p.discardPile.push(card);
    }
    return 'done';
  },
};

/** 枇琶 Biwa: look at the opponent's hand, discard up to 2 Item cards from it. */
const biwa: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const items = opp.hand.filter(c => c.cardData.subtypes.includes('Item'));
    if (items.length === 0) return 'done';
    return { prompt: '枇琶：查看對手手牌，選最多 2 張物品卡丟棄', choiceType: 'select_from_list', maxCount: 2, options: items.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = opp.hand.findIndex(c => c.id === id);
      if (i >= 0) opp.discardPile.push(opp.hand.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 戰鬥鑼 Fighting Drum: search deck for 1 Basic Fighting Pokémon or 1 Basic Fighting Energy to hand. */
const fightingDrum: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c =>
      (c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && (c.cardData.types || []).includes('Fighting')) ||
      (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting'))
    );
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '戰鬥鑼：從牌庫選 1 張鬥屬性基礎寶可夢或基本鬥能量卡加入手牌', choiceType: 'select_from_list', maxCount: 1, options, context: {} };
  },
  resume: energyDelivery.resume,
};

/** N的謀劃 N's Scheme(-style): move up to 2 energy from benched Pokémon onto the Active. */
const movesBenchEnergyToActive: EffectHandler = {
  canPlay(ctx) { const p = player(ctx.G, ctx.playerIndex); return !!p.active && p.bench.some(c => c !== null && c.attachedEnergy.length > 0); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active) return 'done';
    const options: { id: string; label: string }[] = [];
    for (const c of p.bench) { if (!c) continue; for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` }); }
    if (options.length === 0) return 'done';
    return { prompt: 'N的謀劃：選最多 2 個備戰寶可夢身上的能量移到戰鬥寶可夢', choiceType: 'select_from_list', maxCount: 2, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active) return 'done';
    for (const c of p.bench) {
      if (!c) continue;
      const i = c.attachedEnergy.findIndex(e => selection.includes(e.id));
      if (i >= 0) p.active.attachedEnergy.push(c.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 希特隆的機智 Citron's Wit(-style): heal all of your own Lightning-type Pokémon by 60. */
const healAllLightning: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Lightning') && c.damage > 0);
    for (const t of targets) healDamage(t, 60);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 滿充的體貼 (full heal + return energy): fully heal one of your own Mega ("超級...ex") Pokémon and return its energy to hand. */
const fullHealMegaReturnEnergy: EffectHandler = {
  canPlay(ctx) { return allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex')); },
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex'));
    if (targets.length === 0) return 'done';
    return { prompt: '滿充的體貼：選擇要恢復的超級進化ex寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) {
      target.damage = 0;
      p.hand.push(...target.attachedEnergy.map(e => ({
        id: e.id,
        cardData: { id: e.type, name: `基本${e.type}能量`, supertype: 'Energy' as const, subtypes: ['Basic Energy' as const], types: [e.type as any], set: { id: '', name: '', series: '', printedTotal: 0, total: 0, releaseDate: '' }, number: '', legalities: {}, images: { small: '', large: '' } },
        owner: p === ctx.G.players[0] ? 0 as const : 1 as const,
        damage: 0, statusConditions: [], attachedEnergy: [],
      })));
      target.attachedEnergy = [];
    }
    return 'done';
  },
};

/** 超級信號 Mega Signal(-style): search deck for 1 "超級...ex" (Mega ex) Pokémon to hand. */
const megaSignal: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '超級信號：從牌庫選 1 張「超級進化ex」加入手牌', choiceType: 'select_from_list', maxCount: 1, options, context: {} };
  },
  resume: energyDelivery.resume,
};

/** 小光 Hikari(-style): search deck for 1 Basic + 1 Stage 1 + 1 Stage 2 Pokémon to hand. */
const hikari: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c =>
      c.cardData.supertype === 'Pokémon' &&
      (c.cardData.subtypes.includes('Basic') || c.cardData.subtypes.includes('Stage 1') || c.cardData.subtypes.includes('Stage 2'))
    );
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '小光：從牌庫選最多各 1 張基礎／1階／2階寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: 3, options, context: {} };
  },
  resume: toshi.resume,
};

/** 火箭隊的雅典娜 Team Rocket's Athena(-style): draw to 5, or to 8 if your whole board is "火箭隊的" Pokémon. */
const rocketAthena: EffectHandler = {
  start(ctx) {
    const board = allPokemon(ctx.G, ctx.playerIndex);
    const allRocket = board.length > 0 && board.every(c => c.cardData.name.includes('火箭隊'));
    drawUpTo(ctx.G, ctx.playerIndex, allRocket ? 8 : 5);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 捕蟲組合 Bug Catching Set(-style): look at top 7, take up to 1 Grass Pokémon + 1 Basic Grass Energy to hand. */
const bugCatchingSet: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-7);
    const options = top.filter(c =>
      (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Grass')) ||
      (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Grass'))
    );
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '捕蟲組合：查看牌庫上方 7 張，選最多 1 張草寶可夢卡與 1 張基本草能量卡加入手牌', choiceType: 'select_from_list', maxCount: 2, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume: durand.resume,
};

/* ============================================================ */
/*  Added for goal: match ptcg-tw-sim.com coverage for Item/     */
/*  Supporter/Stadium/Tool cards actually used in the preset      */
/*  decks (see coverage-report.ts + _deck-coverage-gap.ts).       */
/* ============================================================ */

/** 道具拆除器: discard up to 2 Pokémon Tool cards attached to EITHER side's Pokémon. */
const toolWrecker: EffectHandler = {
  canPlay(ctx) { return [...allPokemon(ctx.G, 0), ...allPokemon(ctx.G, 1)].some(c => !!c.attachedTool); },
  start(ctx) {
    const targets = [...allPokemon(ctx.G, 0), ...allPokemon(ctx.G, 1)].filter(c => c.attachedTool);
    if (targets.length === 0) return 'done';
    return { prompt: '道具拆除器：選最多 2 張雙方場上的寶可夢道具卡丟棄', choiceType: 'select_from_list', maxCount: Math.min(2, targets.length), options: targets.map(c => ({ id: c.attachedTool!.id, label: `${c.cardData.name} 的 ${c.attachedTool!.cardData.name}` })), context: {} };
  },
  resume(ctx, _context, selection) {
    for (const c of [...allPokemon(ctx.G, 0), ...allPokemon(ctx.G, 1)]) {
      if (c.attachedTool && selection.includes(c.attachedTool.id)) {
        const ownerIdx = c.owner;
        player(ctx.G, ownerIdx).discardPile.push(c.attachedTool);
        c.attachedTool = null;
      }
    }
    return 'done';
  },
};

/** 「這張卡必須在上個對手的回合自己的寶可夢【昏厥】了才可使用」 — the printed precondition shared
 * by 不公印章, 八朔 and 鏽蝕組手下. Turns strictly alternate, so the opponent's last turn is always
 * exactly G.turn - 1 (the reasoning that introduced lastPokemonFaintedTurn for 吉雉雞ex's 扭轉乾坤). */
function ownPokemonFaintedLastTurn(ctx: EffectContext): boolean {
  return player(ctx.G, ctx.playerIndex).lastPokemonFaintedTurn === ctx.G.turn - 1;
}

/** Adds that precondition to an existing handler. Gated in canPlay as well as start() on purpose:
 * the condition lives entirely in public zones, so per the EffectHandler.canPlay convention
 * getLegalMoves must never offer the card and playTrainer refunds a forced play — otherwise it
 * gets discarded for zero effect. */
function requireOwnKoLastTurn(h: EffectHandler): EffectHandler {
  return {
    ...h,
    canPlay(ctx) { return ownPokemonFaintedLastTurn(ctx) && (h.canPlay ? h.canPlay(ctx) : true); },
    start(ctx) { return ownPokemonFaintedLastTurn(ctx) ? h.start(ctx) : 'done'; },
  };
}

/** 不公印章 / 火箭隊的阿波羅-style: both reshuffle hand into deck, self draws `selfDraw`, opponent
 * draws `oppDraw`. Gated on "own Pokémon fainted during the opponent's last turn" via
 * PtcgPlayerState.lastPokemonFaintedTurn (added for 吉雉雞ex's 扭轉乾坤 — same turns-strictly-
 * alternate reasoning: the opponent's last turn is always exactly G.turn - 1). `requireGate`
 * defaults on; 火箭隊的阿波羅 opts out because its printed condition is narrower — specifically a
 * "「火箭隊的寶可夢」" fainting, not any Pokémon — and lastPokemonFaintedTurn only tracks "did
 * *something* faint," not which card. Left as the pre-existing unconditional simplification until
 * that finer-grained tracking exists; only 不公印章's broader "any of your own Pokémon" condition
 * maps cleanly onto what's tracked today. */
function mutualHandResetAbility(selfDraw: number, oppDraw: number, requireGate = true): EffectHandler {
  const gateOk = (ctx: EffectContext) => !requireGate || ownPokemonFaintedLastTurn(ctx);
  return {
    canPlay(ctx) { return gateOk(ctx); },
    start(ctx) {
      if (!gateOk(ctx)) return 'done';
      for (const [idx, count] of [[ctx.playerIndex, selfDraw], [(1 - ctx.playerIndex) as 0 | 1, oppDraw]] as const) {
        const p = player(ctx.G, idx);
        p.deck.push(...p.hand);
        p.hand = [];
        shuffleDeck(p.deck);
        drawCards(ctx.G, idx, count);
      }
      return 'done';
    },
    resume() { return 'done'; },
  };
}
const unfairSeal = mutualHandResetAbility(5, 2);
const rocketApollo = mutualHandResetAbility(5, 3, false);

/** 聖灰: from discard pile, choose up to 5 Pokémon cards, show opponent, put back into deck (reshuffled). */
const holyAsh: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => c.cardData.supertype === 'Pokémon'); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.supertype === 'Pokémon');
    if (options.length === 0) return 'done';
    return { prompt: '聖灰：從棄牌區選最多 5 張寶可夢卡放回牌庫', choiceType: 'select_from_list', maxCount: Math.min(5, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.discardPile.findIndex(c => c.id === id);
      if (i >= 0) {
        const card = p.discardPile.splice(i, 1)[0];
        resetCardForReentry(card);
        p.deck.push(card);
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 阿杏的秘招: search deck for up to 2 own Darkness Pokémon, attach 1 Basic Darkness Energy each; poison if Active. */
const asuNoHiketsu: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Darkness'));
    if (targets.length === 0) return 'done';
    return { prompt: '阿杏的秘招：選最多 2 隻自己的惡寶可夢附加基本惡能量', choiceType: 'select_pokemon', maxCount: Math.min(2, targets.length), options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const target = p.active?.id === id ? p.active : p.bench.find(c => c?.id === id);
      const i = p.deck.findIndex(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Darkness'));
      if (!target || i === -1) continue;
      const energy = p.deck.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Darkness' });
      if (target.id === p.active?.id) {
        target.statusConditions = target.statusConditions.filter(c => c !== 'Poisoned');
        target.statusConditions.push('Poisoned');
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 衝浪手: switch Active with a Benched Pokémon, then draw back up to 5. */
const surfer: EffectHandler = {
  start(ctx) {
    const step = pokemonExchange.start(ctx);
    if (step === 'done') { drawUpTo(ctx.G, ctx.playerIndex, 5); return 'done'; }
    return step;
  },
  resume(ctx, context, selection) {
    pokemonExchange.resume(ctx, context, selection);
    drawUpTo(ctx.G, ctx.playerIndex, 5);
    return 'done';
  },
};

/** 庫瑟洛斯奇的企圖: opponent discards down to 3 hand cards. */
const kusserothsAmbition: EffectHandler = {
  // hand COUNT is public information
  canPlay(ctx) { return opponent(ctx.G, ctx.playerIndex).hand.length > 3; },
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    while (opp.hand.length > 3) opp.discardPile.push(opp.hand.pop()!);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 阿響的冒險: search deck for "阿響的" family Pokémon + Basic Fire Energy, up to 3 total, to hand. */
const hibikisAdventure: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c =>
      (c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('阿響的')) ||
      (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire')));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '阿響的冒險：從牌庫選合計最多 3 張「阿響的」寶可夢／基本火能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: (ctx, _context, selection) => {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 暗碼迷的解讀: look at top 2 of deck, put back on top in whatever order chosen (rest of deck untouched, no reshuffle). */
const decoderMania: EffectHandler = {
  // deck COUNT is public
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).deck.length > 0; },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-2);
    if (top.length === 0) return 'done';
    return { prompt: '暗碼迷的解讀：查看牌庫上方 2 張，以任意順序放回牌庫上方', choiceType: 'select_from_list', count: top.length, options: top.map(c => ({ id: c.id, label: c.cardData.name })), context: { seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    const seen: GameCard[] = [];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
    }
    // selection order = desired stacking order, first selected ends up on top (pushed last since deck top = end of array).
    for (const id of [...selection].reverse()) {
      const c = seen.find(s => s.id === id);
      if (c) p.deck.push(c);
    }
    return 'done';
  },
};

/** 賽吉: search deck for 1 evolution of an own field Pokémon (that itself has no ability), evolve it directly, bypassing the "played this turn" restriction. */
const saijo: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => !t.cardData.abilities?.some(a => a.text));
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon' && targets.some(t => evolvesFromMatches(c.cardData, t.cardData.name)));
    if (options.length === 0 || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '賽吉：從牌庫選 1 張進化卡直接進化場上寶可夢', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_card' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_card') {
      const cardId = selection[0];
      const card = p.deck.find(c => c.id === cardId);
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => !t.cardData.abilities?.some(a => a.text) && !!card && evolvesFromMatches(card.cardData, t.cardData.name));
      if (!card || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return { prompt: '賽吉：選擇要進化的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', cardId } };
    }
    const cardId = context.cardId as string;
    const targetId = selection[0];
    const deckIdx = p.deck.findIndex(c => c.id === cardId);
    if (deckIdx === -1) { shuffleDeck(p.deck); return 'done'; }
    const evolution = p.deck.splice(deckIdx, 1)[0];
    shuffleDeck(p.deck);
    const isActive = p.active?.id === targetId;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === targetId);
    const old = isActive ? p.active : (benchIdx >= 0 ? p.bench[benchIdx] : null);
    if (!old) { p.discardPile.push(evolution); return 'done'; }
    evolution.attachedEnergy = old.attachedEnergy;
    evolution.damage = old.damage;
    evolution.attachedTool = old.attachedTool;
    stackAsPreEvolution(evolution, old);
    if (isActive) p.active = evolution; else p.bench[benchIdx] = evolution;
    return 'done';
  },
};

/** N的ＰＰ提升劑: from discard, 1 Basic Energy, attach to a Benched "N的" family Pokémon. */
const nsBooster: EffectHandler = {
  canPlay(ctx) { const p = player(ctx.G, ctx.playerIndex); return p.bench.some(c => c !== null && c.cardData.name.includes('N的')) && p.discardPile.some(c => c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null && c.cardData.name.includes('N的'));
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: 'N的ＰＰ提升劑：從棄牌區選 1 張基本能量卡附於備戰區的「N的」寶可夢', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = p.bench.filter((c): c is GameCard => c !== null && c.cardData.name.includes('N的'));
      return { prompt: 'N的ＰＰ提升劑：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const energyId = context.energyId as string;
    const target = p.bench.find(c => c?.id === selection[0]);
    const i = p.discardPile.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.discardPile.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
};

/** 玻璃喇叭: from discard, choose up to 2 own Benched Colorless Pokémon, attach 1 Basic Energy each from discard.
 * (The printed "only with a Tera Pokémon in play" gate can't be checked — Tera isn't modeled in this
 * project's card data — so it's always available, a documented simplification.) */
const glassHorn: EffectHandler = {
  canPlay(ctx) { const p = player(ctx.G, ctx.playerIndex); return p.bench.some(c => c !== null && (c.cardData.types || []).includes('Colorless')) && p.discardPile.some(c => c.cardData.subtypes.includes('Basic Energy')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Colorless'));
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '玻璃喇叭：選最多 2 隻備戰區的無屬性寶可夢，各附加 1 張棄牌區的基本能量', choiceType: 'select_pokemon', maxCount: Math.min(2, targets.length), options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const target = p.bench.find(c => c?.id === id);
      const i = p.discardPile.findIndex(c => c.cardData.subtypes.includes('Basic Energy'));
      if (!target || i === -1) continue;
      const energy = p.discardPile.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
};

/** 調換票: reshuffle your prize cards (count preserved, identities randomized). */
const tradeTicket: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const n = p.prizes.length;
    p.deck.push(...p.prizes);
    p.prizes = [];
    shuffleDeck(p.deck);
    for (let i = 0; i < n && p.deck.length > 0; i++) p.prizes.push(p.deck.pop()!);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 秘密箱: discard 3 hand cards, then search 1 each of Item/Pokémon Tool/Supporter/Stadium from deck to hand. */
const secretBox: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).hand.filter(c => c.id !== ctx.sourceCardId).length >= 3; },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length < 3) return 'done';
    return { prompt: '秘密箱：選 3 張手牌丟棄', choiceType: 'select_hand_cards', count: 3, context: { step: 'discard' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'discard') {
      discardFromHand(ctx.G, ctx.playerIndex, selection);
      const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Item') || c.cardData.subtypes.includes('Pokémon Tool') || c.cardData.subtypes.includes('Supporter') || c.cardData.subtypes.includes('Stadium'));
      if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return { prompt: '秘密箱：從牌庫選 1 張物品／道具／支援者／競技場卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(4, options.length), options, context: { step: 'search' } };
    }
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 火箭隊的坂木: swap own Active ↔ Benched "火箭隊的" Pokémon (only if Active already is one), then force-switch 1 opponent Benched Pokémon in. */
const rocketSakaki: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active?.cardData.name.includes('火箭隊的')) return bosssOrders.start(ctx);
    const targets = p.bench.filter((c): c is GameCard => c !== null && c.cardData.name.includes('火箭隊的'));
    if (targets.length === 0) return bosssOrders.start(ctx);
    return { prompt: '火箭隊的坂木：選擇要換上場的「火箭隊的」寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'own_switch' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'own_switch') {
      const idx = p.bench.findIndex(c => c?.id === selection[0]);
      if (idx >= 0 && p.active) { const b = p.bench[idx]!; clearStatusConditionsOnLeaveActive(p.active); p.bench[idx] = p.active; p.active = b; }
      return bosssOrders.start(ctx);
    }
    return bosssOrders.resume(ctx, context, selection);
  },
};

/** 小剛的發掘: search deck for up to 2 Basic Pokémon or 1 evolved Pokémon (combined list, up to 2), to hand. */
const takeshisExcavation: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && (c.cardData.subtypes.includes('Basic') || hasEvolvesFrom(c.cardData)));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '小剛的發掘：從牌庫選最多 2 張基礎寶可夢卡，或 1 張進化寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 烏栗: choose either switch Active↔Bench, OR this turn +30 damage vs ex/V Pokémon. */
const uguisu: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const canSwitch = !!p.active && p.bench.some(s => s !== null);
    const options = [
      ...(canSwitch ? [{ id: 'switch', label: '將戰鬥寶可夢與備戰寶可夢互換' }] : []),
      { id: 'boost', label: '這個回合，自己的寶可夢對「寶可夢【ex】／【V】」造成的傷害 +30' },
    ];
    return { prompt: '烏栗：選擇效果', choiceType: 'select_from_list', count: 1, options, context: { step: 'choose' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'choose') {
      if (selection[0] === 'switch') {
        const step = pokemonExchange.start(ctx);
        return step === 'done' ? 'done' : { ...step, context: { ...step.context, step: 'switch' } };
      }
      player(ctx.G, ctx.playerIndex).turnDamageBoosts.push({ vsBigOnly: true, amount: 30 });
      return 'done';
    }
    return pokemonExchange.resume(ctx, context, selection);
  },
};

/** 奇跡耳麥: from discard, choose up to 2 Supporter cards to hand. */
const miracleHeadset: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => c.cardData.subtypes.includes('Supporter')); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Supporter'));
    if (options.length === 0) return 'done';
    return { prompt: '奇跡耳麥：從棄牌區選最多 2 張支援者卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    for (const id of selection) moveDiscardCardToHand(ctx.G, ctx.playerIndex, id);
    return 'done';
  },
};

/** 丹瑜: discard entire hand, draw 5. (Playable on the first player's first turn — see FIRST_TURN_SUPPORTER_EXCEPTIONS.) */
const tanyu: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    p.discardPile.push(...p.hand);
    p.hand = [];
    drawCards(ctx.G, ctx.playerIndex, 5);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 白蕾雅: if the opponent has exactly 2 prizes remaining, your next KO this turn awards 1 bonus prize. */
const whiteLyra: EffectHandler = {
  canPlay(ctx) { return opponent(ctx.G, ctx.playerIndex).prizes.length === 2; },
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.prizes.length !== 2) return 'done';
    player(ctx.G, ctx.playerIndex).bonusPrizeNextKo = 1;
    return 'done';
  },
  resume() { return 'done'; },
};

/** 席藍: search deck for up to 3 "Pokémon【ex】" cards to hand. */
const seiran: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('ex'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '席藍：從牌庫選最多 3 張「寶可夢【ex】」卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 太晶珠: search deck for 1 Pokémon whose name contains "太晶" (best-effort Tera stand-in — see 玻璃喇叭 note) to hand. */
const teraOrb: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('太晶'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '太晶珠：從牌庫選 1 張「太晶」寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 寶可夢中心的姐姐: heal 60 on ONE chosen own Pokémon and clear all its Special Conditions.
 * (The Standard print SV-214 reads 「將自己的1隻寶可夢恢復「60」HP，特殊狀態也全部恢復。」 — an
 * older print healed a flat amount across the whole team, which is what this used to implement.) */
const pokemonCenterLady: EffectHandler = {
  // Worth playing for the status cure alone, so an undamaged-but-Confused team still qualifies.
  canPlay(ctx) { return allPokemon(ctx.G, ctx.playerIndex).some(c => c.damage > 0 || c.statusConditions.length > 0); },
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0 || c.statusConditions.length > 0);
    if (targets.length === 0) return 'done';
    return {
      prompt: '寶可夢中心的姐姐：選擇要恢復 60 HP 並解除特殊狀態的寶可夢',
      choiceType: 'select_pokemon',
      count: 1,
      options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害${c.statusConditions.length ? `、${c.statusConditions.join('/')}` : ''}）` })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) {
      healDamage(target, 60);
      target.statusConditions = [];
    }
    return 'done';
  },
};

/** 青木的手法: discard entire hand, then search 1 Pokémon + 1 Supporter + 1 Basic Energy (up to 3 total) from deck to hand. */
const aokisMethod: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    p.discardPile.push(...p.hand);
    p.hand = [];
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' || c.cardData.subtypes.includes('Supporter') || c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '青木的手法：從牌庫選最多 3 張（寶可夢／支援者／基本能量各 1）加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 奇跡修正檔: from discard, 1 Basic Psychic Energy, attach to a Benched Psychic Pokémon. */
const miracleCipher: EffectHandler = {
  // Discard pile and bench are public zones: with no Basic Psychic Energy discarded or no
  // Benched Psychic Pokémon, start() would bail untouched and the card be wasted.
  canPlay(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    return p.bench.some(c => c !== null && (c.cardData.types || []).includes('Psychic'))
      && p.discardPile.some(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Psychic'));
  },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Psychic'));
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Psychic'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '奇跡修正檔：從棄牌區選 1 張基本超能量卡', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Psychic'));
      return { prompt: '奇跡修正檔：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const energyId = context.energyId as string;
    const target = p.bench.find(c => c?.id === selection[0]);
    const i = p.discardPile.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.discardPile.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Psychic' });
    }
    return 'done';
  },
};

/** 力量蛋白飲: this turn, your Fighting Pokémon's attacks deal +30 damage. */
const powerProtein: EffectHandler = {
  start(ctx) {
    player(ctx.G, ctx.playerIndex).turnDamageBoosts.push({ typeFilter: 'Fighting', amount: 30 });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 特殊紅牌: if the opponent has 3 or fewer prizes remaining, they shuffle their hand into their deck and draw 3. */
const specialRedCard: EffectHandler = {
  canPlay(ctx) { return opponent(ctx.G, ctx.playerIndex).prizes.length <= 3; },
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.prizes.length > 3) return 'done';
    const oppIdx = (1 - ctx.playerIndex) as 0 | 1;
    opp.deck.push(...opp.hand);
    opp.hand = [];
    shuffleDeck(opp.deck);
    drawCards(ctx.G, oppIdx, 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 鳴依的勉勵: only if you have MORE prizes remaining than the opponent (i.e. you're behind); from discard, up to 2 Basic Energy to a Stage 2 Pokémon. */
const naeisEncouragement: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (p.prizes.length <= opp.prizes.length) return 'done';
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.subtypes.includes('Stage 2'));
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '鳴依的勉勵：從棄牌區選最多 2 張基本能量卡', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.subtypes.includes('Stage 2'));
      return { prompt: '鳴依的勉勵：選擇要附加能量的 2 階寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.discardPile.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.discardPile.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    return 'done';
  },
};

/** 吉普索: from discard, up to 2 Basic Metal Energy, attach to an own Metal Pokémon. */
const jipuso: EffectHandler = {
  canPlay(ctx) { const p = player(ctx.G, ctx.playerIndex); return allPokemon(ctx.G, ctx.playerIndex).some(c => (c.cardData.types || []).includes('Metal')) && p.discardPile.some(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Metal')); },
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Metal'));
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Metal'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '吉普索：從棄牌區選最多 2 張基本鋼能量卡', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Metal'));
      return { prompt: '吉普索：選擇要附加能量的鋼寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.discardPile.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.discardPile.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: 'Metal' });
      }
    }
    return 'done';
  },
};

/** 空手道王的演練: this turn, your Pokémon's attacks deal +40 damage to the opponent's ex/V Pokémon. */
const karateKingsPractice: EffectHandler = {
  start(ctx) {
    player(ctx.G, ctx.playerIndex).turnDamageBoosts.push({ vsBigOnly: true, amount: 40 });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 高溫燃燒器: discard 1 Basic Fire Energy from hand, then discard 1 of the opponent's attached Pokémon Tool / Special Energy / Stadium. */
const highTempBurner: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const cost = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    if (cost.length === 0) return 'done';
    return { prompt: '高溫燃燒器：丟棄 1 張手牌的基本火能量卡', choiceType: 'select_from_list', count: 1, options: cost.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pay_cost' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pay_cost') {
      const i = p.hand.findIndex(c => c.id === selection[0]);
      if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
      const opp = opponent(ctx.G, ctx.playerIndex);
      const oppTargets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1);
      const options: { id: string; label: string }[] = [];
      for (const c of oppTargets) {
        if (c.attachedTool) options.push({ id: c.attachedTool.id, label: `${c.cardData.name} 的 ${c.attachedTool.cardData.name}` });
        for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的能量` });
      }
      if (ctx.G.activeStadium) options.push({ id: ctx.G.activeStadium.id, label: `場地：${ctx.G.activeStadium.cardData.name}` });
      if (options.length === 0) return 'done';
      return { prompt: '高溫燃燒器：選擇要丟棄的對手道具／特殊能量／場地卡', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_target' } };
    }
    const targetId = selection[0];
    if (ctx.G.activeStadium?.id === targetId) {
      player(ctx.G, ctx.G.activeStadium.owner).discardPile.push(ctx.G.activeStadium);
      ctx.G.activeStadium = null;
      return 'done';
    }
    for (const c of allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1)) {
      if (c.attachedTool?.id === targetId) {
        player(ctx.G, c.owner).discardPile.push(c.attachedTool);
        c.attachedTool = null;
        return 'done';
      }
      const i = c.attachedEnergy.findIndex(e => e.id === targetId);
      if (i >= 0) { discardAttachedEnergy(ctx.G, c.owner, c.attachedEnergy.splice(i, 1)[0]); return 'done'; }
    }
    return 'done';
  },
};

/** 塔拉剛: from discard, up to 4 total of Fighting Pokémon + Basic Fighting Energy, to hand. */
const taragan: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Fighting')) || (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting'))); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c =>
      (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Fighting')) ||
      (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting')));
    if (options.length === 0) return 'done';
    return { prompt: '塔拉剛：從棄牌區選最多 4 張鬥寶可夢／基本鬥能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(4, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    for (const id of selection) moveDiscardCardToHand(ctx.G, ctx.playerIndex, id);
    return 'done';
  },
};

/** 完全體攪拌器: mill up to 5 cards from your own deck to the discard pile, reshuffle the rest. */
const perfectBlender: EffectHandler = {
  // deck COUNT is public
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).deck.length > 0; },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.deck.length === 0) return 'done';
    return { prompt: '完全體攪拌器：從牌庫任意選最多 5 張丟棄', choiceType: 'select_from_list', maxCount: Math.min(5, p.deck.length), options: p.deck.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) p.discardPile.push(p.deck.splice(i, 1)[0]);
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** AZ的平和: switch Active↔Bench; if an ex Pokémon comes into the Active Spot, heal it 80. */
const azsPeace: EffectHandler = {
  start(ctx) { return pokemonExchange.start(ctx); },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const result = pokemonExchange.resume(ctx, context, selection);
    if (p.active?.cardData.subtypes.includes('ex')) healDamage(p.active, 80);
    return result;
  },
};

/** 貴重手推車: search the ENTIRE deck for Basic Pokémon, place all of them onto the Bench (up to available slots). */
const preciousCart: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const emptySlots = p.bench.filter(s => s === null).length;
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
    if (emptySlots === 0 || options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '貴重手推車：從牌庫選任意數量的基礎寶可夢卡放置於備戰區', choiceType: 'select_from_list', maxCount: Math.min(emptySlots, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const slot = p.bench.findIndex(s => s === null);
      const i = p.deck.findIndex(c => c.id === id);
      if (slot === -1 || i === -1) continue;
      p.bench[slot] = p.deck.splice(i, 1)[0];
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 洛拍棒: look at top 4 of deck, take any number of Supporter cards to hand, reshuffle the rest. */
const lopaStick: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-4);
    const supporters = top.filter(c => c.cardData.subtypes.includes('Supporter'));
    if (supporters.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '洛拍棒：查看牌庫上方 4 張，選任意數量的支援者卡加入手牌', choiceType: 'select_from_list', maxCount: supporters.length, options: supporters.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 超大冰淇淋: heal your Active Pokémon 80, but only if it has 3+ Energy attached. */
const superJumboIceCream: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active && p.active.attachedEnergy.length >= 3) healDamage(p.active, 80);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 豐收漁網: from discard, up to 3 each of Water Pokémon + Basic Water Energy, show opponent, back into the deck (reshuffled) — not hand. */
const harvestNet: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).discardPile.some(c => (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Water')) || (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Water'))); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c =>
      (c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Water')) ||
      (c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Water')));
    if (options.length === 0) return 'done';
    return { prompt: '豐收漁網：從棄牌區選最多合計 3 張水寶可夢／基本水能量卡放回牌庫', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.discardPile.findIndex(c => c.id === id);
      if (i >= 0) {
        const card = p.discardPile.splice(i, 1)[0];
        resetCardForReentry(card);
        p.deck.push(card);
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 小霞的朝氣: ends your turn; from deck, up to 4 Basic Water Energy, all attached to 1 chosen Pokémon, reshuffle. */
const kasumisSpirit: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Water'));
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (options.length === 0 || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '小霞的朝氣：從牌庫選最多 4 張基本水能量卡', choiceType: 'select_from_list', maxCount: Math.min(4, options.length), options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) { shuffleDeck(p.deck); return 'done'; }
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '小霞的朝氣：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.deck.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: 'Water' });
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 沐淨: discard up to 2 non-rule-box Pokémon cards from hand, draw 3 cards per card discarded. */
const mujing: EffectHandler = {
  canPlay(ctx) { return player(ctx.G, ctx.playerIndex).hand.some(c => c.cardData.supertype === 'Pokémon' && hasNoRuleBox(c)); },
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.supertype === 'Pokémon' && hasNoRuleBox(c));
    if (options.length === 0) return 'done';
    return { prompt: '沐淨：選最多 2 張手牌的寶可夢卡丟棄（每張抽 3 張）', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    discardFromHand(ctx.G, ctx.playerIndex, selection);
    drawCards(ctx.G, ctx.playerIndex, selection.length * 3);
    return 'done';
  },
};

/** 琵魯: optionally discard any number of hand cards first, then draw back up to 5. */
const piru: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) { drawUpTo(ctx.G, ctx.playerIndex, 5); return 'done'; }
    return { prompt: '琵魯：可選任意數量手牌丟棄，之後補抽到 5 張', choiceType: 'select_from_list', maxCount: p.hand.length, options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    if (selection.length > 0) discardFromHand(ctx.G, ctx.playerIndex, selection);
    drawUpTo(ctx.G, ctx.playerIndex, 5);
    return 'done';
  },
};

/** 火箭隊的蘭斯: search deck for up to 3 Basic "火箭隊的" family Pokémon to hand. (Playable on the first player's first turn — see FIRST_TURN_SUPPORTER_EXCEPTIONS.) */
const rocketLance: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && c.cardData.name.includes('火箭隊的'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '火箭隊的蘭斯：從牌庫選最多 3 張基礎「火箭隊的」寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 吹火人: search deck for up to 7 Basic Fire Energy to hand. */
const fireBreather: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '吹火人：從牌庫選最多 7 張基本火能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(7, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/* ============================================================ */
/*  Batch 3: next tier of real, frequently-reprinted Item/       */
/*  Supporter cards by usage across the full card pool (not      */
/*  just preset decks) — see coverage-report.ts's top-uncovered  */
/*  list. A few needing genuinely new scheduling infrastructure   */
/*  ("during the opponent's NEXT turn only", guess-a-number       */
/*  minigames, fossil-as-Pokémon placement) are deliberately      */
/*  left unimplemented rather than faked — see the final report. */
/* ============================================================ */

/** 精靈球: flip a coin; if heads, search deck for 1 Pokémon to hand. */
const pokeBall: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '精靈球：擲硬幣正面，從牌庫選 1 張寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveFromDeckToHand(ctx.G, ctx.playerIndex, selection[0], false); else shuffleDeck(p.deck);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 大師球: search deck for 1 Pokémon to hand (guaranteed). */
const masterBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '大師球：從牌庫選 1 張寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: pokeBall.resume,
};

/** 危險光線: the opponent's Active is Burned and Confused. */
const dangerRay: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) {
      opp.active.statusConditions = opp.active.statusConditions.filter(c => c !== 'Burned' && c !== 'Confused');
      opp.active.statusConditions.push('Burned', 'Confused');
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 高級香氛: search deck for up to 3 Stage 1 Pokémon to hand. */
const premiumIncense: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Stage 1'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '高級香氛：從牌庫選最多 3 張 1 階進化寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 寶可生機劑A: heal 150 on a chosen own Pokémon. (The "can never leave the discard pile once there" clause isn't enforced.) */
const pokeVitalA: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '寶可生機劑A：選擇要恢復 150 HP 的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) healDamage(target, 150);
    return 'done';
  },
};

/** 派帕的三明治: heal own Active 30, or 100 if it's a "派帕的" family Pokémon. */
const paipasSandwich: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active) healDamage(p.active, p.active.cardData.name.includes('派帕的') ? 100 : 30);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 龍之秘藥: heal own Active 60, only if it's a Dragon-type Pokémon. */
const dragonElixir: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active && (p.active.cardData.types || []).includes('Dragon')) healDamage(p.active, 60);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 管理員: draw 2. (The "if 居民會館 is active, return to deck instead of discard" clause isn't enforced.) */
const caretaker: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 2);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 主持人的帶動: draw 2, plus 2 more if the opponent has 3 or fewer prizes remaining. */
const hostsEncouragement: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    drawCards(ctx.G, ctx.playerIndex, opp.prizes.length <= 3 ? 4 : 2);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 仙后: only usable when it was the player's only hand card; search deck for up to 2 cards (any) to hand. */
const queenCard: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length !== 0) return 'done';
    if (p.deck.length === 0) return 'done';
    return { prompt: '仙后：從牌庫任意選最多 2 張卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, p.deck.length), options: p.deck.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 手部修剪器: both players discard hand down to 5 (opponent conceptually goes first, order doesn't matter mechanically). */
const handTrimmer: EffectHandler = {
  start(ctx) {
    for (const idx of [(1 - ctx.playerIndex) as 0 | 1, ctx.playerIndex] as const) {
      const p = player(ctx.G, idx);
      while (p.hand.length > 5) p.discardPile.push(p.hand.pop()!);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 琉琪亞的展示: force-switch 1 opponent Benched Basic Pokémon into Active, then Confuse it. */
const lucasShowcase: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = opp.bench.filter((c): c is GameCard => c !== null && c.cardData.subtypes.includes('Basic'));
    if (targets.length === 0) return 'done';
    return { prompt: '琉琪亞的展示：選擇對手備戰區的 1 隻基礎寶可夢換上場', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
      applyStatusCondition(chosen, 'Confused');
    } else if (idx >= 0 && !opp.active) {
      opp.active = opp.bench[idx];
      opp.bench[idx] = null;
    }
    return 'done';
  },
};

/** 重新啟動箱: from discard, attach 1 Basic Energy each to every own "Future"-subtype Pokémon (auto-resolved, no choice). */
const restartBox: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const futures = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.subtypes.includes('Future'));
    for (const target of futures) {
      const i = p.discardPile.findIndex(c => c.cardData.subtypes.includes('Basic Energy'));
      if (i === -1) break;
      const energy = p.discardPile.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 白露的真心: fully heal 1 own Pokémon whose remaining HP is 30 or less. */
const shiroroNoKokoro: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => {
      const hp = parseInt(c.cardData.hp || '0', 10);
      return hp > 0 && hp - c.damage <= 30 && c.damage > 0;
    });
    if (targets.length === 0) return 'done';
    return { prompt: '白露的真心：選擇要完全恢復 HP 的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) target.damage = 0;
    return 'done';
  },
};

/** 火箭隊的超級球: flip a coin; search deck for 1 "火箭隊的" Pokémon — evolved if heads, Basic if tails — to hand. */
const rocketSuperBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const heads = flipCoin();
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('火箭隊的')
      && (heads ? hasEvolvesFrom(c.cardData) : c.cardData.subtypes.includes('Basic')));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: `火箭隊的超級球：擲硬幣${heads ? '正面' : '反面'}，選 1 張${heads ? '進化' : '基礎'}的「火箭隊的寶可夢」加入手牌`, choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: pokeBall.resume,
};

/** 好傷藥: heal 60 on a chosen own Pokémon, then discard 1 Energy attached to it. */
const goodPotion: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '好傷藥：選擇要恢復 60 HP 的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })), context: { step: 'pick_target' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_target') {
      const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
      if (!target) return 'done';
      healDamage(target, 60);
      if (target.attachedEnergy.length === 0) return 'done';
      return { prompt: '好傷藥：選擇要丟棄的能量', choiceType: 'select_from_list', count: 1, options: target.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: { step: 'discard_energy', targetId: target.id } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === context.targetId);
    if (target) {
      const i = target.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) discardAttachedEnergy(ctx.G, ctx.playerIndex, target.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 火箭隊的驚嚇炸彈: flip a coin; heads places 2 counters on an opponent Pokémon, tails places 2 on your own Active. */
const rocketScareBomb: EffectHandler = {
  start(ctx) {
    if (flipCoin()) {
      const opp = opponent(ctx.G, ctx.playerIndex);
      const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
      if (targets.length === 0) return 'done';
      return { prompt: '火箭隊的驚嚇炸彈：擲硬幣正面，選擇對手 1 隻寶可夢放置 2 個傷害指示物', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { side: 'opponent' } };
    }
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active) {
      p.active.damage += 20;
      const hp = parseInt(p.active.cardData.hp || '0', 10);
      if (hp > 0 && p.active.damage >= hp) handleKo(ctx.G, ctx.playerIndex, p.active.id);
    }
    return 'done';
  },
  resume(ctx, context, selection) {
    if (context.side === 'opponent') {
      const opp = opponent(ctx.G, ctx.playerIndex);
      const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
      if (target) {
        target.damage += 20;
        const hp = parseInt(target.cardData.hp || '0', 10);
        if (hp > 0 && target.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
      }
    }
    return 'done';
  },
};

/** 鬼之假面: from discard, search 1 "厄鬼椪" ex Pokémon, swap it in for an own field "厄鬼椪" ex Pokémon (energy/damage/status carried over), discard the old one. */
const oniMask: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const discardOptions = deckOptions(p.discardPile, c => c.cardData.name.includes('厄鬼椪') && c.cardData.subtypes.includes('ex'));
    const fieldTargets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.includes('厄鬼椪') && c.cardData.subtypes.includes('ex'));
    if (discardOptions.length === 0 || fieldTargets.length === 0) return 'done';
    return { prompt: '鬼之假面：從棄牌區選 1 張「厄鬼椪」寶可夢【ex】卡', choiceType: 'select_from_list', count: 1, options: discardOptions, context: { step: 'pick_card' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_card') {
      const fieldTargets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.includes('厄鬼椪') && c.cardData.subtypes.includes('ex'));
      return { prompt: '鬼之假面：選擇要替換的場上寶可夢', choiceType: 'select_pokemon', count: 1, options: fieldTargets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', cardId: selection[0] } };
    }
    const cardId = context.cardId as string;
    const targetId = selection[0];
    const discardIdx = p.discardPile.findIndex(c => c.id === cardId);
    if (discardIdx === -1) return 'done';
    const replacement = p.discardPile.splice(discardIdx, 1)[0];
    const isActive = p.active?.id === targetId;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === targetId);
    const old = isActive ? p.active : (benchIdx >= 0 ? p.bench[benchIdx] : null);
    if (!old) { p.discardPile.push(replacement); return 'done'; }
    // Not an evolution — `old` is genuinely leaving play for good (replaced by a same-name
    // discard-pile copy), so any stacked pre-evolution history goes to discard along with it,
    // same as a KO would (it doesn't transfer onto `replacement`, which is its own card).
    flushPreEvolutionsToDiscard(old, p.discardPile);
    p.discardPile.push(old);
    replacement.attachedEnergy = old.attachedEnergy;
    replacement.damage = old.damage;
    replacement.attachedTool = old.attachedTool;
    replacement.statusConditions = old.statusConditions;
    if (isActive) p.active = replacement; else p.bench[benchIdx] = replacement;
    return 'done';
  },
};

/** 赫普的包包: search deck for up to 2 Basic "赫普的" family Pokémon, place them on the Bench. */
const heapsBag: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const emptySlots = p.bench.filter(s => s === null).length;
    const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && c.cardData.name.includes('赫普的'));
    if (emptySlots === 0 || options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '赫普的包包：從牌庫選最多 2 張基礎「赫普的」寶可夢卡放置於備戰區', choiceType: 'select_from_list', maxCount: Math.min(2, emptySlots, options.length), options, context: {} };
  },
  resume: preciousCart.resume,
};

/** 泰姆: no real guess-a-number minigame (no opponent interactivity to guess against) — resolves in the player's favor: draw 4, card returns to hand. */
const tim: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 4);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 寶可夢旋風回收機: return 1 own field Pokémon (and its attached cards) to hand. */
const pokemonCyclone: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (targets.length === 0) return 'done';
    return { prompt: '寶可夢旋風回收機：選擇要收回手牌的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const targetId = selection[0];
    const isActive = p.active?.id === targetId;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === targetId);
    const target = isActive ? p.active : (benchIdx >= 0 ? p.bench[benchIdx] : null);
    if (!target) return 'done';
    if (target.attachedTool) p.hand.push(target.attachedTool);
    // Attached Energy is represented on the Pokémon as {id,type} only, not a full Card object,
    // so it can't be reconstructed back into hand — discarded instead (documented simplification).
    // Only the top card returns to hand — any stacked pre-evolution history is discarded, not
    // carried along as a hidden freebie.
    flushPreEvolutionsToDiscard(target, p.discardPile);
    p.hand.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, preEvolutions: undefined });
    if (isActive) p.active = null; else p.bench[benchIdx] = null;
    return 'done';
  },
};

/** 推理組合: look at top 3, either reorder them on top, or shuffle them back into the deck. */
const deductionSet: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-3);
    if (top.length === 0) return 'done';
    return { prompt: '推理組合：查看牌庫上方 3 張，選擇順序放回上方（不選則洗回牌庫）', choiceType: 'select_from_list', maxCount: top.length, options: top.map(c => ({ id: c.id, label: c.cardData.name })), context: { seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    const seen: GameCard[] = [];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
    }
    if (selection.length === 0) {
      p.deck.push(...seen);
      shuffleDeck(p.deck);
      return 'done';
    }
    for (const id of [...selection].reverse()) {
      const c = seen.find(s => s.id === id);
      if (c) p.deck.push(c);
    }
    return 'done';
  },
};

/** 可怕的哥哥: choose 1 opponent Pokémon, discard 1 attached Tool and 1 attached Energy from it. */
const scaryBrother: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null && (!!c.attachedTool || c.attachedEnergy.length > 0));
    if (targets.length === 0) return 'done';
    return { prompt: '可怕的哥哥：選擇對手 1 隻寶可夢，丟棄其道具與 1 張能量', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
    if (target) {
      if (target.attachedTool) { opp.discardPile.push(target.attachedTool); target.attachedTool = null; }
      if (target.attachedEnergy.length > 0) discardAttachedEnergy(ctx.G, target.owner, target.attachedEnergy.splice(0, 1)[0]);
    }
    return 'done';
  },
};

/** 急進開關: switch Active↔Bench, then optionally move any attached energy from the newly-Benched Pokémon onto the new Active. */
const rapidSwitch: EffectHandler = {
  start(ctx) {
    const step = pokemonExchange.start(ctx);
    return step === 'done' ? 'done' : { ...step, context: { ...step.context, step: 'switch' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'switch') {
      const oldActiveId = p.active?.id;
      pokemonExchange.resume(ctx, {}, selection);
      const movedOut = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === oldActiveId);
      if (!movedOut || movedOut.attachedEnergy.length === 0 || !p.active) return 'done';
      return { prompt: '急進開關：選擇要移動到新戰鬥寶可夢身上的能量（可不選）', choiceType: 'select_from_list', maxCount: movedOut.attachedEnergy.length, options: movedOut.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: { step: 'move_energy', sourceId: oldActiveId } };
    }
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === context.sourceId);
    if (source && p.active) {
      source.attachedEnergy = source.attachedEnergy.filter(e => {
        if (selection.includes(e.id)) { p.active!.attachedEnergy.push(e); return false; }
        return true;
      });
    }
    return 'done';
  },
};

/** 八朔: look at top 8, take up to 3 to hand, reshuffle the rest. (The printed "own Pokémon fainted last opponent-turn" gate can't be checked — same documented simplification used elsewhere.) */
const hazaku: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-8);
    if (top.length === 0) return 'done';
    return { prompt: '八朔：查看牌庫上方 8 張，選最多 3 張加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, top.length), options: top.map(c => ({ id: c.id, label: c.cardData.name })), context: { seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 海岱: return 2 hand cards to the bottom of the deck, then draw 4. */
const haidai: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length < 2) return 'done';
    return { prompt: '海岱：選 2 張手牌放回牌庫下方', choiceType: 'select_from_list', count: 2, options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.hand.findIndex(c => c.id === id);
      if (i >= 0) p.deck.unshift(p.hand.splice(i, 1)[0]);
    }
    drawCards(ctx.G, ctx.playerIndex, 4);
    return 'done';
  },
};

/** 阿蜜的目光: during the opponent's next turn, all your Pokémon take -30 damage from their attacks. */
const amisGaze: EffectHandler = {
  start(ctx) {
    player(ctx.G, ctx.playerIndex).incomingDamageReduction.push({ amount: 30 });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 納莉: draw 4. (The "discard your whole hand if you still have 5+ cards at end of this turn" clause isn't enforced — no end-of-turn hook exists yet.) */
const nari: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 4);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 格拉吉歐的決戰: only usable when it was the player's only hand card; this turn, non-rule-box own Pokémon's attacks deal +80. */
const gladionsShowdown: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length !== 0) return 'done';
    p.turnDamageBoosts.push({ amount: 80, excludeRuleBoxAttacker: true });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 鐵之防禦強化: during the opponent's next turn, your Metal Pokémon take -30 damage from their attacks. */
const ironDefenseBoost: EffectHandler = {
  start(ctx) {
    player(ctx.G, ctx.playerIndex).incomingDamageReduction.push({ typeFilter: 'Metal', amount: 30 });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 由紫: heal 150 on 1 own Psychic Pokémon. */
const yuzi: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Psychic') && c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '由紫：選擇要恢復 150 HP 的超系寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) healDamage(target, 150);
    return 'done';
  },
};

/** 馬志士的交易: since there's no opponent interactivity, always resolves as if the opponent declined: draw 4. */
const majisisTrade: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 4);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 真菰: heal 40 on every own Pokémon. */
const makomo: EffectHandler = {
  start(ctx) {
    for (const c of allPokemon(ctx.G, ctx.playerIndex)) healDamage(c, 40);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 卡娜莉: discard 1 hand card, search deck for up to 4 Lightning Pokémon to hand. */
const canary: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return { prompt: '卡娜莉：選 1 張手牌丟棄', choiceType: 'select_hand_cards', count: 1, context: { step: 'discard' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'discard') {
      discardFromHand(ctx.G, ctx.playerIndex, selection);
      const options = deckOptions(p.deck, c => c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Lightning'));
      if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return { prompt: '卡娜莉：從牌庫選最多 4 張雷寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(4, options.length), options, context: { step: 'search' } };
    }
    for (const id of selection) moveFromDeckToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 滑稽演員: both players reshuffle hand into deck, then a coin flip decides the draw split (5/3 or 3/5). */
const jester: EffectHandler = {
  start(ctx) {
    for (const idx of [0, 1] as const) {
      const p = player(ctx.G, idx);
      p.deck.push(...p.hand);
      p.hand = [];
      shuffleDeck(p.deck);
    }
    const heads = flipCoin();
    drawCards(ctx.G, ctx.playerIndex, heads ? 5 : 3);
    drawCards(ctx.G, (1 - ctx.playerIndex) as 0 | 1, heads ? 3 : 5);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 悠哉尾草棒: only usable by the player going second, on their very first turn (game turn 2).
 * Real text returns the chosen Energy to the OPPONENT's hand; attachedEnergy only tracks
 * {id,type} rather than a full Card, so it can't be reconstructed into a hand card — it's
 * discarded instead (same documented simplification as 寶可夢旋風回收機 above). Still a real
 * tempo swing (opponent loses the attached Energy either way), just not identical wording. */
const laidBackTailGrass: EffectHandler = {
  start(ctx) {
    if (ctx.G.turn !== 2) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null && c.attachedEnergy.length > 0);
    if (targets.length === 0) return 'done';
    const options: { id: string; label: string }[] = [];
    for (const c of targets) for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` });
    return { prompt: '悠哉尾草棒：選擇要丟棄的對手能量', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const c of [opp.active, ...opp.bench]) {
      if (!c) continue;
      const i = c.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) { discardAttachedEnergy(ctx.G, c.owner, c.attachedEnergy.splice(i, 1)[0]); break; }
    }
    return 'done';
  },
};

/* ============================================================ */
/*  Batch 6: continuing systematically down the reprint-count-   */
/*  ranked uncovered list. 火箭隊的妨礙機器人 (hidden-prize peek/  */
/*  swap minigame) and 變化之書 ("must be played 2 at once")      */
/*  need mechanics this project doesn't support — skipped rather */
/*  than faked, as with the earlier documented gaps.             */
/* ============================================================ */

/** 西餐廚師: heal own Active 70. */
const westernChef: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active) healDamage(p.active, 70);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 能量輸送PRO: search deck for up to 1 Basic Energy of each distinct type, to hand. */
const energyDeliveryPro: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenTypes = new Set<string>();
    const options: { id: string; label: string }[] = [];
    for (const c of p.deck) {
      if (!c.cardData.subtypes.includes('Basic Energy')) continue;
      const t = c.cardData.types?.[0];
      if (!t || seenTypes.has(t)) continue;
      seenTypes.add(t);
      options.push({ id: c.id, label: c.cardData.name });
    }
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '能量輸送PRO：從牌庫選任意數量的不同屬性基本能量卡（每屬性限1張）加入手牌', choiceType: 'select_from_list', maxCount: options.length, options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 幫忙鈴: only usable by the player going second, on their first turn (game turn 2). Search deck for 1 Supporter to hand. */
const helpBell: EffectHandler = {
  start(ctx) {
    if (ctx.G.turn !== 2) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Supporter'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '幫忙鈴：從牌庫選 1 張支援者卡加入手牌', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: pokeBall.resume,
};

/** 黑暗球: look at the BOTTOM 7 of the deck, take 1 Pokémon to hand, reshuffle the rest. */
const darkBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const bottom = p.deck.slice(0, 7);
    const options = bottom.filter(c => c.cardData.supertype === 'Pokémon');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '黑暗球：查看牌庫下方 7 張，選 1 張寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume: pokeBall.resume,
};

/** 妨害信函: the opponent shuffles their hand into their deck, then draws back the same count. */
const disruptionLetter: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const oppIdx = (1 - ctx.playerIndex) as 0 | 1;
    const n = opp.hand.length;
    opp.deck.push(...opp.hand);
    opp.hand = [];
    shuffleDeck(opp.deck);
    drawCards(ctx.G, oppIdx, n);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 百萬噸吹風機: discard every Pokémon Tool and Special Energy attached to any opponent Pokémon, and the active Stadium. */
const megatonHairDryer: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const c of [opp.active, ...opp.bench]) {
      if (!c) continue;
      if (c.attachedTool) { opp.discardPile.push(c.attachedTool); c.attachedTool = null; }
      // 特殊能量 only, same defect 改造之錘 had — basic Energy must survive this.
      for (const energy of c.attachedEnergy.filter(isSpecialEnergy)) {
        c.attachedEnergy.splice(c.attachedEnergy.indexOf(energy), 1);
        discardAttachedEnergy(ctx.G, c.owner, energy);
      }
    }
    if (ctx.G.activeStadium) {
      player(ctx.G, ctx.G.activeStadium.owner).discardPile.push(ctx.G.activeStadium);
      ctx.G.activeStadium = null;
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 甜蜜球: search deck for 1 Pokémon card sharing a name with any of the opponent's field Pokémon, to hand. */
const sweetBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const oppNames = new Set(allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).map(c => c.cardData.name));
    const options = deckOptions(p.deck, c => oppNames.has(c.cardData.name));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '甜蜜球：從牌庫選 1 張與對手場上寶可夢同名的卡加入手牌', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: pokeBall.resume,
};

/** 配樂之笛: reveal the opponent's top 5 deck cards, place any Basic Pokémon among them onto their Bench, reshuffle the rest. */
const scoringFlute: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const top = opp.deck.slice(-5);
    const options = top.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
    if (options.length === 0) { shuffleDeck(opp.deck); return 'done'; }
    const emptySlots = opp.bench.filter(s => s === null).length;
    if (emptySlots === 0) { shuffleDeck(opp.deck); return 'done'; }
    return { prompt: '配樂之笛：對手牌庫上方 5 張中的基礎寶可夢卡，選任意數量放置於對手備戰區', choiceType: 'select_from_list', maxCount: Math.min(emptySlots, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const slot = opp.bench.findIndex(s => s === null);
      const i = opp.deck.findIndex(c => c.id === id);
      if (slot === -1 || i === -1) continue;
      opp.bench[slot] = opp.deck.splice(i, 1)[0];
    }
    shuffleDeck(opp.deck);
    return 'done';
  },
};

/** 釣竿MAX: from discard, up to 5 total of Pokémon + Basic Energy, to hand. */
const maxRod: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.discardPile, c => c.cardData.supertype === 'Pokémon' || c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) return 'done';
    return { prompt: '釣竿MAX：從棄牌區選最多 5 張寶可夢／基本能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(5, options.length), options, context: {} };
  },
  resume(ctx, _context, selection) {
    for (const id of selection) moveDiscardCardToHand(ctx.G, ctx.playerIndex, id);
    return 'done';
  },
};

/** 珍寶配件: search deck for up to 5 Pokémon Tool cards to hand. */
const treasureAccessory: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Pokémon Tool'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '珍寶配件：從牌庫選最多 5 張寶可夢道具卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(5, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 帕底亞的夥伴 / 黑連 / 蓋伊: draw 3. */
const drawThree: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 美味飯糰: heal own Active 30, +30 more per other copy of "美味飯糰" in the discard pile. */
const deliciousRiceBall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active) return 'done';
    const extra = p.discardPile.filter(c => c.cardData.name === '美味飯糰').length;
    healDamage(p.active, 30 + extra * 30);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 冒險提燈: search deck for 1 Basic Fire + 1 Basic Lightning Energy, to hand. */
const adventureLantern: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy') && ((c.cardData.types || []).includes('Fire') || (c.cardData.types || []).includes('Lightning')));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '冒險提燈：從牌庫選最多各 1 張基本火／雷能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 基利: search deck for up to 3 total of Supporter + Stadium cards, to hand. */
const kiri: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Supporter') || c.cardData.subtypes.includes('Stadium'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '基利：從牌庫選最多 3 張支援者／競技場卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 希嘉娜的信賴: switch Active↔Bench, then move 1 chosen Energy from the newly-Benched Pokémon onto the new Active. */
const hikigasTrust: EffectHandler = {
  start(ctx) {
    const step = pokemonExchange.start(ctx);
    return step === 'done' ? 'done' : { ...step, context: { ...step.context, step: 'switch' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'switch') {
      const oldActiveId = p.active?.id;
      pokemonExchange.resume(ctx, {}, selection);
      const movedOut = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === oldActiveId);
      if (!movedOut || movedOut.attachedEnergy.length === 0 || !p.active) return 'done';
      return { prompt: '希嘉娜的信賴：選擇要移動到新戰鬥寶可夢身上的 1 張能量', choiceType: 'select_from_list', count: 1, options: movedOut.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: { step: 'move_energy', sourceId: oldActiveId } };
    }
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === context.sourceId);
    if (source && p.active) {
      const i = source.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) p.active.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 小楓與小南的修行: draw 2. (The "keep in hand instead of discarding if a named Stadium is in play" clause isn't enforced.) */
const kohanAndKonamiTraining: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 2);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 暗黑鈴: Confuse both Active Pokémon, except Darkness-type ones. */
const darkBell: EffectHandler = {
  start(ctx) {
    for (const idx of [0, 1] as const) {
      const active = ctx.G.players[idx].active;
      if (!active || (active.cardData.types || []).includes('Darkness')) continue;
      applyStatusCondition(active, 'Confused');
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 鏽蝕組手下: discard 1 Energy attached to an opponent Pokémon. (The "own Pokémon fainted last opponent-turn" gate can't be checked — documented simplification used elsewhere.) */
const rustCrewGoon: EffectHandler = {
  // Deliberately NOT crushingHammer: 鏽蝕組手下's printed text has no coin flip, but it used to
  // borrow 粉碎之錘's start() wholesale and inherited one, silently failing half the time.
  start: discardOneOpponentEnergy.start,
  resume: discardOneOpponentEnergy.resume,
};

/** 瑪琪艾兒: reveal the opponent's hand, draw a card for each Pokémon card found in it. */
const makiaru: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const count = opp.hand.filter(c => c.cardData.supertype === 'Pokémon').length;
    drawCards(ctx.G, ctx.playerIndex, count);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 能量撢子: look at the opponent's hand, choose 1 Energy card, place it on the bottom of their deck. */
const energyDuster: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const options = deckOptions(opp.hand, c => c.cardData.supertype === 'Energy');
    if (options.length === 0) return 'done';
    return { prompt: '能量撢子：選擇對手手牌中的 1 張能量卡放回牌庫下方', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const i = opp.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0) opp.deck.unshift(opp.hand.splice(i, 1)[0]);
    return 'done';
  },
};

/** 密阿雷格雷派餅: heal own Active 20 and cure 1 Special Condition. */
const miareGrayPie: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active) {
      healDamage(p.active, 20);
      if (p.active.statusConditions.length > 0) p.active.statusConditions = p.active.statusConditions.slice(1);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 奇異時鐘: de-evolve 1 own Psychic Pokémon back to Basic; the removed evolution card(s) return to hand. Simplified to a single stage (as with 原始之翼), not the full possible multi-stage chain. */
const mysteriousClock: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Psychic') && hasEvolvesFrom(c.cardData));
    if (targets.length === 0) return 'done';
    return { prompt: '奇異時鐘：選擇要使其退化的超系寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (!target || !hasEvolvesFrom(target.cardData)) return 'done';
    // The prior stage is stacked under `target` (see preEvolutions), not sitting in the discard
    // pile — evolving no longer discards it immediately (real rules: it stays with the Pokémon
    // until the whole stack is eventually KO'd/discarded together).
    const stack = target.preEvolutions || [];
    if (stack.length === 0) return 'done';
    const priorStage = stack[stack.length - 1];
    priorStage.preEvolutions = stack.slice(0, -1);
    priorStage.attachedEnergy = target.attachedEnergy;
    priorStage.damage = target.damage;
    priorStage.attachedTool = target.attachedTool;
    priorStage.statusConditions = target.statusConditions;
    const isActive = p.active?.id === target.id;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === target.id);
    if (isActive) p.active = priorStage; else if (benchIdx >= 0) p.bench[benchIdx] = priorStage;
    // Only the removed evolution card itself returns to hand — it carries no stacked history.
    p.hand.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, preEvolutions: undefined });
    return 'done';
  },
};

/** 能量硬幣: flip 2 coins; if both heads, search deck for 1 Basic Energy, attach to a chosen own Pokémon. */
const energyCoin: EffectHandler = {
  start(ctx) {
    if (!(flipCoin() && flipCoin())) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Basic Energy'));
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (options.length === 0 || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '能量硬幣：擲出雙正面！從牌庫選 1 張基本能量卡', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '能量硬幣：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const energyId = context.energyId as string;
    const i = p.deck.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.deck.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 覺醒戰鼓: draw as many cards as you have "Ancient"-subtype Pokémon in play. */
const awakeningDrum: EffectHandler = {
  start(ctx) {
    const count = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.subtypes.includes('Ancient')).length;
    if (count > 0) drawCards(ctx.G, ctx.playerIndex, count);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 除蟲噴霧: force-switch the opponent's Active with a Benched Pokémon (auto-picked — no interactive opponent choice exists). */
const bugSpray: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c !== null);
    if (idx === -1 || !opp.active) return 'done';
    const chosen = opp.bench[idx]!;
    clearStatusConditionsOnLeaveActive(opp.active);
    opp.bench[idx] = opp.active;
    opp.active = chosen;
    return 'done';
  },
  resume() { return 'done'; },
};

/** 女服務生: look at top 6 of deck, take 1 Basic Energy, attach to a chosen own Pokémon, reshuffle the rest. */
const waitress: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-6);
    const options = top.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '女服務生：查看牌庫上方 6 張，選 1 張基本能量卡', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '女服務生：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const energyId = context.energyId as string;
    const i = p.deck.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.deck.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 巴貝娜與荷蓮娜: gated by 6 specific named "N的" Pokémon all in play; your next KO this turn awards 3 bonus prizes. (Simplified: not restricted to KOs specifically by an "N的" Pokémon's attack.) */
const barbaraAndHollyrena: EffectHandler = {
  start(ctx) {
    const names = new Set(allPokemon(ctx.G, ctx.playerIndex).map(c => c.cardData.name));
    const required = ['N的達摩狒狒', 'N的索羅亞克ex', 'N的雙倍多多冰', 'N的齒輪怪', 'N的萊希拉姆', 'N的捷克羅姆'];
    if (!required.every(n => names.has(n))) return 'done';
    player(ctx.G, ctx.playerIndex).bonusPrizeNextKo = 3;
    return 'done';
  },
  resume() { return 'done'; },
};

/** 越橘的一步棋: not usable on the first turn; look at top 7, place 1 Darkness Pokémon onto the Bench, reshuffle the rest. */
const oregonaMove: EffectHandler = {
  start(ctx) {
    if (ctx.G.turn === 1) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-7);
    const options = top.filter(c => c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Darkness'));
    const emptySlots = p.bench.filter(s => s === null).length;
    if (options.length === 0 || emptySlots === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '越橘的一步棋：查看牌庫上方 7 張，選 1 張惡寶可夢卡放置於備戰區', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const slot = p.bench.findIndex(s => s === null);
    const i = p.deck.findIndex(c => c.id === selection[0]);
    if (slot >= 0 && i >= 0) p.bench[slot] = p.deck.splice(i, 1)[0];
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 開洞之鏟: discard the top 2 cards of your own deck. */
const holeDiggingShovel: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    for (let i = 0; i < 2 && p.deck.length > 0; i++) p.discardPile.push(p.deck.pop()!);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 捷朵: draw as many cards as the opponent has "超級...ex" (Mega ex) Pokémon in play. */
const jiedo: EffectHandler = {
  start(ctx) {
    const count = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex')).length;
    if (count > 0) drawCards(ctx.G, ctx.playerIndex, count);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 古歷: heal 50 on every Pokémon on both sides. */
const guli: EffectHandler = {
  start(ctx) {
    for (const c of [...allPokemon(ctx.G, 0), ...allPokemon(ctx.G, 1)]) healDamage(c, 50);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 訂購盒: ends your turn; search deck for up to 2 Item cards to hand. */
const orderBox: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Item'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '訂購盒：從牌庫選最多 2 張物品卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 毅萬與馥好: draw 2, plus 2 more if your hand then has 10 or more cards. */
const yiwanAndFuhao: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    drawCards(ctx.G, ctx.playerIndex, 2);
    if (p.hand.length >= 10) drawCards(ctx.G, ctx.playerIndex, 2);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 招式學習器機: search deck for up to 3 "招式學習器" family Pokémon Tool cards, to hand. */
const moveTutorMachine: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = deckOptions(p.deck, c => c.cardData.subtypes.includes('Pokémon Tool') && c.cardData.name.includes('招式學習器'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '招式學習器機：從牌庫選最多 3 張「招式學習器」寶可夢道具卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options, context: {} };
  },
  resume: hibikisAdventure.resume,
};

/** 阿塞蘿拉的惡作劇: usable only while the opponent has 2 or fewer remaining prize cards. Choose 1
 * own field Pokémon; during the opponent's next turn, it's immune to damage from an opponent
 * "ex" Pokémon's attacks — reuses the generic per-card timedEffects system built for attack text
 * this session (damageImmune + vsSubtype:'ex'), the first time a TRAINER card writes one. */
const arlosCharm: EffectHandler = {
  start(ctx) {
    if (opponent(ctx.G, ctx.playerIndex).prizes.length > 2) return 'done';
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (targets.length === 0) return 'done';
    return { prompt: '阿塞蘿拉的惡作劇：選 1 隻己方寶可夢，下個對手回合免疫對手 ex 寶可夢的招式傷害', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) {
      target.timedEffects = [...(target.timedEffects || []), { kind: 'damageImmune', vsSubtype: 'ex', appliesOnTurn: ctx.G.turn + 1 }];
    }
    return 'done';
  },
};

/** 霍米加的演奏: during the opponent's next turn, their Poisoned Pokémon (including ones newly
 * poisoned that same turn) can't retreat — a condition-based check rather than tied to one
 * specific card, so it's a player-wide timed flag (poisonedCantRetreatUntilTurn) checked in
 * canRetreat, mirroring itemLockedUntilTurn's existing pattern. */
const homikasPerformance: EffectHandler = {
  start(ctx) {
    opponent(ctx.G, ctx.playerIndex).poisonedCantRetreatUntilTurn = ctx.G.turn + 1;
    return 'done';
  },
  resume() { return 'done'; },
};

export const trainerEffects: Record<string, EffectHandler> = {
  '高級球': ultraBall,
  '老大的指令': bosssOrders,
  '老大的指令（赤日）': bosssOrders,
  '神奇糖果': rareCandy,
  '莉莉艾的決意': lilliesDetermination,
  '夜間擔架': nightStretcher,
  '寶可平板': pokeTablet,
  '好友寶芬': buddyPoffin,
  '艾莉絲的鬥志': alicesResolve,
  '赤松': akamatsu,
  '寶可夢交替': pokemonExchange,
  '傷藥': potion,
  '能量轉移': energyTransfer,
  '能量輸送': energyDelivery,
  '寶可夢捕捉器': pokemonCatcher,
  '寶可裝置3.0': pokeGear3,
  '裁判': judge,
  '能量回收': energyRetrieval,
  '能量回收器': energyRecyclingSystem,
  '粉碎之錘': crushingHammer,
  '改造之錘': modifiedHammer,
  '水蓮的照顧': erikasHospitality,
  '松葉的信心': matsubasConviction,
  '紫竽': shuffleDrawConditional8,
  '鬥子': toshi,
  '杜若': durand,
  '阿克羅瑪的執著': akromasPersistence,
  '悟松': gosho,
  '朵拉塞娜': dorasena,
  '頂尖捕捉器': topCatcher,
  '沙儷': shari,
  '火箭隊的接收器': rocketReceiver,
  '火箭隊的拉姆達': rocketLambda,
  '探險家的嚮導': explorersGuide,
  '枇琶': biwa,
  '戰鬥鑼': fightingDrum,
  'N的謀劃': movesBenchEnergyToActive,
  '希特隆的機智': healAllLightning,
  '滿充的體貼': fullHealMegaReturnEnergy,
  '超級信號': megaSignal,
  '小光': hikari,
  '火箭隊的雅典娜': rocketAthena,
  '捕蟲組合': bugCatchingSet,

  '道具拆除器': toolWrecker,
  '不公印章': unfairSeal,
  '火箭隊的阿波羅': rocketApollo,
  '火箭隊的蘭斯': rocketLance,
  '聖灰': holyAsh,
  '阿杏的秘招': asuNoHiketsu,
  '衝浪手': surfer,
  '庫瑟洛斯奇的企圖': kusserothsAmbition,
  '阿響的冒險': hibikisAdventure,
  '暗碼迷的解讀': decoderMania,
  '賽吉': saijo,
  'N的ＰＰ提升劑': nsBooster,
  '玻璃喇叭': glassHorn,
  '調換票': tradeTicket,
  '秘密箱': secretBox,
  '火箭隊的坂木': rocketSakaki,
  '小剛的發掘': takeshisExcavation,
  '烏栗': uguisu,
  '奇跡耳麥': miracleHeadset,
  '丹瑜': tanyu,
  '白蕾雅': whiteLyra,
  '席藍': seiran,
  '太晶珠': teraOrb,
  '寶可夢中心的姐姐': pokemonCenterLady,
  '青木的手法': aokisMethod,
  '奇跡修正檔': miracleCipher,
  '力量蛋白飲': powerProtein,
  '特殊紅牌': specialRedCard,
  '鳴依的勉勵': naeisEncouragement,
  '吉普索': jipuso,
  '空手道王的演練': karateKingsPractice,
  '高溫燃燒器': highTempBurner,
  '塔拉剛': taragan,
  '完全體攪拌器': perfectBlender,
  'AZ的平和': azsPeace,
  '貴重手推車': preciousCart,
  '洛拍棒': lopaStick,
  '超大冰淇淋': superJumboIceCream,
  '豐收漁網': harvestNet,
  '小霞的朝氣': kasumisSpirit,
  '沐淨': mujing,
  '琵魯': piru,
  '吹火人': fireBreather,

  '精靈球': pokeBall,
  '大師球': masterBall,
  '危險光線': dangerRay,
  '高級香氛': premiumIncense,
  '寶可生機劑A': pokeVitalA,
  '派帕的三明治': paipasSandwich,
  '龍之秘藥': dragonElixir,
  '管理員': caretaker,
  '主持人的帶動': hostsEncouragement,
  '仙后': queenCard,
  '手部修剪器': handTrimmer,
  '琉琪亞的展示': lucasShowcase,
  '重新啟動箱': restartBox,
  '白露的真心': shiroroNoKokoro,
  '火箭隊的超級球': rocketSuperBall,
  '好傷藥': goodPotion,
  '火箭隊的驚嚇炸彈': rocketScareBomb,
  '鬼之假面': oniMask,
  '赫普的包包': heapsBag,
  '泰姆': tim,
  '寶可夢旋風回收機': pokemonCyclone,
  '推理組合': deductionSet,
  '可怕的哥哥': scaryBrother,
  '急進開關': rapidSwitch,
  '悠哉尾草棒': laidBackTailGrass,
  '八朔': requireOwnKoLastTurn(hazaku),
  '海岱': haidai,
  '阿蜜的目光': amisGaze,
  '老大的指令（魁奇思）': bosssOrders,
  '納莉': nari,
  '格拉吉歐的決戰': gladionsShowdown,
  '鐵之防禦強化': ironDefenseBoost,
  '由紫': yuzi,
  '馬志士的交易': majisisTrade,
  '真菰': makomo,
  '卡娜莉': canary,
  '滑稽演員': jester,

  '西餐廚師': westernChef,
  '能量輸送PRO': energyDeliveryPro,
  '幫忙鈴': helpBell,
  '黑暗球': darkBall,
  '妨害信函': disruptionLetter,
  '百萬噸吹風機': megatonHairDryer,
  '甜蜜球': sweetBall,
  '配樂之笛': scoringFlute,
  '釣竿MAX': maxRod,
  '珍寶配件': treasureAccessory,
  '帕底亞的夥伴': drawThree,
  '美味飯糰': deliciousRiceBall,
  '冒險提燈': adventureLantern,
  '基利': kiri,
  '希嘉娜的信賴': hikigasTrust,
  '小楓與小南的修行': kohanAndKonamiTraining,
  '老大的指令（烏羽）': bosssOrders,
  '暗黑鈴': darkBell,
  '鏽蝕組手下': requireOwnKoLastTurn(rustCrewGoon),
  '瑪琪艾兒': makiaru,
  '黑連': drawThree,
  '能量撢子': energyDuster,
  '密阿雷格雷派餅': miareGrayPie,
  '奇異時鐘': mysteriousClock,
  '能量硬幣': energyCoin,
  '覺醒戰鼓': awakeningDrum,
  '除蟲噴霧': bugSpray,
  '女服務生': waitress,
  '蓋伊': drawThree,
  '巴貝娜與荷蓮娜': barbaraAndHollyrena,
  '越橘的一步棋': oregonaMove,
  '開洞之鏟': holeDiggingShovel,
  '捷朵': jiedo,
  '古歷': guli,
  '勝利之證': pokeBall,
  '訂購盒': orderBox,
  '毅萬與馥好': yiwanAndFuhao,
  '招式學習器機': moveTutorMachine,
  '阿塞蘿拉的惡作劇': arlosCharm,
  '霍米加的演奏': homikasPerformance,
};

export function hasTrainerEffect(name: string): boolean {
  return normalizeCardName(name) in trainerEffects;
}

/** True when the named Trainer either defines no canPlay gate or its gate passes — see
 * EffectHandler.canPlay in types.ts for the contract (public-zone requirements only). */
export function canPlayTrainer(name: string, ctx: EffectContext): boolean {
  const handler = trainerEffects[normalizeCardName(name)];
  return handler?.canPlay ? handler.canPlay(ctx) : true;
}

export function startTrainerEffect(name: string, ctx: EffectContext): EffectStep {
  return trainerEffects[normalizeCardName(name)].start(ctx);
}

export function resumeTrainerEffect(name: string, ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  return trainerEffects[normalizeCardName(name)].resume(ctx, context, selection);
}
