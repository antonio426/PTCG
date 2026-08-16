import { EnergyType, GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, allPokemon, findOwnPokemon, opponent, player } from './types';
import { handleKo, stackAsPreEvolution, flushPreEvolutionsToDiscard, resetCardForReentry } from '../damage';
import { applyStatusCondition, discardAttachedEnergy, discardFromHand, drawCards, drawUpTo, flipCoin, flipCoins, moveDeckCardToBench, moveDeckCardToHand, shuffleDeck } from './primitives';
import { clearStatusConditionsOnLeaveActive } from '../statusConditions';
import { hasEvolvesFrom, evolvesFromMatches } from '../evolutionChains';

/** 偵查指令: look at the top 2 cards of your deck, take 1 to hand, put the rest on the bottom. */
const strategicCommand: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-2);
    if (top.length === 0) return 'done';
    return {
      prompt: '偵查指令：查看牌庫上方 2 張，選 1 張加手牌，其餘放回牌庫下方',
      choiceType: 'select_from_list',
      count: 1,
      options: top.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { seenIds: top.map(c => c.id) },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    const chosenId = selection[0];
    // Pull the seen cards off the top (they're the last N elements; deck.pop() draws from the end).
    const seen: GameCard[] = [];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
    }
    for (const c of seen) {
      if (c.id === chosenId) p.hand.push(c);
      else p.deck.unshift(c); // bottom of deck
    }
    return 'done';
  },
};

/**
 * 咒詛炸彈: place N damage counters on 1 opponent Pokémon, then this Pokémon faints.
 * N varies by which Pokémon has it (5 on 彷徨夜靈, 13 on 黑夜魔靈) despite the identical
 * ability name, so it's read from that specific card's own ability text rather than
 * hardcoded — a generic name-only registry would otherwise silently use the wrong number.
 */
function curseBombCounters(ctx: EffectContext): number {
  const source = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
  const text = source?.cardData.abilities?.find(a => a.name === '咒詛炸彈')?.text || '';
  const m = text.match(/放置\s*(\d+)\s*個傷害指示物/);
  return m ? parseInt(m[1], 10) : 5; // 5 is the lowest real printed value if text parsing ever fails
}

const curseBomb: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
    if (targets.length === 0) return 'done';
    const n = curseBombCounters(ctx);
    return {
      prompt: `咒詛炸彈：選 1 隻對手寶可夢放 ${n} 個傷害指示物`,
      choiceType: 'select_pokemon',
      count: 1,
      options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
      context: { n },
    };
  },
  resume(ctx, context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
    if (target) {
      target.damage += (context.n as number) * 10;
      const hp = parseInt(target.cardData.hp || '0', 10);
      if (target.damage >= hp && hp > 0) {
        handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
      }
    }
    // The ability's own Pokémon faints as the cost, regardless of whether the target was KO'd.
    handleKo(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    return 'done';
  },
};

/** 腎上腺腦力: move up to 3 damage counters off a damaged Pokémon of yours, then place that many on 1 opponent Pokémon. */
const adrenalineBrain: EffectHandler = {
  start(ctx) {
    const damaged = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage >= 10);
    if (damaged.length === 0) return 'done';
    return {
      prompt: '腎上腺腦力：選 1 隻受傷（≥10 傷害）的己方寶可夢',
      choiceType: 'select_pokemon',
      count: 1,
      options: damaged.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })),
      context: { step: 'pick_source' },
    };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_source') {
      const source = findOwnPokemon(ctx.G, ctx.playerIndex, selection[0]);
      if (!source) return 'done';
      const maxCounters = Math.min(3, Math.floor(source.damage / 10));
      const options = Array.from({ length: maxCounters }, (_, i) => ({ id: String(i + 1), label: `搬 ${i + 1} 個指示物` }));
      return {
        prompt: `腎上腺腦力：${source.cardData.name} 身上有 ${source.damage} 傷害，請選擇搬幾個指示物（1~3）`,
        choiceType: 'select_from_list',
        count: 1,
        options,
        context: { step: 'pick_count', sourceId: selection[0] },
      };
    }
    if (context.step === 'pick_count') {
      const count = parseInt(selection[0], 10);
      const source = findOwnPokemon(ctx.G, ctx.playerIndex, context.sourceId as string);
      if (source) source.damage = Math.max(0, source.damage - count * 10);
      const opp = opponent(ctx.G, ctx.playerIndex);
      const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
      if (targets.length === 0) return 'done';
      return {
        prompt: '腎上腺腦力：選對手 1 隻寶可夢 +傷害',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_opponent_target', count },
      };
    }
    if (context.step === 'pick_opponent_target') {
      const opp = opponent(ctx.G, ctx.playerIndex);
      const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
      const count = context.count as number;
      if (target) {
        target.damage += count * 10;
        const hp = parseInt(target.cardData.hp || '0', 10);
        if (target.damage >= hp && hp > 0) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
      }
    }
    return 'done';
  },
};

/** 交易 (Trade-style): discard 1 card from hand, draw 2. */
const trade: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return { prompt: '交易：選 1 張手牌丟棄，抽 2 張卡', choiceType: 'select_hand_cards', count: 1, context: {} };
  },
  resume(ctx, _context, selection) {
    discardFromHand(ctx.G, ctx.playerIndex, selection);
    drawCards(ctx.G, ctx.playerIndex, 2);
    return 'done';
  },
};

/** 集客 (Customer Magnet-style): look at top 6, take 1 Supporter to hand, reshuffle the rest. */
const customerMagnet: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-6);
    const supporters = top.filter(c => c.cardData.subtypes.includes('Supporter'));
    if (supporters.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '集客：查看牌庫上方 6 張，選 1 張支援者卡加入手牌', choiceType: 'select_from_list', maxCount: 1, options: supporters.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 突然削退 (Sudden Setback-style): discard the top card of the opponent's deck. */
const suddenSetback: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const card = opp.deck.pop();
    if (card) opp.discardPile.push(card);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 亂咬 (Wild Bite-style): place 2 damage counters each on up to 2 of the opponent's Pokémon. */
const wildBite: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
    if (targets.length === 0) return 'done';
    return { prompt: '亂咬：選最多 2 隻對手寶可夢各放置 2 個傷害指示物', choiceType: 'select_pokemon', maxCount: Math.min(2, targets.length), options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const target = opp.active?.id === id ? opp.active : opp.bench.find(c => c?.id === id);
      if (!target) continue;
      target.damage += 20;
      const hp = parseInt(target.cardData.hp || '0', 10);
      if (hp > 0 && target.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
    }
    return 'done';
  },
};

const ENERGY_TYPE_ZH_LABEL: Record<string, string> = {
  Grass: '草', Fire: '火', Water: '水', Lightning: '雷', Psychic: '超',
  Fighting: '鬥', Darkness: '惡', Metal: '鋼', Fairy: '妖', Dragon: '龍', Colorless: '無',
};

/** Generic "attach up to N Basic Energy of a given type from hand to a chosen Pokémon" ability shape. */
function attachEnergyFromHandAbility(promptLabel: string, energyType: string, maxCount: number, thenDraw = false): EffectHandler {
  const energyTypeZh = ENERGY_TYPE_ZH_LABEL[energyType] || energyType;
  return {
    start(ctx) {
      const p = player(ctx.G, ctx.playerIndex);
      const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes(energyType as any));
      if (options.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      if (targets.length === 0) return 'done';
      return {
        prompt: `${promptLabel}：選最多 ${maxCount} 張基本${energyTypeZh}能量卡`,
        choiceType: 'select_from_list',
        maxCount: Math.min(maxCount, options.length),
        options: options.map(c => ({ id: c.id, label: c.cardData.name })),
        context: { step: 'pick_energy' },
      };
    },
    resume(ctx, context, selection) {
      const p = player(ctx.G, ctx.playerIndex);
      if (context.step === 'pick_energy') {
        if (selection.length === 0) return 'done';
        const targets = allPokemon(ctx.G, ctx.playerIndex);
        return {
          prompt: `${promptLabel}：選擇要附加能量的寶可夢`,
          choiceType: 'select_pokemon',
          count: 1,
          options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
          context: { step: 'pick_target', energyIds: selection },
        };
      }
      const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
      const energyIds = context.energyIds as string[];
      if (target) {
        for (const id of energyIds) {
          const i = p.hand.findIndex(c => c.id === id);
          if (i === -1) continue;
          const energy = p.hand.splice(i, 1)[0];
          target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
        }
        if (thenDraw) drawCards(ctx.G, ctx.playerIndex, 1);
      }
      return 'done';
    },
  };
}

/** 振翅高飛 (Wingbeat-style): search up to 3 Basic Grass Energy from the deck, attach to this Pokémon, reshuffle. */
const wingbeat: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Grass'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '振翅高飛：從牌庫選最多 3 張基本草能量卡附於這隻寶可夢', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const source = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    for (const id of selection) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i === -1 || !source) continue;
      const energy = p.deck.splice(i, 1)[0];
      source.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 閃光抽出 (Flash Draw-style): discard 1 attached Basic Lightning Energy from this Pokémon, draw back up to 6. */
const flashDraw: EffectHandler = {
  start(ctx) {
    const source = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const lightningEnergy = source?.attachedEnergy.filter(e => e.type === 'Lightning') || [];
    if (lightningEnergy.length === 0) return 'done';
    return { prompt: '閃光抽出：選 1 張這隻寶可夢身上的基本雷能量丟棄', choiceType: 'select_from_list', count: 1, options: lightningEnergy.map(e => ({ id: e.id, label: e.type })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const source = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (source) {
      const i = source.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) discardAttachedEnergy(ctx.G, ctx.playerIndex, source.attachedEnergy.splice(i, 1)[0]);
    }
    drawUpTo(ctx.G, ctx.playerIndex, 6);
    return 'done';
  },
};

/** Generic "discard up to N energy cards (optionally type-filtered) from the discard pile, attach to a chosen own Pokémon". */
function attachEnergyFromDiscardAbility(opts: {
  promptLabel: string;
  maxCount: number;
  energyType?: EnergyType;
  targetFilter?: (target: GameCard) => boolean;
  gate?: (ctx: EffectContext) => boolean;
}): EffectHandler {
  return {
    start(ctx) {
      if (opts.gate && !opts.gate(ctx)) return 'done';
      const p = player(ctx.G, ctx.playerIndex);
      const options = p.discardPile.filter(c => c.cardData.supertype === 'Energy'
        && (!opts.energyType || (c.cardData.types || []).includes(opts.energyType)));
      if (options.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => !opts.targetFilter || opts.targetFilter(t));
      if (targets.length === 0) return 'done';
      return {
        prompt: `${opts.promptLabel}：從棄牌區選最多 ${opts.maxCount} 張能量卡`,
        choiceType: 'select_from_list',
        maxCount: Math.min(opts.maxCount, options.length),
        options: options.map(c => ({ id: c.id, label: c.cardData.name })),
        context: { step: 'pick_energy' },
      };
    },
    resume(ctx, context, selection) {
      const p = player(ctx.G, ctx.playerIndex);
      if (context.step === 'pick_energy') {
        if (selection.length === 0) return 'done';
        const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => !opts.targetFilter || opts.targetFilter(t));
        return {
          prompt: `${opts.promptLabel}：選擇要附加能量的寶可夢`,
          choiceType: 'select_pokemon',
          count: 1,
          options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
          context: { step: 'pick_target', energyIds: selection },
        };
      }
      const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
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
}

/** 降霜: discard 1 Water Energy from discard pile, attach to any own Pokémon. */
const frostDown = attachEnergyFromDiscardAbility({ promptLabel: '降霜', maxCount: 1, energyType: 'Water' });

/** 合金建造: discard up to 2 Metal Energy from discard pile, attach to an own Metal-type Pokémon. */
const alloyBuild = attachEnergyFromDiscardAbility({
  promptLabel: '合金建造', maxCount: 2, energyType: 'Metal',
  targetFilter: (t) => (t.cardData.types || []).includes('Metal'),
});

/** 太陽能量: discard 1 Psychic Energy from discard pile, attach to own "月石" if in play. */
const solarEnergy = attachEnergyFromDiscardAbility({
  promptLabel: '太陽能量', maxCount: 1, energyType: 'Psychic',
  targetFilter: (t) => t.cardData.name === '月石',
});

/** 古代睿智: gated by all 5 named Legendary Titans in play; discard up to 3 energy (any type), attach to 1 own Pokémon. */
const ancientWisdom = attachEnergyFromDiscardAbility({
  promptLabel: '古代睿智', maxCount: 3,
  gate: (ctx) => {
    const names = new Set(allPokemon(ctx.G, ctx.playerIndex).map(c => c.cardData.name));
    return ['雷吉洛克', '雷吉艾斯', '雷吉斯奇魯', '雷吉艾勒奇', '雷吉鐸拉戈'].every(n => names.has(n));
  },
});

/** 抓取: discard up to 2 Pokémon Tool cards from the discard pile back to hand. */
const grab: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.discardPile.filter(c => c.cardData.subtypes.includes('Pokémon Tool'));
    if (options.length === 0) return 'done';
    return { prompt: '抓取：從棄牌區選最多 2 張寶可夢道具卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.discardPile.findIndex(c => c.id === id);
      if (i >= 0) p.hand.push(p.discardPile.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 旅途牽絆: search the deck for a specific named Supporter card, add to hand, reshuffle. */
function searchNamedCardAbility(promptLabel: string, cardName: string): EffectHandler {
  return {
    start(ctx) {
      const p = player(ctx.G, ctx.playerIndex);
      const match = p.deck.find(c => c.cardData.name === cardName);
      if (!match) { shuffleDeck(p.deck); return 'done'; }
      moveDeckCardToHand(ctx.G, ctx.playerIndex, match.id);
      return 'done';
    },
    resume() { return 'done'; },
  };
}
const travelBond = searchNamedCardAbility('旅途牽絆', '阿響的冒險');

/** 衝衝鼓: gated by own Active having ability 祭典樂舞; search any 1 card from deck to hand, reshuffle. */
const festivalDrum: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const active = p.active;
    const hasFestivalDance = active?.cardData.abilities?.some(a => a.text && a.name.replace(/^[‌​]+/, '').replace(/^\[特性\]/, '') === '祭典樂舞');
    if (!hasFestivalDance || p.deck.length === 0) return 'done';
    return { prompt: '衝衝鼓：從牌庫任意選 1 張卡加入手牌', choiceType: 'select_from_list', count: 1, options: p.deck.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 迅速游標: swap this (benched) Pokémon into Active, then optionally move any attached energy from any own Pokémon onto it. */
const rapidCursor: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || !p.active || p.active.id === self.id) return 'done';
    const benchIdx = p.bench.findIndex(c => c?.id === self.id);
    if (benchIdx === -1) return 'done';
    const oldActive = p.active;
    p.bench[benchIdx] = oldActive;
    p.active = self;
    const movable = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== self.id && c.attachedEnergy.length > 0);
    if (movable.length === 0) return 'done';
    const options = movable.flatMap(c => c.attachedEnergy.map(e => ({ id: e.id, label: `${c.cardData.name} 的${e.type}能量` })));
    return { prompt: '迅速游標：選擇要移動到這隻寶可夢身上的能量（可不選）', choiceType: 'select_from_list', maxCount: options.length, options, context: {} };
  },
  resume(ctx, _context, selection) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    for (const c of allPokemon(ctx.G, ctx.playerIndex)) {
      if (c.id === self.id) continue;
      // Move every selected energy id found on this Pokémon onto self.
      c.attachedEnergy = c.attachedEnergy.filter(e => {
        if (selection.includes(e.id)) { self.attachedEnergy.push(e); return false; }
        return true;
      });
    }
    return 'done';
  },
};

/** 瞬間移動者: must be Active; shuffle self (with attached cards) back into the deck, promote from bench if possible. */
const teleporter: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const self = p.active;
    for (const energy of self.attachedEnergy.splice(0)) discardAttachedEnergy(ctx.G, ctx.playerIndex, energy);
    if (self.attachedTool) { p.discardPile.push(self.attachedTool); self.attachedTool = null; }
    self.damage = 0;
    self.statusConditions = [];
    flushPreEvolutionsToDiscard(self, p.discardPile);
    p.deck.push(self);
    const promo = p.bench.find(c => c !== null);
    p.active = promo || null;
    if (promo) p.bench[p.bench.indexOf(promo)] = null;
    shuffleDeck(p.deck);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 金屬轉移: move a Metal Energy from one own Pokémon to another. Unlimited uses per turn. */
const metalTransfer: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.attachedEnergy.some(e => e.type === 'Metal'));
    if (sources.length === 0) return 'done';
    const options = sources.flatMap(c => c.attachedEnergy.filter(e => e.type === 'Metal').map(e => ({ id: e.id, label: `${c.cardData.name} 的鋼能量` })));
    return { prompt: '金屬轉移：選擇要轉移的鋼能量', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_energy') {
      const energyId = selection[0];
      const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === energyId));
      if (!source) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== source.id);
      if (targets.length === 0) return 'done';
      return {
        prompt: '金屬轉移：選擇要轉入的寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyId },
      };
    }
    const energyId = context.energyId as string;
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === energyId));
    const target = findOwnPokemon(ctx.G, ctx.playerIndex, selection[0]);
    if (source && target) {
      const i = source.attachedEnergy.findIndex(e => e.id === energyId);
      if (i >= 0) target.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 熟成充能: attach 1 Basic Grass Energy from hand to a chosen own Pokémon, then heal that Pokémon 30. */
const ripenCharge: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Grass'));
    if (options.length === 0) return 'done';
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (targets.length === 0) return 'done';
    return { prompt: '熟成充能：選 1 張基本草能量卡', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return {
        prompt: '熟成充能：選擇要附加能量並恢復 30 的寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyId: selection[0] },
      };
    }
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const energyId = context.energyId as string;
    const i = p.hand.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.hand.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      target.damage = Math.max(0, target.damage - 30);
    }
    return 'done';
  },
};

/** 經驗法則: attach up to 2 Basic Fighting Energy from hand to THIS Pokémon (self only, no target choice). */
const ruleOfExperience: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting'));
    if (options.length === 0) return 'done';
    return { prompt: '經驗法則：選最多 2 張基本鬥能量卡附於自己身上', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (self) {
      for (const id of selection) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.hand.splice(i, 1)[0];
        self.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    return 'done';
  },
};

/** 劇毒粉塵: poison both Active Pokémon. (Simplified: the printed "must have 驅勁能量 古代 attached"
 * condition can't be checked — attachedEnergy only stores {id,type}, not the original card's
 * name — so this is available whenever the ability's own Pokémon is in play instead.) */
const poisonDust: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (p.active) { p.active.statusConditions = p.active.statusConditions.filter(c => c !== 'Poisoned'); p.active.statusConditions.push('Poisoned'); }
    if (opp.active) { opp.active.statusConditions = opp.active.statusConditions.filter(c => c !== 'Poisoned'); opp.active.statusConditions.push('Poisoned'); }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 風扇呼喚: game's first turn only; search up to 3 Colorless Pokémon with HP<=100 from deck to hand, reshuffle. */
const fanCall: EffectHandler = {
  start(ctx) {
    if (ctx.G.turn !== 1) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon'
      && (c.cardData.types || []).includes('Colorless')
      && parseInt(c.cardData.hp || '999', 10) <= 100);
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '風扇呼喚：從牌庫選最多 3 張 HP100 以下的無屬性寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(3, options.length), options: options.map(c => ({ id: c.id, label: `${c.cardData.name}（HP${c.cardData.hp}）` })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveDeckCardToHand(ctx.G, ctx.playerIndex, id, false);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 森林漫步: only while Active; look at top 6 of deck, take 1 Energy card to hand, rest reshuffled. */
const forestWalk: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const top = p.deck.slice(-6);
    const energyCards = top.filter(c => c.cardData.supertype === 'Energy');
    if (energyCards.length === 0) return 'done';
    return { prompt: '森林漫步：查看牌庫上方 6 張，選 1 張能量卡加入手牌', choiceType: 'select_from_list', count: 1, options: energyCards.map(c => ({ id: c.id, label: c.cardData.name })), context: { seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    const chosenId = selection[0];
    const seen: GameCard[] = [];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
    }
    for (const c of seen) {
      if (c.id === chosenId) p.hand.push(c);
      else p.deck.unshift(c);
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 快走: once per turn, draw 1 card. */
const quickWalk: EffectHandler = {
  start(ctx) {
    if (player(ctx.G, ctx.playerIndex).deck.length === 0) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 1);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 電氣發電機: from discard, 1 Lightning Energy, attach to a Benched Pokémon. */
const electricGenerator: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null);
    const options = p.discardPile.filter(c => c.cardData.supertype === 'Energy' && (c.cardData.types || []).includes('Lightning'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '電氣發電機：從棄牌區選 1 張雷能量卡', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = p.bench.filter((c): c is GameCard => c !== null);
      return { prompt: '電氣發電機：選擇要附加能量的備戰寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const energyId = context.energyId as string;
    const target = p.bench.find(c => c?.id === selection[0]);
    const i = p.discardPile.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.discardPile.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Lightning' });
    }
    return 'done';
  },
};

/** 燒灼蒸汽: only while Active, once per turn, Burn the opponent's Active. */
const scorchingSteam: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) { opp.active.statusConditions = opp.active.statusConditions.filter(c => c !== 'Burned'); opp.active.statusConditions.push('Burned'); }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 平靜之光: only while Active, once per turn, put the opponent's Active to Sleep. */
const tranquilLight: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) applyStatusCondition(opp.active, 'Asleep');
    return 'done';
  },
  resume() { return 'done'; },
};

/** 必殺手裡劍: only while Active, discard 1 Basic Water Energy from hand, place 6 damage counters on 1 opponent Pokémon. */
const finishingShuriken: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const cost = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Water'));
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1);
    if (cost.length === 0 || targets.length === 0) return 'done';
    return { prompt: '必殺手裡劍：丟棄 1 張基本水能量卡', choiceType: 'select_from_list', count: 1, options: cost.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pay_cost' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pay_cost') {
      const i = p.hand.findIndex(c => c.id === selection[0]);
      if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
      const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1);
      return { prompt: '必殺手裡劍：選擇要放置 6 個傷害指示物的對手寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target' } };
    }
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
    if (target) {
      target.damage += 60;
      const hp = parseInt(target.cardData.hp || '0', 10);
      if (hp > 0 && target.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
    }
    return 'done';
  },
};

/** 烈火亂舞: unlimited uses per turn, attach 1 Basic Fire Energy from hand to any own Pokémon. */
const flameDance: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (options.length === 0 || targets.length === 0) return 'done';
    return { prompt: '烈火亂舞：選 1 張基本火能量卡', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '烈火亂舞：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const energyId = context.energyId as string;
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const i = p.hand.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.hand.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Fire' });
    }
    return 'done';
  },
};

/** 搜尋寶石: on evolve, search deck for up to 2 Trainer cards to hand. (The printed "own Tera Pokémon in play" gate can't be checked — see 玻璃喇叭 in trainers.ts for the same documented simplification.) */
const gemSearch: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Trainer');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '搜尋寶石：從牌庫選最多 2 張訓練家卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveDeckCardToHand(ctx.G, ctx.playerIndex, id);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 扭轉乾坤: once per turn, but ONLY if this player had a Pokémon faint during the opponent's last
 * turn — draw 3. Gated on PtcgPlayerState.lastPokemonFaintedTurn === G.turn - 1 (turns strictly
 * alternate, so "the opponent's last turn" is always exactly one turn number behind this one). No
 * `canPlay` exists for abilities (unlike Trainers) — getLegalMoves always offers a not-yet-used
 * once-per-turn ability regardless of whether it'll do anything, and useAbility marks it used
 * either way — so the gate lives here in start(), matching the same silent-no-op pattern already
 * used elsewhere for conditional once-per-turn abilities. */
const turnaround: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.lastPokemonFaintedTurn !== ctx.G.turn - 1) return 'done';
    if (p.deck.length === 0) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 支配鎖鏈: once per turn, switch a Benched Darkness Pokémon (excluding self) into Active, then Poison the new Active. */
const dominationChain: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null && c.id !== ctx.sourceCardId && (c.cardData.types || []).includes('Darkness'));
    if (!p.active || targets.length === 0) return 'done';
    return { prompt: '支配鎖鏈：選擇要換上場的惡寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const idx = p.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && p.active) {
      const chosen = p.bench[idx]!;
      p.bench[idx] = p.active;
      p.active = chosen;
      chosen.statusConditions = chosen.statusConditions.filter(c => c !== 'Poisoned');
      chosen.statusConditions.push('Poisoned');
    }
    return 'done';
  },
};

/** 精神抽出: on evolve, draw 3. */
const mentalExtraction: EffectHandler = {
  start(ctx) {
    if (player(ctx.G, ctx.playerIndex).deck.length === 0) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 奔流之心: once per turn, place 5 damage counters on self, then this turn its attacks deal +120 damage. */
const torrentHeart: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    self.damage += 50;
    const hp = parseInt(self.cardData.hp || '0', 10);
    if (hp > 0 && self.damage >= hp) { handleKo(ctx.G, ctx.playerIndex, self.id); return 'done'; }
    player(ctx.G, ctx.playerIndex).turnDamageBoosts.push({ amount: 120 });
    return 'done';
  },
  resume() { return 'done'; },
};

/** 火焰蹈舞: once per turn, attach up to 1 Basic Fire + 1 Basic Fighting Energy from hand (combined), to a single chosen own Pokémon. */
const flameStepDance: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && ((c.cardData.types || []).includes('Fire') || (c.cardData.types || []).includes('Fighting')));
    const targets = allPokemon(ctx.G, ctx.playerIndex);
    if (options.length === 0 || targets.length === 0) return 'done';
    return { prompt: '火焰蹈舞：選最多各 1 張基本火／鬥能量卡', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '火焰蹈舞：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.hand.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    return 'done';
  },
};

/** 毛象搬運: once per turn, search deck for 1 Pokémon to hand. */
const mammothCarry: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '毛象搬運：從牌庫選 1 張寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 邀請眨眼: on evolve, look at the opponent's hand and place every Basic Pokémon card found onto their Bench. */
const invitingWink: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const movable = opp.hand.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic'));
    for (const card of movable) {
      const slot = opp.bench.findIndex(s => s === null);
      if (slot === -1) break;
      const i = opp.hand.findIndex(c => c.id === card.id);
      if (i === -1) continue;
      opp.bench[slot] = opp.hand.splice(i, 1)[0];
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 飽腹時間: on evolve, fully heal every own evolved Pokémon, then discard all Energy attached to each healed Pokémon. */
const bellyfulTime: EffectHandler = {
  start(ctx) {
    for (const c of allPokemon(ctx.G, ctx.playerIndex)) {
      if (!hasEvolvesFrom(c.cardData)) continue;
      c.damage = 0;
      for (const energy of c.attachedEnergy.splice(0)) discardAttachedEnergy(ctx.G, ctx.playerIndex, energy);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 金屬製造者: once per turn, look at top 4 of deck, take any number of Basic Metal Energy, attach to a single chosen own Pokémon, reshuffle the rest. */
const metalMaker: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-4);
    const options = top.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Metal'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '金屬製造者：查看牌庫上方 4 張，選任意數量的基本鋼能量卡', choiceType: 'select_from_list', maxCount: options.length, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy', seenIds: top.map(c => c.id) } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const seenIds = context.seenIds as string[];
      if (selection.length === 0) {
        // Nothing taken — the whole top-4 view goes back to the bottom, reshuffled.
        shuffleDeck(p.deck);
        return 'done';
      }
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      return { prompt: '金屬製造者：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection, seenIds } };
    }
    const target = p.active?.id === selection[0] ? p.active : p.bench.find(c => c?.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.deck.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: 'Metal' });
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 暗中咬住: on evolve, place 2 damage counters on 1 opponent Pokémon. */
const stealthBite: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = [opp.active, ...opp.bench].filter((c): c is GameCard => c !== null);
    if (targets.length === 0) return 'done';
    return { prompt: '暗中咬住：選擇對手 1 隻寶可夢放置 2 個傷害指示物', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = opp.active?.id === selection[0] ? opp.active : opp.bench.find(c => c?.id === selection[0]);
    if (target) {
      target.damage += 20;
      const hp = parseInt(target.cardData.hp || '0', 10);
      if (hp > 0 && target.damage >= hp) handleKo(ctx.G, (1 - ctx.playerIndex) as 0 | 1, target.id);
    }
    return 'done';
  },
};

/** 幸福切換: once per turn, move a Basic Energy from one own Pokémon to another. */
const happinessSwitch: EffectHandler = {
  start(ctx) {
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.attachedEnergy.length > 0);
    if (sources.length === 0) return 'done';
    const options = sources.flatMap(c => c.attachedEnergy.map(e => ({ id: e.id, label: `${c.cardData.name} 的 ${e.type} 能量` })));
    return { prompt: '幸福切換：選擇要移動的能量', choiceType: 'select_from_list', count: 1, options, context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_energy') {
      const energyId = selection[0];
      const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === energyId));
      if (!source) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== source.id);
      if (targets.length === 0) return 'done';
      return { prompt: '幸福切換：選擇要轉入的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId } };
    }
    const energyId = context.energyId as string;
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === energyId));
    const target = findOwnPokemon(ctx.G, ctx.playerIndex, selection[0]);
    if (source && target) {
      const i = source.attachedEnergy.findIndex(e => e.id === energyId);
      if (i >= 0) target.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 逃跑抽出: only while Active, once per turn: draw 3, then shuffle self (with attachments) back into the deck. */
const escapeDraw: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 3);
    const self = p.active;
    for (const energy of self.attachedEnergy.splice(0)) discardAttachedEnergy(ctx.G, ctx.playerIndex, energy);
    if (self.attachedTool) { p.discardPile.push(self.attachedTool); self.attachedTool = null; }
    self.damage = 0;
    self.statusConditions = [];
    flushPreEvolutionsToDiscard(self, p.discardPile);
    p.deck.push(self);
    const promo = p.bench.find(c => c !== null);
    p.active = promo || null;
    if (promo) p.bench[p.bench.indexOf(promo)] = null;
    shuffleDeck(p.deck);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 夜間工作: only while Active, once per turn: pick any 1 card from the deck, put it back on top (rest reshuffled). */
const nightWork: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId || p.deck.length === 0) return 'done';
    return { prompt: '夜間工作：從牌庫任意選 1 張卡放回牌庫最上方', choiceType: 'select_from_list', count: 1, options: p.deck.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.deck.findIndex(c => c.id === selection[0]);
    if (i === -1) return 'done';
    const chosen = p.deck.splice(i, 1)[0];
    shuffleDeck(p.deck);
    p.deck.push(chosen);
    return 'done';
  },
};

/** 發酵果汁: conditional (self holds Grass Energy), once per turn: heal 30 on a chosen own Pokémon. */
const fermentedJuice: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || !self.attachedEnergy.some(e => e.type === 'Grass')) return 'done';
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '發酵果汁：選擇要恢復 30 HP 的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) target.damage = Math.max(0, target.damage - 30);
    return 'done';
  },
};

/** 熱浪鱗粉: discard 1 Basic Fire Energy from hand, Burn the opponent's Active. */
const heatWaveScales: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const cost = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    if (cost.length === 0 || !opponent(ctx.G, ctx.playerIndex).active) return 'done';
    return { prompt: '熱浪鱗粉：丟棄 1 張基本火能量卡', choiceType: 'select_from_list', count: 1, options: cost.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) { opp.active.statusConditions = opp.active.statusConditions.filter(c => c !== 'Burned'); opp.active.statusConditions.push('Burned'); }
    return 'done';
  },
};

/** 曲扭未來: only while Active, once per turn: the opponent shuffles their hand into their deck and draws 3. */
const twistedFuture: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    opp.deck.push(...opp.hand);
    opp.hand = [];
    shuffleDeck(opp.deck);
    drawCards(ctx.G, (1 - ctx.playerIndex) as 0 | 1, 3);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 月光循環: conditional (own field has "太陽岩"), discard 1 Basic Fighting Energy from hand, once per turn: draw 3. */
const moonlightCycle: EffectHandler = {
  start(ctx) {
    if (!allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name === '太陽岩')) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const cost = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting'));
    if (cost.length === 0) return 'done';
    return { prompt: '月光循環：丟棄 1 張基本鬥能量卡', choiceType: 'select_from_list', count: 1, options: cost.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0) p.discardPile.push(p.hand.splice(i, 1)[0]);
    drawCards(ctx.G, ctx.playerIndex, 3);
    return 'done';
  },
};

/** 原始之翼: only while Active, once per turn: de-evolve 1 opponent evolved Pokémon by one stage (the removed evolution card returns to their hand). */
const primalWing: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    const targets = allPokemon(ctx.G, (1 - ctx.playerIndex) as 0 | 1).filter(c => hasEvolvesFrom(c.cardData));
    if (targets.length === 0) return 'done';
    return { prompt: '原始之翼：選擇對手 1 隻進化寶可夢使其退化', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const oppIdx = (1 - ctx.playerIndex) as 0 | 1;
    const opp = opponent(ctx.G, ctx.playerIndex);
    const target = allPokemon(ctx.G, oppIdx).find(c => c.id === selection[0]);
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
    const isActive = opp.active?.id === target.id;
    const benchIdx = isActive ? -1 : opp.bench.findIndex(c => c?.id === target.id);
    if (isActive) opp.active = priorStage; else if (benchIdx >= 0) opp.bench[benchIdx] = priorStage;
    // Only the removed evolution card itself returns to hand — it carries no stacked history.
    opp.hand.push({ ...target, damage: 0, statusConditions: [], attachedEnergy: [], attachedTool: null, preEvolutions: undefined });
    return 'done';
  },
};

/** 金屬信號: once per turn, search deck for up to 2 Metal-type Evolution Pokémon to hand. */
const metalSignal: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon' && (c.cardData.types || []).includes('Metal') && hasEvolvesFrom(c.cardData));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '金屬信號：從牌庫選最多 2 張鋼屬性進化寶可夢卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) moveDeckCardToHand(ctx.G, ctx.playerIndex, id);
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 繁星花紋: on evolve, force-switch 1 opponent Benched Pokémon with 90 or less remaining HP into Active. */
const starryPattern: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const targets = opp.bench.filter((c): c is GameCard => {
      if (!c) return false;
      const hp = parseInt(c.cardData.hp || '0', 10);
      return hp > 0 && hp - c.damage <= 90;
    });
    if (targets.length === 0) return 'done';
    return { prompt: '繁星花紋：選擇對手備戰區剩餘 HP 90 以下的寶可夢換上場', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    }
    return 'done';
  },
};

/** 柔柔治癒: on evolve, fully heal the own Active Grass Pokémon, then discard all Energy attached to it. */
const gentleHealing: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active && (p.active.cardData.types || []).includes('Grass')) {
      p.active.damage = 0;
      for (const energy of p.active.attachedEnergy.splice(0)) discardAttachedEnergy(ctx.G, ctx.playerIndex, energy);
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 充能: once per turn, from discard, 1 Basic Energy, attach to SELF only. */
const charge: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.discardPile.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    if (options.length === 0) return 'done';
    return { prompt: '充能：從棄牌區選 1 張基本能量卡附於自己身上', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const i = p.discardPile.findIndex(c => c.id === selection[0]);
    if (self && i >= 0) {
      const energy = p.discardPile.splice(i, 1)[0];
      self.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
};

/** 四季變換: once per turn, search deck for 1 Stadium card to hand. */
const seasonChange: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Stadium'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '四季變換：從牌庫選 1 張競技場卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 表演時間: only while Benched, once per turn: swap self into Active. */
const showTime: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || !p.active || p.active.id === self.id) return 'done';
    const benchIdx = p.bench.findIndex(c => c?.id === self.id);
    if (benchIdx === -1) return 'done';
    const oldActive = p.active;
    clearStatusConditionsOnLeaveActive(oldActive);
    p.bench[benchIdx] = oldActive;
    p.active = self;
    return 'done';
  },
  resume() { return 'done'; },
};

/** 重步跳躍: only while Benched, once per turn: discard the bottom card of your deck, then discard this Pokémon's attachments and shuffle it back onto the TOP of the deck. */
const heavyStepJump: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    const benchIdx = p.bench.findIndex(c => c?.id === self.id);
    if (benchIdx === -1) return 'done';
    if (p.deck.length > 0) p.discardPile.push(p.deck.shift()!);
    p.bench[benchIdx] = null;
    if (self.attachedTool) p.discardPile.push(self.attachedTool);
    for (const energy of self.attachedEnergy.splice(0)) discardAttachedEnergy(ctx.G, ctx.playerIndex, energy);
    self.attachedTool = null;
    self.damage = 0;
    self.statusConditions = [];
    flushPreEvolutionsToDiscard(self, p.discardPile);
    p.deck.push(self);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 惡棍衝天: once per turn, from DECK (not discard — printed text is "從自己的牌庫選擇...並且重洗
 * 牌庫"), 1 Basic Darkness Energy, attach to a Benched Darkness Pokémon, shuffle the deck, then
 * place 2 damage counters on it. */
const villainRise: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Darkness'));
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Darkness'));
    if (targets.length === 0 || options.length === 0) return 'done';
    return { prompt: '惡棍衝天：從牌庫選 1 張基本惡能量卡', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Darkness'));
      return { prompt: '惡棍衝天：選擇要附加能量的惡寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
    }
    const target = p.bench.find(c => c?.id === selection[0]);
    const energyId = context.energyId as string;
    const i = p.deck.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.deck.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Darkness' });
      target.damage += 20;
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 天空搬運: once per turn, switch Active ↔ Bench. */
const skyCarry: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active || !p.bench.some(s => s !== null)) return 'done';
    return { prompt: '天空搬運：選擇要換上場的備戰寶可夢', choiceType: 'select_pokemon', count: 1, options: p.bench.filter((s): s is GameCard => s !== null).map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const idx = p.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && p.active) { const b = p.bench[idx]!; clearStatusConditionsOnLeaveActive(p.active); p.bench[idx] = p.active; p.active = b; }
    return 'done';
  },
};

/** 沙之羽擊: real text triggers both on evolve AND when KO'd by an attack — only the evolve
 * trigger is implemented (the on-KO trigger would need a hook into the attack-KO branch of
 * moves.ts for an ability that's about to leave play, which the current EffectContext shape
 * doesn't cleanly support). On evolve: discard the opponent's top 2 deck cards. */
const sandWingbeat: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (let i = 0; i < 2 && opp.deck.length > 0; i++) opp.discardPile.push(opp.deck.pop()!);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 搜尋點心: once per turn, look at the top card of your deck; optionally discard it. */
const snackSearch: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.deck.length === 0) return 'done';
    const top = p.deck[p.deck.length - 1];
    return {
      prompt: `搜尋點心：牌庫最上方是「${top.cardData.name}」，是否丟棄？`,
      choiceType: 'select_from_list',
      count: 1,
      options: [{ id: 'discard', label: '丟棄' }, { id: 'keep', label: '保留' }],
      context: { topId: top.id },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0] === 'discard') {
      const i = p.deck.findIndex(c => c.id === context.topId);
      if (i >= 0) p.discardPile.push(p.deck.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 過度放電: once per turn; using it KOs this Pokémon. Then discard up to 3 Basic Energy from
 * the discard pile, attach them all to one chosen own Lightning-type Pokémon — simplified to a
 * single target rather than a per-card distribution, matching attachEnergyFromDiscardAbility's
 * existing single-target shape. */
const overdischarge: EffectHandler = {
  start(ctx) {
    handleKo(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.discardPile.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => (t.cardData.types || []).includes('Lightning'));
    if (options.length === 0 || targets.length === 0) return 'done';
    return {
      prompt: '過度放電：從棄牌區選最多 3 張基本能量卡',
      choiceType: 'select_from_list',
      maxCount: Math.min(3, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { step: 'pick_energy' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(t => (t.cardData.types || []).includes('Lightning'));
      if (targets.length === 0) return 'done';
      return {
        prompt: '過度放電：選擇要附加能量的雷寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyIds: selection },
      };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
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

/** 媚惑引誘: once per turn, flip a coin; if heads, force-switch one of the opponent's Benched
 * Pokémon into Active, then Confuse the newly-promoted Pokémon. */
const enticingLure: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (!opp.active || benched.length === 0) return 'done';
    return {
      prompt: '媚惑引誘：擲硬幣結果為正面，選 1 隻對手備戰寶可夢換上場',
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
      applyStatusCondition(opp.active, 'Confused');
    }
    return 'done';
  },
};

/** 狂挖: real trigger is "when played from hand onto the Bench" — the engine has no on-play
 * auto-trigger hook, so this is implemented as a regular once-per-turn triggered ability instead
 * (consistent with how other on-play/on-evolve abilities in this file are simplified). Search
 * the deck for up to 3 Basic Fighting Energy cards and discard them (a mill/thinning effect,
 * not an attach), then reshuffle. */
const franticDig: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fighting'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '狂挖：從牌庫選最多 3 張基本鬥能量卡丟棄',
      choiceType: 'select_from_list',
      maxCount: Math.min(3, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
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

/** 王者呼聲: once per turn, search the deck for 1 "竹蘭的" family Pokémon, add to hand, reshuffle. */
const kingsCall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('竹蘭的'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '王者呼聲：從牌庫選 1 張「竹蘭的寶可夢」加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 火箭腦力: unlimited use per turn — move 1 damage counter from your own "火箭隊的" Pokémon to
 * another of your own Pokémon. */
const rocketBrainpower: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.includes('火箭隊的') && c.damage > 0);
    if (sources.length === 0) return 'done';
    return {
      prompt: '火箭腦力：選 1 隻己方受傷的「火箭隊的寶可夢」搬走 1 個傷害指示物',
      choiceType: 'select_pokemon',
      count: 1,
      options: sources.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })),
      context: { step: 'pick_source' },
    };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_source') {
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== selection[0]);
      if (targets.length === 0) return 'done';
      return {
        prompt: '火箭腦力：選擇要移入 1 個傷害指示物的己方寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(c => ({ id: c.id, label: c.cardData.name })),
        context: { step: 'pick_target', sourceId: selection[0] },
      };
    }
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === context.sourceId);
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (source && target && source.damage > 0) {
      source.damage -= 10;
      target.damage += 10;
    }
    return 'done';
  },
};

/** 尖刺纏身: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability (same simplification as 狂挖 above, no on-evolve auto-trigger
 * hook exists). Discard up to 2 named "扣殺能量" Special Energy from the discard pile, attach to self. */
const spikeCling: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const options = p.discardPile.filter(c => c.cardData.name === '扣殺能量');
    if (!self || options.length === 0) return 'done';
    return {
      prompt: '尖刺纏身：從棄牌區選最多 2 張「扣殺能量」附於自己身上',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (self) {
      for (const id of selection) {
        const i = p.discardPile.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.discardPile.splice(i, 1)[0];
        self.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    return 'done';
  },
};

/** 誘導之尾: once per turn, discard 1 named "悠哉尾草棒" card from hand as a cost, then
 * force-switch one of the opponent's Benched Pokémon into Active. */
const luringTail: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const costCard = p.hand.find(c => c.cardData.name === '悠哉尾草棒');
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (!costCard || !opp.active || benched.length === 0) return 'done';
    return {
      prompt: '誘導之尾：丟棄 1 張「悠哉尾草棒」，選 1 隻對手備戰寶可夢換上場',
      choiceType: 'select_pokemon',
      count: 1,
      options: benched.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { costCardId: costCard.id },
    };
  },
  resume(ctx, context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      discardFromHand(ctx.G, ctx.playerIndex, [context.costCardId as string]);
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    }
    return 'done';
  },
};

/** 貪慾點餐: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability (same simplification as 狂挖/尖刺纏身 above). Search the discard
 * pile for up to 2 named "派帕的三明治" cards, add to hand. */
const greedyOrder: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.discardPile.filter(c => c.cardData.name === '派帕的三明治');
    if (options.length === 0) return 'done';
    return {
      prompt: '貪慾點餐：從棄牌區選最多 2 張「派帕的三明治」加入手牌',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.discardPile.findIndex(c => c.id === id);
      if (i >= 0) p.hand.push(p.discardPile.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 再構築: once per turn, discard 2 hand cards as cost, then draw 1. */
const reconstruction: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length < 2) return 'done';
    return {
      prompt: '再構築：丟棄 2 張手牌',
      choiceType: 'select_from_list',
      count: 2,
      options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    if (selection.length < 2) return 'done';
    discardFromHand(ctx.G, ctx.playerIndex, selection);
    drawCards(ctx.G, ctx.playerIndex, 1);
    return 'done';
  },
};

/** 殺手鐧捕捉: real trigger is "on play from hand onto the Bench" — simplified to a regular
 * once-per-turn triggered ability (same simplification as 狂挖/尖刺纏身/貪慾點餐). Search the deck
 * for 1 Supporter card, add to hand, reshuffle. The printed same-turn exclusivity with other
 * "殺手鐧"-prefixed abilities on other cards isn't modeled — only this exact ability name's own
 * once-per-turn use is enforced (via the normal abilitiesUsedThisTurn tracking). */
const killerMoveCapture: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Supporter'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '殺手鐧捕捉：從牌庫選 1 張支援者卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 脫殼: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability (same simplification pattern used elsewhere in this file).
 * Search the deck for 1 named "脫殼忍者", place it directly onto the Bench, reshuffle. */
const shedShell: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.bench.every(s => s !== null)) return 'done';
    const match = p.deck.find(c => c.cardData.name === '脫殼忍者');
    if (!match) { shuffleDeck(p.deck); return 'done'; }
    moveDeckCardToBench(ctx.G, ctx.playerIndex, match.id);
    shuffleDeck(p.deck);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 沉雪: real trigger is "on play from hand onto the Bench" — simplified to a regular
 * once-per-turn triggered ability. Discard whichever Stadium card is currently in play. */
const snowSink: EffectHandler = {
  start(ctx) {
    const G = ctx.G;
    if (G.activeStadium) {
      player(G, G.activeStadium.owner).discardPile.push(G.activeStadium);
      G.activeStadium = null;
    }
    return 'done';
  },
  resume() { return 'done'; },
};

/** 使者衝刺: once per turn, only while this Pokémon is Active: draw 2 cards. The printed
 * same-turn exclusivity with other "使者衝刺" copies is naturally covered by the normal
 * once-per-turn-by-name tracking. */
const messengerDash: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 2);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 激動渦輪: unlimited use per turn, gated on own field having a Fire-type "超級進化...ex"
 * (Mega Evolution ex) Pokémon in play. Attach 1 Basic Fire Energy from hand to a Benched Fire
 * Pokémon. */
const excitedTurbine: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const hasGate = allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name.startsWith('超級')
      && c.cardData.subtypes.includes('ex') && (c.cardData.types || []).includes('Fire'));
    if (!hasGate) return 'done';
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Fire'));
    if (options.length === 0 || targets.length === 0) return 'done';
    return {
      prompt: '激動渦輪：選 1 張基本火能量卡',
      choiceType: 'select_from_list',
      count: 1,
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { step: 'pick_energy' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const targets = p.bench.filter((c): c is GameCard => c !== null && (c.cardData.types || []).includes('Fire'));
      if (targets.length === 0) return 'done';
      return {
        prompt: '激動渦輪：選擇要附加能量的備戰火寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyId: selection[0] },
      };
    }
    const target = p.bench.find(c => c?.id === selection[0]);
    const energyId = context.energyId as string;
    const i = p.hand.findIndex(c => c.id === energyId);
    if (target && i >= 0) {
      const energy = p.hand.splice(i, 1)[0];
      target.attachedEnergy.push({ id: energy.id, type: 'Fire' });
    }
    return 'done';
  },
};

/** 快節奏: once per turn, put 1 hand card on the bottom of the deck as a cost, then draw back up to 5. */
const quickTempo: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return {
      prompt: '快節奏：選 1 張手牌放回牌庫下方',
      choiceType: 'select_from_list',
      count: 1,
      options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0) p.deck.unshift(p.hand.splice(i, 1)[0]);
    drawUpTo(ctx.G, ctx.playerIndex, 5);
    return 'done';
  },
};

/** 悉心治癒: real trigger is "on play from hand onto the Bench" — simplified to a regular
 * once-per-turn triggered ability. Heal your own Active 30 HP and cure 1 special condition. */
const attentiveHealing: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active) return 'done';
    p.active.damage = Math.max(0, p.active.damage - 30);
    if (p.active.statusConditions.length > 0) p.active.statusConditions.shift();
    return 'done';
  },
  resume() { return 'done'; },
};

/** 挑戰角擊: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Force-switch 1 of the opponent's Benched Pokémon into Active. */
const challengeHornAttack: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (!opp.active || benched.length === 0) return 'done';
    return { prompt: '挑戰角擊：選 1 隻對手備戰寶可夢換上場', choiceType: 'select_pokemon', count: 1, options: benched.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    }
    return 'done';
  },
};

/** 拍檔提升: once per turn, from hand, up to 1 Basic Fire Energy AND up to 1 Basic Lightning
 * Energy (independently, any distribution), attach to your own named "電擊魔獸" or "鴨嘴炎獸". */
const partnerBoost: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name === '電擊魔獸' || c.cardData.name === '鴨嘴炎獸');
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && ((c.cardData.types || []).includes('Fire') || (c.cardData.types || []).includes('Lightning')));
    if (targets.length === 0 || options.length === 0) return 'done';
    return {
      prompt: '拍檔提升：選最多各 1 張基本火/雷能量卡',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { step: 'pick_energy' },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name === '電擊魔獸' || c.cardData.name === '鴨嘴炎獸');
      if (targets.length === 0) return 'done';
      return {
        prompt: '拍檔提升：選擇要附加能量的寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyIds: selection },
      };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.hand.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    return 'done';
  },
};

/** 進化指引: gated on this Pokémon holding at least 1 attached Energy; once per turn, search the
 * deck for 1 evolved-stage Pokémon card (Stage 1/Stage 2), add to hand, reshuffle. */
const evolutionGuide: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || self.attachedEnergy.length === 0) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon' && hasEvolvesFrom(c.cardData));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '進化指引：從牌庫選 1 張進化寶可夢卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 全滿旋律: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Fully heal 1 chosen own Pokémon. */
const fullMelody: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '全滿旋律：選 1 隻己方寶可夢全部回復 HP', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) target.damage = 0;
    return 'done';
  },
};

/** 破壞頭錘: only while Active, once per turn: flip a coin; on heads, discard 1 Energy attached
 * to the opponent's Active. */
const wreckingHeadbutt: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (!opp.active || opp.active.attachedEnergy.length === 0) return 'done';
    return { prompt: '破壞頭錘：擲硬幣結果為正面，選 1 張對手戰鬥寶可夢身上的能量丟棄', choiceType: 'select_from_list', count: 1, options: opp.active.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) {
      const i = opp.active.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) discardAttachedEnergy(ctx.G, opp.active.owner, opp.active.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 天空抽出: once per turn, draw 1 card. */
const skyDraw: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 1);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 拍檔呼喚: gated on an empty hand; once per turn, search the deck for 1 Supporter card, add to hand, reshuffle. */
const partnerCall: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length > 0) return 'done';
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Supporter'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '拍檔呼喚：從牌庫選 1 張支援者卡加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 閃焰魔法: once per turn, discard 1 Basic Fire Energy from hand as a cost, then draw back up to 7. */
const blazeSpell: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const cost = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Fire'));
    if (cost.length === 0) return 'done';
    return { prompt: '閃焰魔法：丟棄 1 張基本火能量卡', choiceType: 'select_from_list', count: 1, options: cost.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    if (selection[0]) {
      discardFromHand(ctx.G, ctx.playerIndex, [selection[0]]);
      drawUpTo(ctx.G, ctx.playerIndex, 7);
    }
    return 'done';
  },
};

/** 怨恨進化: once per turn (real text also excludes the game's first turn — not separately
 * enforced here since abilities.ts has no access to isFirstTurnOfGame without risking a
 * circular import with validation.ts, a documented minor simplification). Evolve this Pokémon
 * using a card from hand that evolves from it, then place 2 damage counters on the result. */
const grudgeEvolution: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const p = player(ctx.G, ctx.playerIndex);
    if (!self) return 'done';
    const options = p.hand.filter(c => evolvesFromMatches(c.cardData, self.cardData.name));
    if (options.length === 0) return 'done';
    return { prompt: '怨恨進化：選 1 張手牌進化卡完成進化', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const handIdx = p.hand.findIndex(c => c.id === selection[0]);
    if (handIdx === -1) return 'done';
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    const isActive = p.active?.id === self.id;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === self.id);
    if (!isActive && benchIdx === -1) return 'done';
    const evolution = p.hand.splice(handIdx, 1)[0];
    p.discardPile.push(self);
    evolution.attachedEnergy = self.attachedEnergy;
    evolution.damage = self.damage + 20;
    evolution.attachedTool = self.attachedTool;
    if (isActive) p.active = evolution; else p.bench[benchIdx] = evolution;
    return 'done';
  },
};

/** 金屬之路: real trigger is "on promoting this Pokémon from Bench to Active" — simplified to a
 * regular once-per-turn triggered ability. Move ALL Metal Energy attached to 1 chosen own other
 * Pokémon onto this one — a documented simplification of the printed "any amount from any of
 * your Pokémon" scope, which would need a multi-source selection UI this framework doesn't have. */
const metalRoad: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== self.id && c.attachedEnergy.some(e => e.type === 'Metal'));
    if (sources.length === 0) return 'done';
    return { prompt: '金屬之路：選 1 隻己方寶可夢，將其身上所有鋼能量移到這隻寶可夢身上', choiceType: 'select_pokemon', count: 1, options: sources.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (self && source) {
      const metal = source.attachedEnergy.filter(e => e.type === 'Metal');
      source.attachedEnergy = source.attachedEnergy.filter(e => e.type !== 'Metal');
      self.attachedEnergy.push(...metal);
    }
    return 'done';
  },
};

/** 穹天狩獵: once per turn, flip a coin; on heads, discard 1 random card from the opponent's hand (blind). */
const skyburstHunt: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.hand.length === 0) return 'done';
    const i = Math.floor(Math.random() * opp.hand.length);
    opp.discardPile.push(opp.hand.splice(i, 1)[0]);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 岩石武裝: once per turn, from hand, 1 Basic Fighting Energy, attach to an own Fighting Pokémon. */
const rockArmament = attachEnergyFromHandAbility('岩石武裝', 'Fighting', 1, false);

/** 百花齊放: once per turn, search the deck for 1 "莉佳的" family Pokémon, add to hand, reshuffle. */
const flowerBloom: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.name.includes('莉佳的'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '百花齊放：從牌庫選 1 張「莉佳的寶可夢」加入手牌', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToHand(ctx.G, ctx.playerIndex, selection[0]); else shuffleDeck(p.deck);
    return 'done';
  },
};

/** 能量舞步: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Look at the top 4 deck cards, attach any number of the Basic
 * Energy cards among them to 1 chosen own Pokémon (simplified to a single target rather than
 * per-card distribution), shuffle the rest back. */
const energyDance: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-4);
    const energyOptions = top.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    if (energyOptions.length === 0) { return 'done'; }
    return {
      prompt: '能量舞步：牌庫最上方 4 張中，選任意數量基本能量卡',
      choiceType: 'select_from_list',
      maxCount: energyOptions.length,
      options: energyOptions.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { step: 'pick_energy', seenIds: top.map(c => c.id) },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const seenIds = context.seenIds as string[];
      // Pull the 4 seen cards off the deck now; non-selected ones go back at the bottom, reshuffled.
      const seen: GameCard[] = [];
      for (const id of seenIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
      }
      const notChosen = seen.filter(c => !selection.includes(c.id));
      p.deck.unshift(...notChosen);
      shuffleDeck(p.deck);
      if (selection.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      if (targets.length === 0) return 'done';
      return {
        prompt: '能量舞步：選擇要附加能量的寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyCards: selection.map(id => seen.find(c => c.id === id)).filter((c): c is GameCard => !!c).map(c => ({ id: c.id, type: c.cardData.types?.[0] || 'Colorless' })) },
      };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
    const energyCards = context.energyCards as { id: string; type: string }[];
    if (target) {
      for (const e of energyCards) target.attachedEnergy.push({ id: e.id, type: e.type as any });
    }
    return 'done';
  },
};

/** 臨場之錘: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Coin flip; on heads, discard 1 Energy attached to the
 * opponent's Active. */
const timelyHammer: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (!opp.active || opp.active.attachedEnergy.length === 0) return 'done';
    return { prompt: '臨場之錘：擲硬幣結果為正面，選 1 張對手戰鬥寶可夢身上的能量丟棄', choiceType: 'select_from_list', count: 1, options: opp.active.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) {
      const i = opp.active.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) discardAttachedEnergy(ctx.G, opp.active.owner, opp.active.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 頸傘發電: real gate is "played 卡娜莉 from hand THIS turn" — simplified to "卡娜莉 is in play"
 * (no same-turn-play tracker exists for arbitrary named cards). Once per turn, deck search up to
 * 2 Basic Lightning Energy, attach to self, reshuffle. */
const napeUmbrellaGenerator: EffectHandler = {
  start(ctx) {
    const hasGate = allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name === '卡娜莉');
    if (!hasGate) return 'done';
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Lightning'));
    if (!self || options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return {
      prompt: '頸傘發電：從牌庫選最多 2 張基本雷能量卡附於自己身上',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (self) {
      for (const id of selection) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.deck.splice(i, 1)[0];
        self.attachedEnergy.push({ id: energy.id, type: 'Lightning' });
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 微風吹拂: once per turn, coin flip; on heads, remove 1 Energy attached to the opponent's
 * Active. Printed text returns it to their hand, but attachedEnergy only tracks {id,type}, not
 * a full Card object, so there's nothing to reconstruct into a hand card — simplified to
 * discard instead (same documented simplification as 悠哉尾草棒 elsewhere in this codebase). */
const gentleBreeze: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (!opp.active || opp.active.attachedEnergy.length === 0) return 'done';
    return { prompt: '微風吹拂：擲硬幣結果為正面，選 1 張對手戰鬥寶可夢身上的能量丟棄', choiceType: 'select_from_list', count: 1, options: opp.active.attachedEnergy.map(e => ({ id: e.id, label: e.type })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) {
      const i = opp.active.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) discardAttachedEnergy(ctx.G, opp.active.owner, opp.active.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 蒐證: once per turn, choose 1 hand card and swap it with the top card of the deck. */
const evidenceGathering: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0 || p.deck.length === 0) return 'done';
    return { prompt: '蒐證：選 1 張手牌與牌庫最上方交換', choiceType: 'select_from_list', count: 1, options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const handIdx = p.hand.findIndex(c => c.id === selection[0]);
    if (handIdx === -1 || p.deck.length === 0) return 'done';
    const top = p.deck.pop()!;
    const handCard = p.hand.splice(handIdx, 1)[0];
    p.deck.push(handCard);
    p.hand.push(top);
    return 'done';
  },
};

/** 日光轉移: unlimited use per turn — move 1 attached Basic Grass Energy from one own Pokémon to another. */
const sunlightTransfer: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.attachedEnergy.some(e => e.type === 'Grass'));
    if (sources.length === 0) return 'done';
    return { prompt: '日光轉移：選 1 隻己方寶可夢身上的基本草能量', choiceType: 'select_from_list', count: 1, options: sources.flatMap(c => c.attachedEnergy.filter(e => e.type === 'Grass').map(e => ({ id: e.id, label: `${c.cardData.name}：${e.type}` }))), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    if (context.step === 'pick_energy') {
      const targets = allPokemon(ctx.G, ctx.playerIndex);
      if (targets.length === 0) return 'done';
      return {
        prompt: '日光轉移：選擇要移入能量的寶可夢',
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
      const i = source.attachedEnergy.findIndex(e => e.id === energyId);
      if (i >= 0) target.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 返回重載: real trigger is "on retreating from Active to Bench" — simplified to a regular
 * once-per-turn triggered ability usable while Benched (no same-turn-retreat tracker exists).
 * From hand, up to 2 Basic Water Energy, attach to self. */
const returnReload: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.hand.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Water'));
    if (!self || options.length === 0) return 'done';
    return {
      prompt: '返回重載：從手牌選最多 2 張基本水能量卡附於自己身上',
      choiceType: 'select_from_list',
      maxCount: Math.min(2, options.length),
      options: options.map(c => ({ id: c.id, label: c.cardData.name })),
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (self) {
      for (const id of selection) {
        const i = p.hand.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.hand.splice(i, 1)[0];
        self.attachedEnergy.push({ id: energy.id, type: 'Water' });
      }
    }
    return 'done';
  },
};

/** 溫柔鰭: only while Active, once per turn: from the discard pile, choose 1 Basic Pokémon with
 * printed HP <= 70, place it directly onto the Bench. */
const gentleFin: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    if (p.bench.every(s => s !== null)) return 'done';
    const options = p.discardPile.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && parseInt(c.cardData.hp || '999', 10) <= 70);
    if (options.length === 0) return 'done';
    return { prompt: '溫柔鰭：從棄牌區選 1 張 HP70 以下的基礎寶可夢放置於備戰區', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const slot = p.bench.findIndex(s => s === null);
    const i = p.discardPile.findIndex(c => c.id === selection[0]);
    if (slot >= 0 && i >= 0) {
      const card = p.discardPile.splice(i, 1)[0];
      resetCardForReentry(card);
      p.bench[slot] = card;
    }
    return 'done';
  },
};

/** 瞄準獵物: once per turn, look at the opponent's hand and choose 1 Basic Pokémon with printed
 * HP <= 70, placing it directly onto the OPPONENT's Bench. */
const targetPrey: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.bench.every(s => s !== null)) return 'done';
    const options = opp.hand.filter(c => c.cardData.supertype === 'Pokémon' && c.cardData.subtypes.includes('Basic') && parseInt(c.cardData.hp || '999', 10) <= 70);
    if (options.length === 0) return 'done';
    return { prompt: '瞄準獵物：查看對手手牌，選 1 張 HP70 以下的基礎寶可夢放置於對手備戰區', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const slot = opp.bench.findIndex(s => s === null);
    const i = opp.hand.findIndex(c => c.id === selection[0]);
    if (slot >= 0 && i >= 0) opp.bench[slot] = opp.hand.splice(i, 1)[0];
    return 'done';
  },
};

/** 飛葉治癒: once per turn, heal your own Active 20 HP. */
const leafHealing: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active) p.active.damage = Math.max(0, p.active.damage - 20);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 熱情舞: once per turn, heal your own Active 20 HP — but only if it's an evolved Pokémon
 * (i.e. not a Basic). */
const floralDance: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active && !p.active.cardData.subtypes.includes('Basic')) p.active.damage = Math.max(0, p.active.damage - 20);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 激流旋渦: once per turn, swap your own Active <-> a chosen Bench Pokémon, then also
 * force-swap the opponent's Active <-> a chosen Benched Pokémon (the ability's controller picks
 * the opponent's replacement too — the same simplification used by every other force-switch
 * ability in this file, since the opponent side isn't independently interactive here). */
const torrentVortex: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active || !p.bench.some(s => s !== null)) return 'done';
    return { prompt: '激流旋渦：選擇己方要換上場的備戰寶可夢', choiceType: 'select_pokemon', count: 1, options: p.bench.filter((s): s is GameCard => s !== null).map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'own_switch' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'own_switch') {
      const idx = p.bench.findIndex(c => c?.id === selection[0]);
      if (idx >= 0 && p.active) { const b = p.bench[idx]!; clearStatusConditionsOnLeaveActive(p.active); p.bench[idx] = p.active; p.active = b; }
      const opp = opponent(ctx.G, ctx.playerIndex);
      const oppBenched = opp.bench.filter((c): c is GameCard => c !== null);
      if (!opp.active || oppBenched.length === 0) return 'done';
      return { prompt: '激流旋渦：選擇對手要換上場的備戰寶可夢', choiceType: 'select_pokemon', count: 1, options: oppBenched.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'opp_switch' } };
    }
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) { const b = opp.bench[idx]!; clearStatusConditionsOnLeaveActive(opp.active); opp.bench[idx] = opp.active; opp.active = b; }
    return 'done';
  },
};

/** 任選黏液: once per turn, coin flip; on heads, choose Poison/Burn/Confused and inflict it on the opponent's Active. */
const pickAnyMucus: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (!opp.active) return 'done';
    return {
      prompt: '任選黏液：擲硬幣結果為正面，選擇要施加的特殊狀態',
      choiceType: 'select_from_list',
      count: 1,
      options: [{ id: 'Poisoned', label: '中毒' }, { id: 'Burned', label: '灼傷' }, { id: 'Confused', label: '混亂' }],
      context: {},
    };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const condition = selection[0] as 'Poisoned' | 'Burned' | 'Confused';
    if (opp.active) applyStatusCondition(opp.active, condition);
    return 'done';
  },
};

/** 激動治癒: once per turn, gated on own field having a Grass "超級進化...ex" (Mega ex) anywhere;
 * fully heal — actually heals 60 HP off — 1 chosen own Pokémon. */
const excitedHealing: EffectHandler = {
  start(ctx) {
    const hasGate = allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name.startsWith('超級')
      && c.cardData.subtypes.includes('ex') && (c.cardData.types || []).includes('Grass'));
    if (!hasGate) return 'done';
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '激動治癒：選 1 隻己方寶可夢回復 60 HP', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) target.damage = Math.max(0, target.damage - 60);
    return 'done';
  },
};

/** 勸誘亮光: once per turn, both players draw 1 card each. */
const invitingLight: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 1);
    drawCards(ctx.G, (1 - ctx.playerIndex) as 0 | 1, 1);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 臨場背負: real trigger is "on play from hand onto the Bench" — simplified to a regular
 * once-per-turn triggered ability. Deck search 1 Pokémon Tool card, attach to self, reshuffle. */
const clutchCarry: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Pokémon Tool'));
    if (!self || self.attachedTool || options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '臨場背負：從牌庫選 1 張寶可夢道具卡附於自己身上', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const i = p.deck.findIndex(c => c.id === selection[0]);
    if (self && i >= 0) self.attachedTool = p.deck.splice(i, 1)[0];
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 使壞之尾: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Flip 2 coins; that many random cards from the opponent's
 * hand get shuffled back into their deck (revealed to this player along the way, though the
 * engine has no separate "reveal" state to model — the cards simply move). */
const badTail: EffectHandler = {
  start(ctx) {
    const heads = flipCoins(2).filter(Boolean).length;
    if (heads === 0) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    for (let i = 0; i < heads && opp.hand.length > 0; i++) {
      const idx = Math.floor(Math.random() * opp.hand.length);
      opp.deck.push(opp.hand.splice(idx, 1)[0]);
    }
    shuffleDeck(opp.deck);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 大洋增輝: only while Active, once per turn: heal self 50 HP. */
const oceanGlow: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    p.active.damage = Math.max(0, p.active.damage - 50);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 鱗片律動: once per turn, look at the top 6 deck cards, attach any number of the Basic Energy
 * cards among them to 1 chosen own Dragon-type Pokémon, reshuffle the rest. */
const scaleRhythm: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-6);
    const energyOptions = top.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Dragon'));
    if (energyOptions.length === 0 || targets.length === 0) return 'done';
    return {
      prompt: '鱗片律動：牌庫最上方 6 張中，選任意數量基本能量卡',
      choiceType: 'select_from_list',
      maxCount: energyOptions.length,
      options: energyOptions.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { step: 'pick_energy', seenIds: top.map(c => c.id) },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      const seenIds = context.seenIds as string[];
      const seen: GameCard[] = [];
      for (const id of seenIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
      }
      const notChosen = seen.filter(c => !selection.includes(c.id));
      p.deck.unshift(...notChosen);
      shuffleDeck(p.deck);
      if (selection.length === 0) return 'done';
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Dragon'));
      if (targets.length === 0) return 'done';
      return {
        prompt: '鱗片律動：選擇要附加能量的龍寶可夢',
        choiceType: 'select_pokemon',
        count: 1,
        options: targets.map(t => ({ id: t.id, label: t.cardData.name })),
        context: { step: 'pick_target', energyCards: selection.map(id => seen.find(c => c.id === id)).filter((c): c is GameCard => !!c).map(c => ({ id: c.id, type: c.cardData.types?.[0] || 'Colorless' })) },
      };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
    const energyCards = context.energyCards as { id: string; type: string }[];
    if (target) {
      for (const e of energyCards) target.attachedEnergy.push({ id: e.id, type: e.type as any });
    }
    return 'done';
  },
};

/** 霸者咆哮: real trigger is "on play from hand onto the Bench" — simplified to a regular
 * once-per-turn triggered ability. Look at the top 4 deck cards, attach 1 chosen Basic Energy
 * card among them to self, reshuffle the rest. */
const overlordRoar: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const top = p.deck.slice(-4);
    const energyOptions = top.filter(c => c.cardData.subtypes.includes('Basic Energy'));
    if (energyOptions.length === 0) return 'done';
    return {
      prompt: '霸者咆哮：牌庫最上方 4 張中，選 1 張基本能量卡附於自己身上',
      choiceType: 'select_from_list',
      count: 1,
      options: energyOptions.map(c => ({ id: c.id, label: c.cardData.name })),
      context: { seenIds: top.map(c => c.id) },
    };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const seenIds = context.seenIds as string[];
    const seen: GameCard[] = [];
    for (const id of seenIds) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) seen.push(p.deck.splice(i, 1)[0]);
    }
    const chosen = seen.find(c => c.id === selection[0]);
    const rest = seen.filter(c => c.id !== selection[0]);
    p.deck.unshift(...rest);
    shuffleDeck(p.deck);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (self && chosen) self.attachedEnergy.push({ id: chosen.id, type: chosen.cardData.types?.[0] || 'Colorless' });
    return 'done';
  },
};

/** 鈴鈴吵鬧: once per turn, discard 1 random (blind) card from the opponent's hand. */
const jingleClamor: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.hand.length === 0) return 'done';
    const i = Math.floor(Math.random() * opp.hand.length);
    opp.discardPile.push(opp.hand.splice(i, 1)[0]);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 緊急進化: gated on this Pokémon's remaining HP being <=30; once per turn, search the deck for
 * a named "高傲雉雞" (including its "ex" print) and evolve directly from the deck. */
const emergencyEvolution: EffectHandler = {
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    const hp = parseInt(self.cardData.hp || '0', 10);
    if (hp - self.damage > 30) return 'done';
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.name === '高傲雉雞' || c.cardData.name === '高傲雉雞ex');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '緊急進化：從牌庫選 1 張「高傲雉雞」完成進化', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const deckIdx = p.deck.findIndex(c => c.id === selection[0]);
    if (deckIdx === -1) { shuffleDeck(p.deck); return 'done'; }
    const evolution = p.deck.splice(deckIdx, 1)[0];
    shuffleDeck(p.deck);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) { p.discardPile.push(evolution); return 'done'; }
    const isActive = p.active?.id === self.id;
    const benchIdx = isActive ? -1 : p.bench.findIndex(c => c?.id === self.id);
    if (!isActive && benchIdx === -1) { p.discardPile.push(evolution); return 'done'; }
    evolution.attachedEnergy = self.attachedEnergy;
    evolution.damage = self.damage;
    evolution.attachedTool = self.attachedTool;
    stackAsPreEvolution(evolution, self);
    if (isActive) p.active = evolution; else p.bench[benchIdx] = evolution;
    return 'done';
  },
};

/** 怨影使者: real gate is "played 阿杏的秘招 from hand THIS turn" — approximated as "阿杏的秘招 is
 * in the discard pile" (no same-turn-play tracker exists for arbitrary named cards, same
 * simplification class as 頸傘發電). Once per turn, draw back up to 8 hand size. */
const grudgeShadeEnvoy: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.discardPile.some(c => c.cardData.name === '阿杏的秘招')) return 'done';
    drawUpTo(ctx.G, ctx.playerIndex, 8);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 深海抽出: once per turn, draw 1 card, then optionally put 1 hand card on the bottom of the deck. */
const deepSeaDraw: EffectHandler = {
  start(ctx) {
    drawCards(ctx.G, ctx.playerIndex, 1);
    const p = player(ctx.G, ctx.playerIndex);
    if (p.hand.length === 0) return 'done';
    return { prompt: '深海抽出：若希望，選 1 張手牌放回牌庫下方', choiceType: 'select_from_list', maxCount: 1, options: p.hand.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    if (selection[0]) {
      const p = player(ctx.G, ctx.playerIndex);
      const i = p.hand.findIndex(c => c.id === selection[0]);
      if (i >= 0) p.deck.unshift(p.hand.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 母親的誘引: once per turn, coin flip; on heads, force-switch 1 opponent Benched Pokémon into Active. */
const mothersLure: EffectHandler = {
  start(ctx) {
    if (!flipCoin()) return 'done';
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (!opp.active || benched.length === 0) return 'done';
    return { prompt: '母親的誘引：擲硬幣結果為正面，選 1 隻對手備戰寶可夢換上場', choiceType: 'select_pokemon', count: 1, options: benched.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    }
    return 'done';
  },
};

/** 大飛翅: once per turn, shuffle the opponent's ENTIRE hand into their deck, then they draw 4. */
const grandWingflap: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    opp.deck.push(...opp.hand);
    opp.hand = [];
    shuffleDeck(opp.deck);
    drawCards(ctx.G, (1 - ctx.playerIndex) as 0 | 1, 4);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 沖刷: unlimited use per turn — move 1 attached Water Energy from a Benched Pokémon to the Active. */
const rinseWash: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active) return 'done';
    const sources = p.bench.filter((c): c is GameCard => c !== null && c.attachedEnergy.some(e => e.type === 'Water'));
    if (sources.length === 0) return 'done';
    return { prompt: '沖刷：選 1 隻備戰寶可夢身上的水能量', choiceType: 'select_from_list', count: 1, options: sources.flatMap(c => c.attachedEnergy.filter(e => e.type === 'Water').map(e => ({ id: e.id, label: `${c.cardData.name}：${e.type}` }))), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const source = p.bench.find(c => c?.attachedEnergy.some(e => e.id === selection[0]));
    if (source && p.active) {
      const i = source.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) p.active.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 收集香氣: once per turn, deck search up to 2 Basic Psychic Energy, add to hand, reshuffle. */
const scentGathering: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Psychic'));
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '收集香氣：從牌庫選最多 2 張基本超能量卡加入手牌', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    for (const id of selection) {
      const i = p.deck.findIndex(c => c.id === id);
      if (i >= 0) p.hand.push(p.deck.splice(i, 1)[0]);
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 動人香氣: once per turn, heal all own Pokémon 30 HP each. */
const enchantingScent: EffectHandler = {
  start(ctx) {
    for (const c of allPokemon(ctx.G, ctx.playerIndex)) c.damage = Math.max(0, c.damage - 30);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 收集泡泡: unlimited use per turn — move 1 attached Energy (any type) from any own Pokémon to self. */
const bubbleCollection: EffectHandler = {
  unlimitedUse: true,
  start(ctx) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self) return 'done';
    const sources = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.id !== self.id && c.attachedEnergy.length > 0);
    if (sources.length === 0) return 'done';
    return { prompt: '收集泡泡：選 1 隻己方寶可夢身上的能量', choiceType: 'select_from_list', count: 1, options: sources.flatMap(c => c.attachedEnergy.map(e => ({ id: e.id, label: `${c.cardData.name}：${e.type}` }))), context: {} };
  },
  resume(ctx, _context, selection) {
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    const source = allPokemon(ctx.G, ctx.playerIndex).find(c => c.attachedEnergy.some(e => e.id === selection[0]));
    if (self && source) {
      const i = source.attachedEnergy.findIndex(e => e.id === selection[0]);
      if (i >= 0) self.attachedEnergy.push(source.attachedEnergy.splice(i, 1)[0]);
    }
    return 'done';
  },
};

/** 無力充能: only while Benched, once per turn: from hand, 1 Energy card (any type), attach to
 * the Active Pokémon named "青木的..." */
const powerlessCharge: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || p.active?.id === self.id) return 'done';
    if (!p.active || !p.active.cardData.name.includes('青木的')) return 'done';
    const options = p.hand.filter(c => c.cardData.supertype === 'Energy');
    if (options.length === 0) return 'done';
    return { prompt: '無力充能：選 1 張手牌能量卡附於「青木的寶可夢」身上', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const i = p.hand.findIndex(c => c.id === selection[0]);
    if (i >= 0 && p.active) {
      const energy = p.hand.splice(i, 1)[0];
      p.active.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
    }
    return 'done';
  },
};

/** 勸誘羽: only while Active, once per turn: both players draw 1 card each. */
const invitingFeather: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.active?.id !== ctx.sourceCardId) return 'done';
    drawCards(ctx.G, ctx.playerIndex, 1);
    drawCards(ctx.G, (1 - ctx.playerIndex) as 0 | 1, 1);
    return 'done';
  },
  resume() { return 'done'; },
};

/** 龐克練肌: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Deck search up to 5 Basic Darkness Energy, attach to 1 chosen
 * own named "瑪俐的" Pokémon (simplified to a single target, same as the other "any distribution"
 * abilities in this file), reshuffle. */
const punkMuscleUp: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && (c.cardData.types || []).includes('Darkness'));
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.includes('瑪俐的'));
    if (options.length === 0 || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '龐克練肌：從牌庫選最多 5 張基本惡能量卡', choiceType: 'select_from_list', maxCount: Math.min(5, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) { shuffleDeck(p.deck); return 'done'; }
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.cardData.name.includes('瑪俐的'));
      if (targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return { prompt: '龐克練肌：選擇要附加能量的「瑪俐的寶可夢」', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.deck.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: 'Darkness' });
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** X啟動: once per turn, deck search up to 1 Basic Psychic AND up to 1 Basic Metal Energy,
 * attach (independently) to own Psychic/Metal Pokémon, reshuffle. */
const xActivation: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const options = p.deck.filter(c => c.cardData.subtypes.includes('Basic Energy') && ((c.cardData.types || []).includes('Psychic') || (c.cardData.types || []).includes('Metal')));
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Psychic') || (c.cardData.types || []).includes('Metal'));
    if (options.length === 0 || targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: 'X啟動：從牌庫選最多各 1 張基本超/鋼能量卡', choiceType: 'select_from_list', maxCount: Math.min(2, options.length), options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: { step: 'pick_energy' } };
  },
  resume(ctx, context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (context.step === 'pick_energy') {
      if (selection.length === 0) { shuffleDeck(p.deck); return 'done'; }
      const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => (c.cardData.types || []).includes('Psychic') || (c.cardData.types || []).includes('Metal'));
      if (targets.length === 0) { shuffleDeck(p.deck); return 'done'; }
      return { prompt: 'X啟動：選擇要附加能量的寶可夢', choiceType: 'select_pokemon', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyIds: selection } };
    }
    const target = allPokemon(ctx.G, ctx.playerIndex).find(t => t.id === selection[0]);
    const energyIds = context.energyIds as string[];
    if (target) {
      for (const id of energyIds) {
        const i = p.deck.findIndex(c => c.id === id);
        if (i === -1) continue;
        const energy = p.deck.splice(i, 1)[0];
        target.attachedEnergy.push({ id: energy.id, type: energy.cardData.types?.[0] || 'Colorless' });
      }
    }
    shuffleDeck(p.deck);
    return 'done';
  },
};

/** 恐慌牢籠: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Confuse the opponent's Active. */
const panicCage: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    if (opp.active) applyStatusCondition(opp.active, 'Confused');
    return 'done';
  },
  resume() { return 'done'; },
};

/** 激動衝刺: only while Benched, gated on own field having a "超級進化...ex" (Mega ex) anywhere;
 * once per turn, swap self into Active. */
const excitedDash: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    const self = findOwnPokemon(ctx.G, ctx.playerIndex, ctx.sourceCardId);
    if (!self || !p.active || p.active.id === self.id) return 'done';
    const benchIdx = p.bench.findIndex(c => c?.id === self.id);
    if (benchIdx === -1) return 'done';
    const hasGate = allPokemon(ctx.G, ctx.playerIndex).some(c => c.cardData.name.startsWith('超級') && c.cardData.subtypes.includes('ex'));
    if (!hasGate) return 'done';
    const oldActive = p.active;
    clearStatusConditionsOnLeaveActive(oldActive);
    p.bench[benchIdx] = oldActive;
    p.active = self;
    return 'done';
  },
  resume() { return 'done'; },
};

/** 大力捕捉器: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Force-switch 1 opponent Benched Pokémon into Active. */
const heavyDutyGrabber: EffectHandler = {
  start(ctx) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const benched = opp.bench.filter((c): c is GameCard => c !== null);
    if (!opp.active || benched.length === 0) return 'done';
    return { prompt: '大力捕捉器：選 1 隻對手備戰寶可夢換上場', choiceType: 'select_pokemon', count: 1, options: benched.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const opp = opponent(ctx.G, ctx.playerIndex);
    const idx = opp.bench.findIndex(c => c?.id === selection[0]);
    if (idx >= 0 && opp.active) {
      const chosen = opp.bench[idx]!;
      clearStatusConditionsOnLeaveActive(opp.active);
      opp.bench[idx] = opp.active;
      opp.active = chosen;
    }
    return 'done';
  },
};

/** 潔淨支援: real trigger is "on promoting own named 超級拉帝亞斯ex from Bench to Active" —
 * simplified to a regular once-per-turn triggered ability gated on that exact Pokémon currently
 * being Active (rather than the promotion event itself), same pattern used for other on-X
 * triggers in this file. Move all Energy from 1 chosen own Benched Pokémon to the Active. */
const cleansingSupport: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (!p.active || p.active.cardData.name !== '超級拉帝亞斯ex') return 'done';
    const sources = p.bench.filter((c): c is GameCard => c !== null && c.attachedEnergy.length > 0);
    if (sources.length === 0) return 'done';
    return { prompt: '潔淨支援：選 1 隻備戰寶可夢，將其身上所有能量移到戰鬥寶可夢身上', choiceType: 'select_pokemon', count: 1, options: sources.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    const source = p.bench.find(c => c?.id === selection[0]);
    if (source && p.active) {
      p.active.attachedEnergy.push(...source.attachedEnergy);
      source.attachedEnergy = [];
    }
    return 'done';
  },
};

/** 甜點之禮: once per turn, heal 1 chosen own Pokémon 30 HP. */
const sweetGift: EffectHandler = {
  start(ctx) {
    const targets = allPokemon(ctx.G, ctx.playerIndex).filter(c => c.damage > 0);
    if (targets.length === 0) return 'done';
    return { prompt: '甜點之禮：選 1 隻己方寶可夢回復 30 HP', choiceType: 'select_pokemon', count: 1, options: targets.map(c => ({ id: c.id, label: `${c.cardData.name}（${c.damage} 傷害）` })), context: {} };
  },
  resume(ctx, _context, selection) {
    const target = allPokemon(ctx.G, ctx.playerIndex).find(c => c.id === selection[0]);
    if (target) target.damage = Math.max(0, target.damage - 30);
    return 'done';
  },
};

/** 增長繭: real trigger is "on evolving via this card from hand" — simplified to a regular
 * once-per-turn triggered ability. Deck search 1 named "甲殼繭" or "盾甲繭", place directly on
 * the Bench, reshuffle. */
const cocoonGrowth: EffectHandler = {
  start(ctx) {
    const p = player(ctx.G, ctx.playerIndex);
    if (p.bench.every(s => s !== null)) return 'done';
    const options = p.deck.filter(c => c.cardData.name === '甲殼繭' || c.cardData.name === '盾甲繭');
    if (options.length === 0) { shuffleDeck(p.deck); return 'done'; }
    return { prompt: '增長繭：從牌庫選 1 張「甲殼繭」或「盾甲繭」放置於備戰區', choiceType: 'select_from_list', count: 1, options: options.map(c => ({ id: c.id, label: c.cardData.name })), context: {} };
  },
  resume(ctx, _context, selection) {
    const p = player(ctx.G, ctx.playerIndex);
    if (selection[0]) moveDeckCardToBench(ctx.G, ctx.playerIndex, selection[0]);
    shuffleDeck(p.deck);
    return 'done';
  },
};

export const abilityEffects: Record<string, EffectHandler> = {
  '偵查指令': strategicCommand,
  '咒詛炸彈': curseBomb,
  '腎上腺腦力': adrenalineBrain,
  '交易': trade,
  '集客': customerMagnet,
  '突然削退': suddenSetback,
  '亂咬': wildBite,
  '碧綠之舞': attachEnergyFromHandAbility('碧綠之舞', 'Grass', 1, true),
  '電氣流': attachEnergyFromHandAbility('電氣流', 'Lightning', 1, false),
  '金色火焰': attachEnergyFromHandAbility('金色火焰', 'Fire', 2, false),
  '振翅高飛': wingbeat,
  '閃光抽出': flashDraw,
  // Added for goal: "修正所有寶可夢的特性" coverage expansion (see also passiveAbilities.ts
  // for the field-wide/passive abilities that don't fit this triggered-effect shape).
  '降霜': frostDown,
  '合金建造': alloyBuild,
  '太陽能量': solarEnergy,
  '古代睿智': ancientWisdom,
  '抓取': grab,
  '旅途牽絆': travelBond,
  '衝衝鼓': festivalDrum,
  '洗鍊': trade,
  '迅速游標': rapidCursor,
  '瞬間移動者': teleporter,
  '金屬轉移': metalTransfer,
  '熟成充能': ripenCharge,
  '經驗法則': ruleOfExperience,
  '劇毒粉塵': poisonDust,
  '風扇呼喚': fanCall,
  '森林漫步': forestWalk,

  '快走': quickWalk,
  '電氣發電機': electricGenerator,
  '燒灼蒸汽': scorchingSteam,
  '平靜之光': tranquilLight,
  '必殺手裡劍': finishingShuriken,
  '烈火亂舞': flameDance,
  '搜尋寶石': gemSearch,
  '扭轉乾坤': turnaround,
  '支配鎖鏈': dominationChain,
  '精神抽出': mentalExtraction,
  '奔流之心': torrentHeart,

  '火焰蹈舞': flameStepDance,
  '毛象搬運': mammothCarry,
  '邀請眨眼': invitingWink,
  '飽腹時間': bellyfulTime,
  '金屬製造者': metalMaker,
  '暗中咬住': stealthBite,
  '幸福切換': happinessSwitch,
  '逃跑抽出': escapeDraw,

  '夜間工作': nightWork,
  '發酵果汁': fermentedJuice,
  '熱浪鱗粉': heatWaveScales,
  '曲扭未來': twistedFuture,
  '月光循環': moonlightCycle,
  '原始之翼': primalWing,
  '金屬信號': metalSignal,

  '繁星花紋': starryPattern,
  '柔柔治癒': gentleHealing,
  '充能': charge,
  '四季變換': seasonChange,
  '表演時間': showTime,
  '重步跳躍': heavyStepJump,
  '惡棍衝天': villainRise,
  '天空搬運': skyCarry,
  '沙之羽擊': sandWingbeat,

  '搜尋點心': snackSearch,
  '過度放電': overdischarge,
  '媚惑引誘': enticingLure,
  '狂挖': franticDig,
  '王者呼聲': kingsCall,
  '火箭腦力': rocketBrainpower,
  '尖刺纏身': spikeCling,
  '誘導之尾': luringTail,
  '貪慾點餐': greedyOrder,

  '再構築': reconstruction,
  '殺手鐧捕捉': killerMoveCapture,
  '脫殼': shedShell,
  '沉雪': snowSink,
  '使者衝刺': messengerDash,
  '激動渦輪': excitedTurbine,
  '快節奏': quickTempo,

  '悉心治癒': attentiveHealing,
  '挑戰角擊': challengeHornAttack,
  '拍檔提升': partnerBoost,
  '進化指引': evolutionGuide,
  '全滿旋律': fullMelody,
  '破壞頭錘': wreckingHeadbutt,
  '天空抽出': skyDraw,
  '拍檔呼喚': partnerCall,
  '閃焰魔法': blazeSpell,
  '怨恨進化': grudgeEvolution,
  '金屬之路': metalRoad,
  '穹天狩獵': skyburstHunt,

  '岩石武裝': rockArmament,
  '百花齊放': flowerBloom,
  '能量舞步': energyDance,
  '臨場之錘': timelyHammer,
  '頸傘發電': napeUmbrellaGenerator,
  '微風吹拂': gentleBreeze,
  '蒐證': evidenceGathering,
  '日光轉移': sunlightTransfer,
  '返回重載': returnReload,
  '溫柔鰭': gentleFin,
  '瞄準獵物': targetPrey,
  '飛葉治癒': leafHealing,
  '熱情舞': floralDance,
  '激流旋渦': torrentVortex,
  '任選黏液': pickAnyMucus,
  '激動治癒': excitedHealing,

  '勸誘亮光': invitingLight,
  '臨場背負': clutchCarry,
  '使壞之尾': badTail,
  '大洋增輝': oceanGlow,
  '鱗片律動': scaleRhythm,
  '霸者咆哮': overlordRoar,
  '鈴鈴吵鬧': jingleClamor,
  '緊急進化': emergencyEvolution,
  '怨影使者': grudgeShadeEnvoy,

  '深海抽出': deepSeaDraw,
  '母親的誘引': mothersLure,
  '大飛翅': grandWingflap,
  '沖刷': rinseWash,
  '收集香氣': scentGathering,
  '動人香氣': enchantingScent,
  '收集泡泡': bubbleCollection,
  '無力充能': powerlessCharge,
  '勸誘羽': invitingFeather,
  '龐克練肌': punkMuscleUp,
  'X啟動': xActivation,
  '恐慌牢籠': panicCage,
  '激動衝刺': excitedDash,
  '大力捕捉器': heavyDutyGrabber,
  '潔淨支援': cleansingSupport,
  '甜點之禮': sweetGift,
  '增長繭': cocoonGrowth,
};

export function hasAbilityEffect(name: string): boolean {
  return name in abilityEffects;
}

export function isAbilityUnlimitedUse(name: string): boolean {
  return !!abilityEffects[name]?.unlimitedUse;
}

export function startAbilityEffect(name: string, ctx: EffectContext): EffectStep {
  return abilityEffects[name].start(ctx);
}

export function resumeAbilityEffect(name: string, ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  return abilityEffects[name].resume(ctx, context, selection);
}
