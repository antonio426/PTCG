import { GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, allPokemon, opponent, player, shuffleDeck } from './types';
import { discardFromHand, drawCards, drawUpTo, flipCoin, healDamage, moveDiscardCardToHand } from './primitives';
import { clearStatusConditionsOnLeaveActive } from '../statusConditions';

/** Non-rule-box Pokémon: no ex/V/VMAX/VSTAR/GX/Radiant/Mega subtype or name prefix. */
function hasNoRuleBox(card: GameCard): boolean {
  const subs = card.cardData.subtypes || [];
  const ruleBoxSubtypes = ['ex', 'EX', 'V', 'VMAX', 'VSTAR', 'GX', 'Radiant', 'TAG TEAM'];
  if (subs.some(s => ruleBoxSubtypes.includes(s))) return false;
  if (card.cardData.name.startsWith('超級')) return false;
  return true;
}

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
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (benched.length === 0) return 'done';
    return {
      prompt: "老大的指令：選 1 隻對手備戰寶可夢換上場",
      choiceType: 'select_from_list',
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
      options: stage2InHand.map(c => ({ id: c.id, label: `${c.cardData.name}（進化自 ${c.cardData.evolvesFrom ?? '?'} 的前一階）` })),
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
      );
      if (targets.length === 0) return 'done';
      return {
        prompt: `神奇糖果：選擇要進化的基礎寶可夢`,
        choiceType: 'select_from_list',
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
      p.discardPile.push(old);
      evolution.attachedEnergy = old.attachedEnergy;
      evolution.damage = old.damage;
      evolution.attachedTool = old.attachedTool;
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
    if (i >= 0) p.hand.push(p.discardPile.splice(i, 1)[0]);
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
        choiceType: 'select_from_list',
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

/** 粉碎之錘 Crushing Hammer: flip a coin; if heads, discard 1 energy attached to an opponent's Pokémon. */
const crushingHammer: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => c.attachedEnergy.length > 0);
    if (targets.length === 0) return 'done';
    const options: { id: string; label: string }[] = [];
    for (const c of targets) for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` });
    return { prompt: '粉碎之錘：選擇要丟棄對手身上的哪個能量', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const c of [opp.active, ...opp.bench]) {
      if (!c) continue;
      const i = c.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) { c.attachedEnergy.splice(i, 1); break; }
    }
    return 'done';
  },
};

/** 改造之錘 Forest Hammer(-style): discard 1 Special Energy attached to an opponent's Pokémon (no coin flip). */
const modifiedHammer: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => c.attachedEnergy.some(e => e.type !== 'Colorless' || true));
    const options: { id: string; label: string }[] = [];
    for (const c of targets) for (const e of c.attachedEnergy) options.push({ id: e.id, label: `${c.cardData.name} 的能量` });
    if (options.length === 0) return 'done';
    return { prompt: '改造之錘：選擇要丟棄對手身上的哪張特殊能量', choiceType: 'select_from_list', count: 1, options, context: {} };
  },
  resume: crushingHammer.resume,
};

/** 水蓮的照顧 Erika's Hospitality: from discard, up to 3 total of (non-rule-box Pokémon + Basic Energy) to hand. */
const erikasHospitality: EffectHandler = {
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
};

export function hasTrainerEffect(name: string): boolean {
  return name in trainerEffects;
}

export function startTrainerEffect(name: string, ctx: EffectContext): EffectStep {
  return trainerEffects[name].start(ctx);
}

export function resumeTrainerEffect(name: string, ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  return trainerEffects[name].resume(ctx, context, selection);
}
