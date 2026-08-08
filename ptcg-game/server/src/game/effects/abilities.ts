import { GameCard } from '@ptcg/shared';
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
};

export function hasAbilityEffect(name: string): boolean {
  return name in abilityEffects;
}

export function startAbilityEffect(name: string, ctx: EffectContext): EffectStep {
  return abilityEffects[name].start(ctx);
}

export function resumeAbilityEffect(name: string, ctx: EffectContext, context: Record<string, unknown>, selection: string[]): EffectStep {
  return abilityEffects[name].resume(ctx, context, selection);
}
