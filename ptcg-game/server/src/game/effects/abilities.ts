import { EnergyType, GameCard } from '@ptcg/shared';
import { EffectContext, EffectHandler, EffectStep, allPokemon, findOwnPokemon, opponent, player } from './types';
import { handleKo } from '../damage';
import { discardFromHand, drawCards, drawUpTo, moveDeckCardToHand, shuffleDeck } from './primitives';

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
      choiceType: 'select_from_list',
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
      choiceType: 'select_from_list',
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
        choiceType: 'select_from_list',
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
    return { prompt: '亂咬：選最多 2 隻對手寶可夢各放置 2 個傷害指示物', choiceType: 'select_from_list', maxCount: Math.min(2, targets.length), options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
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
      if (i >= 0) source.attachedEnergy.splice(i, 1);
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
    self.attachedEnergy = [];
    self.attachedTool = null;
    self.damage = 0;
    self.statusConditions = [];
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
      return { prompt: '電氣發電機：選擇要附加能量的備戰寶可夢', choiceType: 'select_from_list', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
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
    if (opp.active) { opp.active.statusConditions = opp.active.statusConditions.filter(c => !['Asleep', 'Paralyzed', 'Confused'].includes(c)); opp.active.statusConditions.push('Asleep'); }
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
      return { prompt: '必殺手裡劍：選擇要放置 6 個傷害指示物的對手寶可夢', choiceType: 'select_from_list', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target' } };
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
      return { prompt: '烈火亂舞：選擇要附加能量的寶可夢', choiceType: 'select_from_list', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: { step: 'pick_target', energyId: selection[0] } };
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

/** 扭轉乾坤: once per turn, draw 3. (The printed "own Pokémon fainted last opponent-turn" gate can't be checked — same documented simplification as 不公印章 in trainers.ts.) */
const turnaround: EffectHandler = {
  start(ctx) {
    if (player(ctx.G, ctx.playerIndex).deck.length === 0) return 'done';
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
    return { prompt: '支配鎖鏈：選擇要換上場的惡寶可夢', choiceType: 'select_from_list', count: 1, options: targets.map(t => ({ id: t.id, label: t.cardData.name })), context: {} };
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
