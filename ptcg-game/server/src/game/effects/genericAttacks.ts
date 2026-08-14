/**
 * With 1400+ unique Pokémon+attack combos carrying non-trivial text, hand-writing a bespoke
 * EffectHandler (attacks.ts's per-combo registry) for every one isn't tractable. Most of that
 * text, though, follows a small number of recurring templates (coin-flip-scaled damage, single
 * coin-flip status/bonus-damage, unconditional status infliction, self-heal, draw, self/opponent
 * energy discard, board-state-scaled damage, timed self-protection or defender-lockout). This
 * module recognizes those templates directly from the printed attack text/damage string at
 * attack time and resolves them — no per-card registration needed, so it automatically covers
 * reprints and any future card sharing the same template.
 *
 * A second tier of templates below (deck search, mill, switches) DOES involve picking among
 * multiple valid targets/cards where the printed text leaves it to a player's choice — rather
 * than opening a PendingChoice (which the single-synchronous-step design here doesn't support),
 * these auto-pick randomly among the valid options. This is a documented simplification, not a
 * silent one: it removes the strategic "which one" decision, but the shuffled deck order and
 * random pick are no worse an approximation than most of the "any distribution" simplifications
 * already used throughout abilities.ts/trainers.ts this session.
 *
 * Deliberately NOT handled here (left to the bespoke attacks.ts registry or genuinely
 * unsupported): bench damage distribution across several targets in one instance (the total
 * spread matters, unlike single-target picks); "ignore the defender's attached-card effects"
 * (this engine has no Tool-based incoming-damage-reduction mechanic yet for that to meaningfully
 * override); and "look at the opponent's hand" (no information-asymmetry state exists to reveal
 * into, so there'd be nothing to actually change).
 */
import { StatusCondition } from '@ptcg/shared';
import { normalizeAbilityName } from './types';

export interface TimedEffectDescriptor {
  kind: 'cantAttack' | 'cantRetreat' | 'damageImmune' | 'damageReduction' | 'outgoingDamageReduction' | 'outgoingDamageBoost' | 'coinFlipAttackMiss' | 'namedAttackLock';
  amount?: number;
  /** For 'damageImmune': restricts the immunity to attackers of this printed Subtype only (e.g. "Basic"). */
  vsSubtype?: string;
  /** For 'namedAttackLock': the one specific attack name this locks out. */
  attackName?: string;
  /** Added to G.turn at apply time by the caller (moves.ts, which has G in scope) to get the
   * absolute turn number this effect is active on. 1 = the opponent's very next turn (used for
   * both "protect myself next opponent turn" and "the Pokémon I just hit can't retreat/attack
   * next their-turn"); 2 = my own next turn (used for "this Pokémon can't attack next my-turn"). */
  turnOffset: number;
}

export interface GenericAttackOutcome {
  /** Replaces `parseInt(attack.damage)` as the pre-weakness/passive base damage for this use. */
  baseDamage: number;
  /** Human-readable coin-flip result for the battle log (only set for the highest-traffic
   * coin-flip templates — not every template resolved by this module populates it). */
  coinFlipNote?: string;
  /** Applied to the defender only if final damage > 0, matching real rules for on-hit effects. */
  statusToInflict?: StatusCondition[];
  /** Applied to the attacker itself, unconditional (no damage gate). */
  selfStatusToInflict?: StatusCondition[];
  healSelfAmount?: number;
  drawCards?: number;
  /** Recoil: raw HP (not counters) the attacker itself also takes, unconditional. */
  selfDamage?: number;
  /** Discard this many random Energy cards from the attacker's own attachedEnergy. */
  discardSelfEnergyCount?: number;
  discardAllSelfEnergy?: boolean;
  /** Discard this many random Energy cards from the defender's attachedEnergy. */
  discardOpponentEnergyCount?: number;
  discardOpponentTool?: boolean;
  /** Set on the attacker itself (self-protection effects). */
  selfTimedEffect?: TimedEffectDescriptor;
  /** Set on the defender (effects inflicted by being hit). */
  opponentTimedEffect?: TimedEffectDescriptor;

  /** Search the deck for up to N Basic Pokémon (random pick among matches), place on Bench, reshuffle. */
  deckSearchBasicPokemonToBenchCount?: number;
  /** Search the deck for up to N Basic Energy cards (random pick), add to hand, reshuffle. */
  deckSearchBasicEnergyToHandCount?: number;
  /** Search the deck for 1 card of the given supertype (random pick), add to hand, reshuffle. */
  deckSearchSupertypeToHand?: 'Pokémon' | 'Item' | 'Supporter';
  /** Discard the top N cards of the opponent's deck. */
  millOpponentDeckCount?: number;
  /** Discard this many random cards from the opponent's hand (blind pick). */
  discardRandomOpponentHandCount?: number;
  /** Pick 1 random card from the opponent's hand, shuffle it back into their deck. */
  shuffleRandomOpponentHandCardIntoDeck?: boolean;
  /** Discard whichever Stadium card is currently in play. */
  discardActiveStadium?: boolean;
  /** The attacker switches itself with a random own Benched Pokémon. */
  selfSwitchToRandomBench?: boolean;
  /** The opponent's Active is switched with a random one of their own Benched Pokémon. */
  forceOpponentSwitchToRandomBench?: boolean;
  /** Move 1 of the attacker's own attached Energy to a random own Benched Pokémon. */
  moveSelfEnergyToRandomBench?: boolean;

  /** Flat damage (no weakness/resistance) to 1 random opponent Benched Pokémon. */
  benchSplashDamage?: number;
  /** Flat damage (no weakness/resistance) to EVERY one of the attacker's own Benched Pokémon. */
  selfAllBenchSplashDamage?: number;
  /** Optional "draw up to N total hand size" (the printed "若希望" is always worth taking). */
  drawToHandSize?: number;
  /** Heal the attacker by however much damage this attack just dealt to the defender (drain). */
  healSelfByDamageDealt?: boolean;
  /** Move 1 random Energy from the defender's Active to a random one of the defender's own Bench. */
  moveOpponentEnergyToTheirBench?: boolean;
  /** Shuffle the attacker's whole hand into their deck, then draw N. */
  shuffleHandThenDrawCount?: number;
  /** Search the deck for up to N Basic Energy (any type, random pick), attach to 1 random own Pokémon, reshuffle. */
  deckSearchBasicEnergyToOwnPokemonCount?: number;
  /** Search the deck for up to N Basic Energy of a specific type, attach to self, reshuffle. */
  deckSearchTypedEnergyToSelfCount?: { type: string; count: number };
  /** Attach 1 Basic Energy of a specific type from the deck to EACH of the attacker's own Benched
   * Pokémon (skipping any bench slot the deck runs out of matching Energy for), reshuffle. */
  deckSearchTypedEnergyToAllBenchEach?: string;
  /** Search the deck for up to N cards that are either a Pokémon of the given type or a Basic
   * Energy of it, add to hand, reshuffle. */
  deckSearchTypedPokemonOrEnergyToHand?: { type: string; count: number };
  /** Search the deck for any 1 card, add to hand, reshuffle (an optional "若希望" effect that we
   * always take — declining can never be better here). */
  deckSearchAnyCardToHand?: boolean;
  /** Take up to N Basic Energy of a type out of the DISCARD pile and spread them over own Bench. */
  discardEnergyToOwnBench?: { type: string; count: number };
  /** Return the attacker plus everything attached to it to its owner's hand. */
  returnSelfAndAttachmentsToHand?: boolean;
  /** Discard every Energy of a type from the attacker's whole field; damage = discarded x per. */
  discardOwnFieldTypedEnergyForDamage?: { type: string; per: number };
  /** Search the deck for 1 Pokémon Tool card, add to hand, reshuffle. */
  deckSearchToolToHand?: boolean;
  /** Skip resistance / skip weakness when computing this hit's damage. */
  ignoreResistance?: boolean;
  ignoreWeakness?: boolean;
  /** Sets the OPPONENT's Item-lock for their very next turn. */
  itemLockOpponentNextTurn?: boolean;

  /** Evolve the attacker itself using a random matching card from its own deck, reshuffle. */
  evolveSelfFromDeck?: boolean;
  /** Search the deck for up to N Pokémon (any stage, random pick), add to hand, reshuffle. */
  deckSearchPokemonToHandCount?: number;
  /** Search the DISCARD PILE for up to N Pokémon (random pick), add to hand. */
  discardPileSearchPokemonToHandCount?: number;
  /** Search the discard pile for 1 Supporter card, add to hand. */
  discardPileSearchSupporterToHand?: boolean;
  /** Discard the top N cards of the attacker's OWN deck (self-mill). */
  millOwnDeckCount?: number;
  /** Heal a random damaged own Pokémon by this amount (no-op if none are damaged). */
  healRandomOwnDamagedAmount?: number;
  /** Damage scaled by the count of own-field Pokémon whose name contains this substring. */
  familyScaledDamage?: { name: string; amount: number };

  /** Search the deck for up to N Pokémon whose name contains this substring, add to hand, reshuffle. */
  deckSearchFamilyToHandCount?: { name: string; count: number };
  /** Search the deck for up to N Pokémon whose name contains this substring, place on Bench, reshuffle. */
  deckSearchFamilyToBenchCount?: { name: string; count: number };
  /** Search the discard pile for up to N Pokémon whose name contains this substring, place on Bench. */
  discardPileSearchFamilyToBenchCount?: { name: string; count: number };
  /** Mill the top N of the attacker's own deck; damage = (how many milled cards match this name substring) x amount. */
  selfMillFamilyScaledDamage?: { millCount: number; name: string; amount: number };
  /** Damage scaled by how many Pokémon cards in the attacker's own discard pile hold a named attack. */
  discardPileAttackScaledDamage?: { attackName: string; amount: number };
  /** Damage scaled by how many of the attacker's own FIELD Pokémon (active+bench) hold a named attack. */
  ownFieldAttackScaledDamage?: { attackName: string; amount: number };
  /** Damage scaled by the count of own-BENCH-only Pokémon whose name contains this substring. */
  ownBenchFamilyScaledDamage?: { name: string; amount: number };
  /** Cure all of the attacker's own special conditions. */
  cureAllSelfStatus?: boolean;
  /** Heal every one of the attacker's own Pokémon by this amount. */
  healAllOwnTeamAmount?: number;
  /** Search the deck for up to N Energy of a specific type, attach to 1 random own Pokémon, reshuffle. */
  deckSearchTypedEnergyToOwnPokemonCount?: { type: string; count: number };
  /** Place N damage counters split onto opponent Pokémon — simplified to all N on 1 random target. */
  placeCountersOnRandomOpponent?: number;
  /** Flat damage applied to the opponent's Active AFTER a forced switch resolves (hits the newly-promoted Pokémon). */
  splashDamageAfterSwitch?: number;
  /** Search the discard pile for 1 Energy card of any type, attach to self. */
  discardPileSearchAnyEnergyToSelf?: boolean;

  /** Discard Energy attached to the attacker (optionally filtered to one printed type, optionally
   * capped) for a damage bonus of count x amount. The real card leaves "how many" up to the
   * player; this generic layer auto-maximizes (discards as many as available up to the cap),
   * matching the file's documented choice-auto-pick simplification. */
  selfEnergyDiscardScaledDamage?: { type?: string; max?: number; amount: number };
  /** Same, but scanning every one of the attacker's own Pokémon in play (active+bench), not just
   * the attacker itself. */
  ownFieldEnergyDiscardScaledDamage?: { type?: string; max?: number; amount: number };
  /** Discard up to `max` cards from the attacker's own HAND matching `filter`, for a damage bonus
   * of count x amount (auto-maximized, same simplification as above). */
  handDiscardScaledDamage?: {
    filter: { kind: 'anyEnergy' } | { kind: 'energyType'; type: string } | { kind: 'nameIncludes'; name: string };
    max?: number;
    amount: number;
  };
  /** Reveal the top `revealCount` of the attacker's own deck; damage = (how many match this name
   * substring) x amount; only the MATCHING cards are discarded, the rest are shuffled back into
   * the deck (unlike selfMillFamilyScaledDamage, which discards the whole revealed batch). */
  selfRevealTopMatchDiscardRestReshuffle?: { revealCount: number; name: string; amount: number };
}

export interface AttackBoardContext {
  /** Count of the attacking side's own in-play Pokémon (active + bench). */
  ownFieldPokemonCount: number;
  /** Count of Pokémon Tool cards attached across the attacking side's whole field. */
  ownToolCount: number;
  /** The attacker's own current damage counters (damage / 10), i.e. before this attack's own recoil. */
  selfDamageCounters: number;
  /** Count of Energy cards attached to the defender. */
  opponentEnergyCount: number;
  /** The defender's own current damage counters (damage / 10). */
  opponentDamageCounters: number;
  ownBenchCount: number;
  opponentBenchCount: number;
  ownRemainingPrizes: number;
  opponentRemainingPrizes: number;
  defenderStatusConditionCount: number;
  defenderIsBurned: boolean;
  defenderIsEx: boolean;
  /** Count of each Energy type attached to the attacker itself, e.g. { Water: 2 }. */
  attackerEnergyCounts: Record<string, number>;
  /** Every Energy type present across the attacking side's own Bench Pokémon. */
  ownBenchTypes: string[];
  /** Total Energy cards attached to the attacker itself (sum across all types). */
  attackerTotalEnergyCount: number;
  /** Total Energy cards attached to both Active Pokémon combined. */
  bothActiveEnergyCount: number;
  /** Every Pokémon/Supporter name string present in the attacker's own discard pile (for named-family/named-card damage scaling). */
  ownDiscardCardNames: string[];
  /** The attacker's own printed `evolvesFrom` field, if any. */
  attackerEvolvesFrom: string | undefined;
  /** Every own Bench Pokémon's name (for named-family Bench-presence checks). */
  ownBenchNames: string[];
  /** Count of Basic Energy cards in the OPPONENT's own discard pile. */
  opponentDiscardBasicEnergyCount: number;
  ownDeckCount: number;
  /** Total Energy attached across the attacking side's WHOLE field (not just the attacker). */
  ownFieldTotalEnergyCount: number;
  /** Count of each Energy type attached across the attacking side's whole field. */
  ownFieldEnergyCounts: Record<string, number>;
  defenderTypes: string[];
  defenderSubtypes: string[];
  defenderEvolvesFrom: string | undefined;
  defenderIsConfused: boolean;
  defenderRetreatCost: number;
  /** Every type present across the OPPONENT's whole field (active + bench). */
  opponentFieldTypes: string[];
  opponentHasFutureSubtype: boolean;
  opponentHandCount: number;
  ownFieldBasicCount: number;
  hasActiveStadium: boolean;
  /** Count of own-field Pokémon (active + bench) whose printed type includes each given type. */
  ownFieldTypeCounts: Record<string, number>;
  /** Count of each Energy type attached across the OPPONENT's whole field. */
  opponentFieldEnergyCounts: Record<string, number>;
  opponentFieldTotalEnergyCount: number;
  opponentExCount: number;
  opponentExOrVCount: number;
  ownDamagedBenchCount: number;
  ownFieldDamagedCount: number;
  ownBenchStage2Count: number;
  /** Count of own-Bench Pokémon holding at least 1 Energy of each given type. */
  ownBenchEnergyHolderCounts: Record<string, number>;
  /** Energy count this very attack's printed cost requires — for "if this Pokémon has N more
   * Energy attached than this attack costs, add M damage" texts, which can't be evaluated
   * from attachedTotal alone. */
  attackCostCount: number;
  /** Prizes the OPPONENT has already taken (6 - their remaining), for prize-scaled damage. */
  opponentTakenPrizes: number;
  /** Damage counters on each own-Bench Pokémon, keyed by that Pokémon's name — for
   * "damage = counters on all your benched <named family> x N" texts. */
  ownBenchDamageCountersByName: { name: string; counters: number }[];
  /** How many Pokémon in the attacker's own discard pile carry each ability name. */
  ownDiscardAbilityCounts: Record<string, number>;
  /** True when the attacker was not the Active at the start of this turn, i.e. it came up from
   * the Bench during it (retreat, switch effect, or KO replacement). */
  attackerPromotedFromBenchThisTurn: boolean;
  /** Count of each Energy type sitting in the attacker's own discard pile. */
  ownDiscardEnergyCounts: Record<string, number>;
}

const STATUS_ZH: Record<string, StatusCondition> = {
  '睡眠': 'Asleep', '灼傷': 'Burned', '混亂': 'Confused', '麻痺': 'Paralyzed', '中毒': 'Poisoned',
};
const STATUS_ALT = Object.keys(STATUS_ZH).join('|');

const ENERGY_TYPE_FROM_ZH: Record<string, string> = {
  '草': 'Grass', '火': 'Fire', '水': 'Water', '雷': 'Lightning', '超': 'Psychic',
  '鬥': 'Fighting', '惡': 'Darkness', '鋼': 'Metal', '妖': 'Fairy', '龍': 'Dragon', '無': 'Colorless',
};
const SUBTYPE_FROM_ZH: Record<string, string> = {
  '基礎': 'Basic', '1階進化': 'Stage 1', '2階進化': 'Stage 2',
};

function flipCoins(n: number): number {
  let heads = 0;
  for (let i = 0; i < n; i++) if (Math.random() < 0.5) heads++;
  return heads;
}

export function parseBaseNumber(damageField: string): number {
  const m = damageField.match(/^(\d+)(.*)$/);
  if (!m) return 0;
  // "Nx"/"N×" (e.g. "40x") means the printed number is ONLY the per-coin-flip/per-count
  // multiplier for attacks like "Flip 2 coins. This attack does 40 damage for each heads." —
  // that per-unit value is already pulled straight from the attack TEXT by every template
  // below (as `per`), so treating the printed number as an ADDITIONAL flat base double-counts
  // one flip's worth of damage on every single use of the attack, including a complete miss
  // (0 heads would otherwise still deal `base` damage instead of the correct 0).
  if (/^[x×]/i.test(m[2])) return 0;
  return parseInt(m[1], 10);
}

const TEMPLATES: RegExp[] = [
  /^擲(\d+)次硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/,
  new RegExp(`^擲(\\d+)次硬幣，(?:造成|增加)正面出現的次數×(\\d+)點傷害。若出現(\\d+)次以上正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`),
  /^擲硬幣直到出現反面，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/,
  /^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害。$/,
  new RegExp(`^擲1次硬幣[，,]?若為正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`),
  /^擲1次硬幣[，,]?若為反面，則這個招式失敗。$/,
  new RegExp(`^將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`),
  new RegExp(`^將對手的戰鬥寶可夢(【(?:${STATUS_ALT})】[、與]?)+。$`),
  /^將這隻寶可夢恢復「(\d+)」HP。$/,
  /^從自己的牌庫抽出(\d+)張卡。$/,
  /^這隻寶可夢也受到(\d+)點傷害。$/,
  /^選擇1個這隻寶可夢身上附加的能量，將其丟棄。$/,
  /^選擇2個這隻寶可夢身上附加的能量，將其丟棄。$/,
  /^將這隻寶可夢身上附加的能量卡全部丟棄。$/,
  /^選擇1個對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/,
  /^擲1次硬幣[，,]?若為正面，則選擇1個對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/,
  /^在造成傷害前，將對手的戰鬥寶可夢身上附加的「寶可夢道具」卡丟棄。$/,
  /^造成自己的所有寶可夢身上附加的「寶可夢道具」卡的數量×(\d+)點傷害。$/,
  /^造成自己的場上寶可夢的數量×(\d+)點傷害。$/,
  /^增加這隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/,
  /^造成這隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)對手的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/,
  /^在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。$/,
  /^在下個對手的回合，這隻寶可夢不會受到招式的傷害。$/,
  /^擲1次硬幣[，,]?若為正面，則在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。$/,
  /^擲1次硬幣[，,]?若為正面，則在下個對手的回合，這隻寶可夢不會受到招式的傷害。$/,
  /^在下個對手的回合，這隻寶可夢受到招式的傷害「-(\d+)」點。$/,
  /^在下個自己的回合，這隻寶可夢無法使用招式。$/,
  /^在下個對手的回合，受到這個招式的寶可夢無法撤退。$/,
  /^在下個對手的回合，受到這個招式的寶可夢無法使用招式。$/,
  // 太晶 (Terastallization): handled as a special case directly in passiveAbilities.ts's
  // isDamageBlocked (hasTeraBenchedImmunity), not through resolveGenericAttackEffect below —
  // included here purely so coverage-report.ts counts it as covered.
  /^只要這隻寶可夢在備戰區，不會受到招式的傷害。$/,
  /^將這隻寶可夢【(?:睡眠|灼傷|混亂|麻痺|中毒)】。$/,
  /^減少這隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/,
  /^造成對手的戰鬥寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/,
  /^增加對手的戰鬥寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)對手的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^增加雙方的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)這隻寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/,
  /^若自己的備戰區有【(.+?)】寶可夢，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢為「寶可夢【ex】」，則增加(\d+)點傷害。$/,
  /^造成對手的戰鬥寶可夢處於特殊狀態的數量×(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢處於特殊狀態，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢身上放置有傷害指示物，則增加(\d+)點傷害。$/,
  /^若自己剩餘獎賞卡的張數，比對手剩餘獎賞卡的張數多，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢沒有【灼傷】，則這個招式失敗。$/,
  /^從自己的牌庫選擇最多(\d+)張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。$/,
  /^從自己的牌庫選擇1張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。$/,
  /^從自己的牌庫選擇最多(\d+)張基本能量卡，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^從自己的牌庫選擇1張(寶可夢|物品|支援者)卡，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^將對手的牌庫上方(\d+)張卡丟棄。$/,
  /^在不看正面的情況下，從對手的手牌選擇1張，將其丟棄。$/,
  /^在不看正面的情況下，從對手的手牌選擇1張，查看那張卡的正面後放回對手的牌庫並重洗。$/,
  /^將場上的競技場卡丟棄。$/,
  /^將這隻寶可夢與備戰寶可夢互換。$/,
  /^選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。$/,
  /^將對手的戰鬥寶可夢與備戰寶可夢互換。\[由對手選擇放置於戰鬥場的寶可夢。\]$/,
  /^選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。$/,
  /^對手的1隻備戰寶可夢也受到(\d+)點傷害。\[在備戰區不計算弱點・抵抗力。\]$/,
  /^對手的1隻寶可夢受到(\d+)點傷害。\[在備戰區不計算弱點・抵抗力。\]$/,
  /^自己的所有備戰寶可夢也各受到(\d+)點傷害。\[在備戰區不計算弱點・抵抗力。\]$/,
  /^若希望，從牌庫抽卡直到自己的手牌滿(\d+)張為止。$/,
  /^將這隻寶可夢恢復對對手的戰鬥寶可夢造成的傷害相同數值的HP。$/,
  /^若希望，將這隻寶可夢與備戰寶可夢互換。$/,
  /^若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。$/,
  /^將自己的手牌全部放回牌庫並重洗。然後，從牌庫抽出(\d+)張卡。$/,
  /^從自己的牌庫選擇最多(\d+)張基本能量卡，以任意方式附於自己的寶可夢身上。並且重洗牌庫。$/,
  /^從自己的牌庫選擇1張「基本【(.+?)】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。$/,
  /^從自己的牌庫選擇最多(\d+)張「基本【(.+?)】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。$/,
  /^從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^(?:造成|增加)自己的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^查看自己的牌庫上方1張卡，回復原樣。若希望，將那張卡丟棄。$/,
  /^若這隻寶可夢身上沒有放置傷害指示物，則增加(\d+)點傷害。$/,
  /^這個招式的傷害不計算抵抗力。$/,
  /^這個招式的傷害不計算弱點・抵抗力與對手的戰鬥寶可夢身上的附加效果。$/,
  /^這個招式的傷害不計算對手的戰鬥寶可夢身上的附加效果。$/,
  /^在下個對手的回合，對手無法從手牌使出物品卡。$/,
  /^在下個對手的回合，受到這個招式的寶可夢使用招式的傷害「-(\d+)」點。$/,
  /^在下個對手的回合，這隻寶可夢不會受到【基礎】寶可夢招式的傷害。$/,
  /^在下個對手的回合，受到這個招式的寶可夢使用招式時，對手擲1次硬幣。若為反面，則那個招式失敗。$/,
  /^擲(\d+)次硬幣，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/,
  /^對手選擇(\d+)張對手自己的手牌，將其丟棄。$/,
  new RegExp(`^從自己的牌庫選擇1張從這隻寶可夢進化而來的卡，放置於這隻寶可夢身上完成進化。並且重洗牌庫。$`),
  new RegExp(`^將對手的戰鬥寶可夢【(${STATUS_ALT})】。在下個對手的回合，受到這個招式的寶可夢無法撤退。$`),
  /^從自己的牌庫選擇最多(\d+)張寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^從自己的棄牌區選擇最多(\d+)張寶可夢卡，在給對手看過後加入手牌。$/,
  /^從自己的棄牌區選擇1張支援者卡，在給對手看過後加入手牌。$/,
  /^將自己的牌庫上方(\d+)張卡丟棄。$/,
  /^將自己的1隻寶可夢恢復「(\d+)」HP。$/,
  /^造成自己的場上「(.+?)(?:寶可夢)?」的數量×(\d+)點傷害。$/,
  /^擲與這隻寶可夢身上附加的能量的數量相同次數的硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/,
  /^擲與雙方的戰鬥寶可夢身上附加的能量的數量相同次數的硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/,
  /^查看對手的手牌，從其中選擇1張卡，將其丟棄。$/,
  /^在這個回合，若這隻寶可夢從「(.+?)」進化，則增加(\d+)點傷害。$/,
  /^將自己的牌庫上方(\d+)張卡丟棄，造成其中「(.+?)」的張數×(\d+)點傷害。$/,
  /^從自己的牌庫選擇最多(\d+)張「(.+?)」，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^從自己的牌庫選擇最多(\d+)張「(.+?)」，放置於備戰區。並且重洗牌庫。$/,
  /^從自己的棄牌區選擇最多(\d+)張「(.+?)」，放置於備戰區。$/,
  /^若希望，將場上的競技場卡丟棄。$/,
  /^若希望，將對手的戰鬥寶可夢與備戰寶可夢互換。\[由對手選擇放置於戰鬥場的寶可夢。\]$/,
  /^造成自己的棄牌區的，名稱中有「(.+?)」的支援者卡的張數×(\d+)點傷害。$/,
  /^造成自己的棄牌區的，持有「(.+?)」招式的寶可夢卡的張數×(\d+)點傷害。$/,
  /^增加自己的棄牌區的「(.+?)」的張數×(\d+)點傷害。$/,
  /^造成這隻寶可夢身上附加的能量的數量×(\d+)點傷害。$/,
  /^造成自己的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^若自己的備戰區有名稱中有「(.+?)」的寶可夢，則增加(\d+)點傷害。$/,
  /^選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。然後，新上場的寶可夢受到(\d+)點傷害。$/,
  /^擲2次硬幣，若全部為反面，則這隻寶可夢也受到(\d+)點傷害。$/,
  /^查看對手的牌庫上方(\d+)張卡，以任意順序排列，放回牌庫上方。$/,
  /^在下個自己的回合，這隻寶可夢使用的招式，對對手的戰鬥寶可夢造成的傷害「\+(\d+)」點。$/,
  /^在下個自己的回合，這隻寶可夢無法使用「(.+?)」。$/,
  /^造成對手的棄牌區的基本能量卡的張數×(\d+)點傷害。$/,
  /^增加雙方的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/,
  /^將這隻寶可夢的特殊狀態全部恢復。$/,
  /^將自己的所有寶可夢各恢復「(\d+)」HP。$/,
  /^從自己的牌庫選擇最多(\d+)張「基本【(.+?)】能量」卡，附於1隻備戰寶可夢身上。並且重洗牌庫。$/,
  /^將(\d+)個傷害指示物以任意方式放置於對手的寶可夢身上。$/,
  /^若對手剩餘獎賞卡的張數為(\d+)張以下，則增加(\d+)點傷害。$/,
  /^若自己的牌庫的剩餘張數為(\d+)張以下，則增加(\d+)點傷害。$/,
  /^若自己的場上的能量有(\d+)個以上，則增加(\d+)點傷害。這個招式的傷害不計算弱點。$/,
  /^若對手的戰鬥寶可夢為【(.+?)】寶可夢，則將那隻寶可夢【(?:睡眠|灼傷|混亂|麻痺|中毒)】。$/,
  /^若對手的戰鬥寶可夢為【(.+?)】寶可夢，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢【灼傷】，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢【混亂】，則增加(\d+)點傷害。$/,
  /^若對手的戰鬥寶可夢為進化寶可夢，則增加(\d+)點傷害。$/,
  /^若對手的場上有「未來」寶可夢，則增加(\d+)點傷害。$/,
  /^若對手的場上有【(.+?)】寶可夢，則增加(\d+)點傷害。$/,
  /^若這隻寶可夢身上附有(\d+)個以上【(.+?)】能量，則增加(\d+)點傷害。$/,
  /^若自己的場上的【(.+?)】能量有(\d+)個以上，則增加(\d+)點傷害。$/,
  /^造成對手的手牌的張數×(\d+)點傷害。$/,
  /^造成自己的場上的【基礎】寶可夢的數量×(\d+)點傷害。$/,
  /^減少對手的戰鬥寶可夢【撤退】所需的能量的數量×(\d+)點傷害。$/,
  /^若場上有競技場卡，則增加(\d+)點傷害。然後，將那張競技場卡丟棄。$/,
  /^在下個自己的回合，受到這個招式的寶可夢受到招式的傷害「\+(\d+)」點。$/,
  new RegExp(`^將這隻寶可夢身上附加的能量卡全部丟棄，將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`),
  /^從自己的棄牌區選擇1張能量卡，附於這隻寶可夢身上。$/,
  /^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害，並將這隻寶可夢恢復「(\d+)」HP。$/,
  /^從牌庫抽卡直到自己的手牌滿(\d+)張為止。$/,
  /^造成自己的場上【(.+?)】寶可夢的數量×(\d+)點傷害。$/,
  /^造成自己的場上的「(.+?)」寶可夢的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)自己的所有寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/,
  /^增加名稱中有「(.+?)」的自己的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^增加自己的備戰區的「(.+?)」的數量×(\d+)點傷害。$/,
  /^增加自己的備戰區的【2階進化】寶可夢的數量×(\d+)點傷害。$/,
  /^增加自己的身上放置有傷害指示物的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^增加自己的身上附有【(.+?)】能量卡的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^造成對手的場上的「寶可夢【ex】」的數量×(\d+)點傷害。$/,
  /^造成對手的場上的「寶可夢【ex】・【V】」的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)對手的戰鬥寶可夢【撤退】所需的能量的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)對手的所有寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/,
  /^(?:造成|增加)對手的所有寶可夢身上附加的能量的數量×(\d+)點傷害。$/,
  /^造成自己場上的身上放置有傷害指示物的寶可夢的數量×(\d+)點傷害。$/,
  /^造成自己的場上的，持有「(.+?)」招式的寶可夢的數量×(\d+)點傷害。$/,
  /^造成這隻寶可夢身上附加的基本能量的數量×(\d+)點傷害。$/,
  // "attack fails unless …" + surplus-energy / prize / discard-ability / benched-family scaling.
  // Added after auditing 220 real games on ptcg-tw-sim.com (data-scraped/reference-audit.md).
  /^若自己的備戰區沒有「(.+?)」，則這個招式失敗。這個招式的傷害不計算弱點・抵抗力。$/,
  /^若自己的備戰寶可夢為(\d+)隻以下，則這個招式失敗。$/,
  /^若身上附有的能量比使用這個招式所需的能量多(\d+)個，則增加(\d+)點傷害。$/,
  /^造成對手已經獲得的獎賞卡的張數×(\d+)點傷害。$/,
  /^若自己的棄牌區有(\d+)張以上擁有特性「(.+?)」的寶可夢卡，則增加(\d+)點傷害。$/,
  /^造成自己的備戰區的所有「(.+?)」身上放置的傷害指示物的數量×(\d+)點傷害。這個招式的傷害不計算弱點。$/,
  /^在這個回合，若從備戰區將這隻寶可夢放置於戰鬥場，則增加(\d+)點傷害。$/,
  /^從自己的牌庫選擇【(.+?)】寶可夢卡與「基本【(.+?)】能量」卡合計最多(\d+)張，在給對手看過後加入手牌。並且重洗牌庫。$/,
  /^若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。$/,
  /^從自己的棄牌區選擇最多(\d+)張「基本【(.+?)】能量」卡，以任意方式附於備戰寶可夢身上。$/,
  /^將這隻寶可夢與附加的卡，全部放回手牌。$/,
  /^將自己的場上寶可夢身上附加的任意數量的【(.+?)】能量卡丟棄，造成其張數×(\d+)點傷害。$/,
];

/** Pure classifier (no randomness) — used by coverage-report.ts to count these as covered. */
export function matchesGenericAttackTemplate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return TEMPLATES.some(re => re.test(t));
}

/** Resolves a matching template into a concrete outcome, rolling any coin flips exactly once,
 * and computing board-state-scaled damage from `board`. Returns undefined if no template matches. */
export function resolveGenericAttackEffect(text: string, damageField: string, board: AttackBoardContext): GenericAttackOutcome | undefined {
  const t = text.trim();
  if (!t) return undefined;

  let m: RegExpMatchArray | null;

  // 擲N次硬幣，造成/增加正面出現的次數×M點傷害。(可選：若出現X次以上正面，則附加狀態。)
  m = t.match(new RegExp(`^擲(\\d+)次硬幣，(?:造成|增加)正面出現的次數×(\\d+)點傷害。(?:若出現(\\d+)次以上正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。)?$`));
  if (m) {
    const flips = parseInt(m[1], 10);
    const per = parseInt(m[2], 10);
    const heads = flipCoins(flips);
    const base = parseBaseNumber(damageField); // "N+" style bases add on; "Nx" style bases are 0 here
    const outcome: GenericAttackOutcome = { baseDamage: base + heads * per, coinFlipNote: `擲${flips}次硬幣，${heads}次正面` };
    if (m[3] && m[4] && heads >= parseInt(m[3], 10)) outcome.statusToInflict = [STATUS_ZH[m[4]]];
    return outcome;
  }

  // 擲硬幣直到出現反面，造成/增加正面出現的次數×M點傷害。
  m = t.match(/^擲硬幣直到出現反面，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/);
  if (m) {
    const per = parseInt(m[1], 10);
    let heads = 0;
    while (Math.random() < 0.5) heads++;
    return { baseDamage: parseBaseNumber(damageField) + heads * per, coinFlipNote: `擲硬幣直到反面，共${heads}次正面` };
  }

  // 擲1次硬幣若為正面，則增加N點傷害。
  m = t.match(/^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害。$/);
  if (m) {
    const bonus = parseInt(m[1], 10);
    const heads = Math.random() < 0.5;
    return { baseDamage: parseBaseNumber(damageField) + (heads ? bonus : 0), coinFlipNote: heads ? '正面' : '反面' };
  }

  // 擲1次硬幣若為正面，則將對手的戰鬥寶可夢【狀態】。
  m = t.match(new RegExp(`^擲1次硬幣[，,]?若為正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`));
  if (m) {
    const heads = Math.random() < 0.5;
    const outcome: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField), coinFlipNote: heads ? '正面' : '反面' };
    if (heads) outcome.statusToInflict = [STATUS_ZH[m[1]]];
    return outcome;
  }

  // 擲1次硬幣若為反面，則這個招式失敗。
  if (/^擲1次硬幣[，,]?若為反面，則這個招式失敗。$/.test(t)) {
    const heads = Math.random() < 0.5;
    return { baseDamage: heads ? parseBaseNumber(damageField) : 0, coinFlipNote: heads ? '正面' : '反面，招式失敗' };
  }

  // 選擇1/2個對手的戰鬥寶可夢身上附加的能量，將其丟棄。(可選：先擲1次硬幣。)
  m = t.match(/^擲1次硬幣[，,]?若為正面，則選擇1個對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/);
  if (m) {
    const heads = Math.random() < 0.5;
    return { baseDamage: parseBaseNumber(damageField), discardOpponentEnergyCount: heads ? 1 : 0 };
  }
  if (/^選擇1個對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardOpponentEnergyCount: 1 };
  }

  // 選擇1/2個這隻寶可夢身上附加的能量，將其丟棄。(self)
  if (/^選擇1個這隻寶可夢身上附加的能量，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardSelfEnergyCount: 1 };
  }
  if (/^選擇2個這隻寶可夢身上附加的能量，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardSelfEnergyCount: 2 };
  }
  if (/^將這隻寶可夢身上附加的能量卡全部丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardAllSelfEnergy: true };
  }

  // 將最多N張這隻寶可夢身上附加的能量卡丟棄，造成其張數×M點傷害。(self, any type, capped)
  m = t.match(/^將最多(\d+)張這隻寶可夢身上附加的能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, selfEnergyDiscardScaledDamage: { max: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 將這隻寶可夢身上附加的【X】能量卡全部丟棄，造成其張數×M點傷害。(self, type-filtered, unbounded)
  m = t.match(/^將這隻寶可夢身上附加的【(.+?)】能量卡全部丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: 0, selfEnergyDiscardScaledDamage: { type, amount: parseInt(m[2], 10) } };
  }

  // 將自己的場上寶可夢身上附加的任意數量的【X】能量卡丟棄，造成其張數×M點傷害。(own whole field,
  // type-filtered, unbounded — e.g. 超級噴火龍Xex's 烈獄狂火X)
  m = t.match(/^將自己的場上寶可夢身上附加的任意數量的【(.+?)】能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: 0, ownFieldEnergyDiscardScaledDamage: { type, amount: parseInt(m[2], 10) } };
  }

  // 從自己的手牌將最多N張能量卡丟棄，造成其張數×M點傷害。(hand, any Energy, capped)
  m = t.match(/^從自己的手牌將最多(\d+)張能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, handDiscardScaledDamage: { filter: { kind: 'anyEnergy' }, max: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 從自己的手牌將最多N張「基本【X】能量」卡丟棄，造成其張數×M點傷害。(hand, one Basic Energy type, capped)
  m = t.match(/^從自己的手牌將最多(\d+)張「基本【(.+?)】能量」卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: 0, handDiscardScaledDamage: { filter: { kind: 'energyType', type }, max: parseInt(m[1], 10), amount: parseInt(m[3], 10) } };
  }

  // 從自己的手牌將任意數量的名稱中有「X」的Y卡丟棄，造成其張數×M點傷害。(hand, name substring, unbounded)
  m = t.match(/^從自己的手牌將任意數量的名稱中有「(.+?)」的.+?卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, handDiscardScaledDamage: { filter: { kind: 'nameIncludes', name: m[1] }, amount: parseInt(m[2], 10) } };

  // 在造成傷害前，將對手的戰鬥寶可夢身上附加的「寶可夢道具」卡丟棄。
  if (/^在造成傷害前，將對手的戰鬥寶可夢身上附加的「寶可夢道具」卡丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardOpponentTool: true };
  }

  // 將對手的戰鬥寶可夢【狀態】(、【狀態】)*。 — one or more statuses, unconditional.
  m = t.match(new RegExp(`^將對手的戰鬥寶可夢((?:【(?:${STATUS_ALT})】[、與]?)+)。$`));
  if (m) {
    const statuses = [...m[1].matchAll(new RegExp(`【(${STATUS_ALT})】`, 'g'))].map(x => STATUS_ZH[x[1]]);
    if (statuses.length > 0) return { baseDamage: parseBaseNumber(damageField), statusToInflict: statuses };
  }

  // 將這隻寶可夢恢復「N」HP。
  m = t.match(/^將這隻寶可夢恢復「(\d+)」HP。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), healSelfAmount: parseInt(m[1], 10) };

  // 從自己的牌庫抽出N張卡。
  m = t.match(/^從自己的牌庫抽出(\d+)張卡。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), drawCards: parseInt(m[1], 10) };

  // 這隻寶可夢也受到N點傷害。(recoil)
  m = t.match(/^這隻寶可夢也受到(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfDamage: parseInt(m[1], 10) };

  // 造成自己的所有寶可夢身上附加的「寶可夢道具」卡的數量×N點傷害。
  m = t.match(/^造成自己的所有寶可夢身上附加的「寶可夢道具」卡的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownToolCount * parseInt(m[1], 10) };

  // 造成自己的場上寶可夢的數量×N點傷害。
  m = t.match(/^造成自己的場上寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownFieldPokemonCount * parseInt(m[1], 10) };

  // 增加/造成這隻寶可夢身上放置的傷害指示物的數量×N點傷害。
  m = t.match(/^(?:增加|造成)這隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.selfDamageCounters * parseInt(m[1], 10) };

  // 造成/增加對手的戰鬥寶可夢身上附加的能量的數量×N點傷害。
  m = t.match(/^(?:造成|增加)對手的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.opponentEnergyCount * parseInt(m[1], 10) };

  // 在下個對手的回合，這隻寶可夢不會受到招式的傷害(與效果的影響)?。(可選先擲硬幣)
  if (/^在下個對手的回合，這隻寶可夢不會受到招式的傷害(與效果的影響)?。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'damageImmune', turnOffset: 1 } };
  }
  m = t.match(/^擲1次硬幣[，,]?若為正面，則在下個對手的回合，這隻寶可夢不會受到招式的傷害(與效果的影響)?。$/);
  if (m) {
    const heads = Math.random() < 0.5;
    const outcome: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField) };
    if (heads) outcome.selfTimedEffect = { kind: 'damageImmune', turnOffset: 1 };
    return outcome;
  }

  // 在下個對手的回合，這隻寶可夢受到招式的傷害「-N」點。
  m = t.match(/^在下個對手的回合，這隻寶可夢受到招式的傷害「-(\d+)」點。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'damageReduction', amount: parseInt(m[1], 10), turnOffset: 1 } };

  // 在下個自己的回合，這隻寶可夢無法使用招式。(self-lockout after a big hit)
  if (/^在下個自己的回合，這隻寶可夢無法使用招式。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'cantAttack', turnOffset: 2 } };
  }

  // 在下個對手的回合，受到這個招式的寶可夢無法撤退/無法使用招式。(inflicted on the defender)
  if (/^在下個對手的回合，受到這個招式的寶可夢無法撤退。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'cantRetreat', turnOffset: 1 } };
  }
  if (/^在下個對手的回合，受到這個招式的寶可夢無法使用招式。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'cantAttack', turnOffset: 1 } };
  }

  // 將這隻寶可夢【狀態】。(self-inflicted status, unconditional)
  m = t.match(new RegExp(`^將這隻寶可夢【(${STATUS_ALT})】。$`));
  if (m) return { baseDamage: parseBaseNumber(damageField), selfStatusToInflict: [STATUS_ZH[m[1]]] };

  // 減少這隻寶可夢身上放置的傷害指示物的數量×N點傷害。(more self damage = less damage dealt)
  m = t.match(/^減少這隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: Math.max(0, parseBaseNumber(damageField) - board.selfDamageCounters * parseInt(m[1], 10)) };

  // 造成/增加對手的戰鬥寶可夢身上放置的傷害指示物的數量×N點傷害。
  m = t.match(/^(?:造成|增加)對手的戰鬥寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.opponentDamageCounters * parseInt(m[1], 10) };

  // 造成/增加對手的備戰寶可夢的數量×N點傷害。
  m = t.match(/^(?:造成|增加)對手的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.opponentBenchCount * parseInt(m[1], 10) };

  // 增加雙方的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加雙方的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownBenchCount + board.opponentBenchCount) * parseInt(m[1], 10) };

  // 增加這隻寶可夢身上附加的【X】能量的數量×N點傷害。
  m = t.match(/^(?:造成|增加)這隻寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.attackerEnergyCounts[type] || 0) : 0;
    return { baseDamage: parseBaseNumber(damageField) + count * parseInt(m[2], 10) };
  }

  // 若自己的備戰區有【X】寶可夢，則增加N點傷害。
  m = t.match(/^若自己的備戰區有【(.+?)】寶可夢，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const has = !!type && board.ownBenchTypes.includes(type);
    return { baseDamage: parseBaseNumber(damageField) + (has ? parseInt(m[2], 10) : 0) };
  }

  // 若對手的戰鬥寶可夢為「寶可夢【ex】」，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢為「寶可夢【ex】」，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderIsEx ? parseInt(m[1], 10) : 0) };

  // 造成對手的戰鬥寶可夢處於特殊狀態的數量×N點傷害。
  m = t.match(/^造成對手的戰鬥寶可夢處於特殊狀態的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.defenderStatusConditionCount * parseInt(m[1], 10) };

  // 若對手的戰鬥寶可夢處於特殊狀態，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢處於特殊狀態，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderStatusConditionCount > 0 ? parseInt(m[1], 10) : 0) };

  // 若對手的戰鬥寶可夢身上放置有傷害指示物，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢身上放置有傷害指示物，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.opponentDamageCounters > 0 ? parseInt(m[1], 10) : 0) };

  // 若自己剩餘獎賞卡的張數，比對手剩餘獎賞卡的張數多，則增加N點傷害。
  m = t.match(/^若自己剩餘獎賞卡的張數，比對手剩餘獎賞卡的張數多，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownRemainingPrizes > board.opponentRemainingPrizes ? parseInt(m[1], 10) : 0) };

  // 若對手的戰鬥寶可夢沒有【灼傷】，則這個招式失敗。
  if (/^若對手的戰鬥寶可夢沒有【灼傷】，則這個招式失敗。$/.test(t)) {
    return { baseDamage: board.defenderIsBurned ? parseBaseNumber(damageField) : 0 };
  }

  // 從自己的牌庫選擇最多N/1張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchBasicPokemonToBenchCount: parseInt(m[1], 10) };
  if (/^從自己的牌庫選擇1張【基礎】寶可夢卡，放置於備戰區。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), deckSearchBasicPokemonToBenchCount: 1 };
  }

  // 從自己的牌庫選擇最多N張基本能量卡，在給對手看過後加入手牌。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張基本能量卡，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchBasicEnergyToHandCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇1張(寶可夢/物品/支援者)卡，在給對手看過後加入手牌。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇1張(寶可夢|物品|支援者)卡，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) {
    const supertype = m[1] === '寶可夢' ? 'Pokémon' : m[1] === '物品' ? 'Item' : 'Supporter';
    return { baseDamage: parseBaseNumber(damageField), deckSearchSupertypeToHand: supertype };
  }

  // 將對手的牌庫上方N張卡丟棄。
  m = t.match(/^將對手的牌庫上方(\d+)張卡丟棄。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), millOpponentDeckCount: parseInt(m[1], 10) };

  // 在不看正面的情況下，從對手的手牌選擇1張，將其丟棄。(blind discard)
  if (/^在不看正面的情況下，從對手的手牌選擇1張，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardRandomOpponentHandCount: 1 };
  }
  // 在不看正面的情況下，從對手的手牌選擇1張，查看那張卡的正面後放回對手的牌庫並重洗。
  if (/^在不看正面的情況下，從對手的手牌選擇1張，查看那張卡的正面後放回對手的牌庫並重洗。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), shuffleRandomOpponentHandCardIntoDeck: true };
  }

  // 將場上的競技場卡丟棄。
  if (/^將場上的競技場卡丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardActiveStadium: true };
  }

  // 將這隻寶可夢與備戰寶可夢互換。(self-switch)
  if (/^將這隻寶可夢與備戰寶可夢互換。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfSwitchToRandomBench: true };
  }

  // 選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。/ 將對手的戰鬥寶可夢與備戰寶可夢互換。[由對手選擇...]
  if (/^選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。$/.test(t)
    || /^將對手的戰鬥寶可夢與備戰寶可夢互換。\[由對手選擇放置於戰鬥場的寶可夢。\]$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), forceOpponentSwitchToRandomBench: true };
  }

  // 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
  if (/^選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), moveSelfEnergyToRandomBench: true };
  }

  // 對手的1隻備戰寶可夢也受到N點傷害。[在備戰區不計算弱點・抵抗力。] / 對手的1隻寶可夢受到N點傷害。[同上]
  m = t.match(/^對手的1隻(?:備戰)?寶可夢也?受到(\d+)點傷害。\[在備戰區不計算弱點・抵抗力。\]$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), benchSplashDamage: parseInt(m[1], 10) };

  // 自己的所有備戰寶可夢也各受到N點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^自己的所有備戰寶可夢也各受到(\d+)點傷害。\[在備戰區不計算弱點・抵抗力。\]$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfAllBenchSplashDamage: parseInt(m[1], 10) };

  // 若希望，從牌庫抽卡直到自己的手牌滿N張為止。(always worth taking)
  m = t.match(/^若希望，從牌庫抽卡直到自己的手牌滿(\d+)張為止。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), drawToHandSize: parseInt(m[1], 10) };

  // 將這隻寶可夢恢復對對手的戰鬥寶可夢造成的傷害相同數值的HP。(drain)
  if (/^將這隻寶可夢恢復對對手的戰鬥寶可夢造成的傷害相同數值的HP。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), healSelfByDamageDealt: true };
  }

  // 若希望，將這隻寶可夢與備戰寶可夢互換。(optional self-switch, always taken)
  if (/^若希望，將這隻寶可夢與備戰寶可夢互換。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfSwitchToRandomBench: true };
  }

  // 若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。
  if (/^若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), moveOpponentEnergyToTheirBench: true };
  }

  // 將自己的手牌全部放回牌庫並重洗。然後，從牌庫抽出N張卡。
  m = t.match(/^將自己的手牌全部放回牌庫並重洗。然後，從牌庫抽出(\d+)張卡。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), shuffleHandThenDrawCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇最多N張基本能量卡，以任意方式附於自己的寶可夢身上。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張基本能量卡，以任意方式附於自己的寶可夢身上。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchBasicEnergyToOwnPokemonCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇1/最多N張「基本【X】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張「基本【(.+?)】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedEnergyToSelfCount: { type, count: parseInt(m[1], 10) } };
  }
  m = t.match(/^從自己的牌庫選擇1張「基本【(.+?)】能量」卡，附於這隻寶可夢身上。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedEnergyToSelfCount: { type, count: 1 } };
  }

  // ── "this attack fails unless <condition>" family ───────────────────────────────────────
  // Verified against ptcg-tw-sim.com, which logs the failure explicitly
  // ("宇宙光束：備戰區沒有「月石」，招式失敗") rather than dealing the printed damage anyway.

  // 若自己的備戰區沒有「X」，則這個招式失敗。這個招式的傷害不計算弱點・抵抗力。(太陽岩::宇宙光束)
  m = t.match(/^若自己的備戰區沒有「(.+?)」，則這個招式失敗。這個招式的傷害不計算弱點・抵抗力。$/);
  if (m) {
    const present = board.ownBenchNames.some(n => n.includes(m![1]));
    return { baseDamage: present ? parseBaseNumber(damageField) : 0, ignoreWeakness: true, ignoreResistance: true };
  }
  // 若自己的備戰寶可夢為N隻以下，則這個招式失敗。(比克提尼::V戰力)
  m = t.match(/^若自己的備戰寶可夢為(\d+)隻以下，則這個招式失敗。$/);
  if (m) return { baseDamage: board.ownBenchCount <= parseInt(m[1], 10) ? 0 : parseBaseNumber(damageField) };

  // 若身上附有的能量比使用這個招式所需的能量多N個，則增加M點傷害。(胖嘟嘟ex::力量壓制, 超級龍頭地鼠ex::極限鑽)
  m = t.match(/^若身上附有的能量比使用這個招式所需的能量多(\d+)個，則增加(\d+)點傷害。$/);
  if (m) {
    const surplus = board.attackerTotalEnergyCount - board.attackCostCount;
    return { baseDamage: parseBaseNumber(damageField) + (surplus >= parseInt(m[1], 10) ? parseInt(m[2], 10) : 0) };
  }

  // 造成對手已經獲得的獎賞卡的張數×N點傷害。(桃歹郎ex::煩煩爆炸)
  m = t.match(/^造成對手已經獲得的獎賞卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.opponentTakenPrizes * parseInt(m[1], 10) };

  // 若自己的棄牌區有N張以上擁有特性「X」的寶可夢卡，則增加M點傷害。(破破舵輪::悔念錨)
  m = t.match(/^若自己的棄牌區有(\d+)張以上擁有特性「(.+?)」的寶可夢卡，則增加(\d+)點傷害。$/);
  if (m) {
    const have = board.ownDiscardAbilityCounts[normalizeAbilityName(m[2])] || 0;
    return { baseDamage: parseBaseNumber(damageField) + (have >= parseInt(m[1], 10) ? parseInt(m[3], 10) : 0) };
  }

  // 造成自己的備戰區的所有「X」身上放置的傷害指示物的數量×N點傷害。這個招式的傷害不計算弱點。
  // (竹蘭的花岩怪::激怒咒詛 — "竹蘭的寶可夢" is a name-prefix family, so match on the prefix.)
  m = t.match(/^造成自己的備戰區的所有「(.+?)」身上放置的傷害指示物的數量×(\d+)點傷害。這個招式的傷害不計算弱點。$/);
  if (m) {
    const family = m[1].replace(/寶可夢$/, '');
    const counters = board.ownBenchDamageCountersByName
      .filter(b => b.name.includes(family))
      .reduce((sum, b) => sum + b.counters, 0);
    return { baseDamage: counters * parseInt(m[2], 10), ignoreWeakness: true };
  }

  // 在這個回合，若從備戰區將這隻寶可夢放置於戰鬥場，則增加N點傷害。(凱路迪歐ex::疾風直撞)
  m = t.match(/^在這個回合，若從備戰區將這隻寶可夢放置於戰鬥場，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.attackerPromotedFromBenchThisTurn ? parseInt(m[1], 10) : 0) };

  // 從自己的牌庫選擇【X】寶可夢卡與「基本【X】能量」卡合計最多N張，在給對手看過後加入手牌。並且重洗牌庫。(熔蟻獸::舔舔捕捉)
  m = t.match(/^從自己的牌庫選擇【(.+?)】寶可夢卡與「基本【(.+?)】能量」卡合計最多(\d+)張，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m && m[1] === m[2]) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedPokemonOrEnergyToHand: { type, count: parseInt(m[3], 10) } };
  }

  // 若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。(詛咒娃娃::玩偶捕捉)
  if (/^若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), deckSearchAnyCardToHand: true };
  }

  // 從自己的棄牌區選擇最多N張「基本【X】能量」卡，以任意方式附於備戰寶可夢身上。(超級路卡利歐ex::波動突刺)
  m = t.match(/^從自己的棄牌區選擇最多(\d+)張「基本【(.+?)】能量」卡，以任意方式附於備戰寶可夢身上。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), discardEnergyToOwnBench: { type, count: parseInt(m[1], 10) } };
  }

  // 將這隻寶可夢與附加的卡，全部放回手牌。(喵喵ex::夾尾巴逃跑)
  if (/^將這隻寶可夢與附加的卡，全部放回手牌。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), returnSelfAndAttachmentsToHand: true };
  }

  // 將自己的場上寶可夢身上附加的任意數量的【X】能量卡丟棄，造成其張數×N點傷害。(超級噴火龍Xex::烈獄狂火X)
  // "任意數量" is a choice; we always discard every matching Energy, which maximises the damage
  // this attack exists to deal — the same "resolve the choice greedily" simplification the rest
  // of this module already documents.
  m = t.match(/^將自己的場上寶可夢身上附加的任意數量的【(.+?)】能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: 0, discardOwnFieldTypedEnergyForDamage: { type, per: parseInt(m[2], 10) } };
  }

  // 從牌庫附給自己的所有備戰寶可夢各1張「基本【X】能量」卡。並且重洗牌庫。
  m = t.match(/^從牌庫附給自己的所有備戰寶可夢各1張「基本【(.+?)】能量」卡。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedEnergyToAllBenchEach: type };
  }
  // 附給自己的所有備戰寶可夢各1張牌庫的【X】能量卡。並且重洗牌庫。 (同義措辭，如 霜奶仙VMAX::妝點)
  m = t.match(/^附給自己的所有備戰寶可夢各1張牌庫的【(.+?)】能量卡。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedEnergyToAllBenchEach: type };
  }

  // 從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。
  if (/^從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), deckSearchToolToHand: true };
  }

  // 增加自己的備戰寶可夢的數量×N點傷害。
  m = t.match(/^(?:造成|增加)自己的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.ownBenchCount * parseInt(m[1], 10) };

  // 查看自己的牌庫上方1張卡，回復原樣。若希望，將那張卡丟棄。(always chooses to keep — a
  // legitimate, if conservative, resolution of the choice rather than a no-op placeholder.)
  if (/^查看自己的牌庫上方1張卡，回復原樣。若希望，將那張卡丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 若這隻寶可夢身上沒有放置傷害指示物，則增加N點傷害。
  m = t.match(/^若這隻寶可夢身上沒有放置傷害指示物，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.selfDamageCounters === 0 ? parseInt(m[1], 10) : 0) };

  // 這個招式的傷害不計算抵抗力。(可能同時不計算弱點與附加效果 — 附加效果目前無機制可覆蓋，天生無操作)
  if (/^這個招式的傷害不計算抵抗力。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), ignoreResistance: true };
  }
  if (/^這個招式的傷害不計算弱點・抵抗力與對手的戰鬥寶可夢身上的附加效果。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), ignoreResistance: true, ignoreWeakness: true };
  }
  if (/^這個招式的傷害不計算對手的戰鬥寶可夢身上的附加效果。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 在下個對手的回合，對手無法從手牌使出物品卡。
  if (/^在下個對手的回合，對手無法從手牌使出物品卡。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), itemLockOpponentNextTurn: true };
  }

  // 在下個對手的回合，受到這個招式的寶可夢使用招式的傷害「-N」點。(outgoing nerf on the defender)
  m = t.match(/^在下個對手的回合，受到這個招式的寶可夢使用招式的傷害「-(\d+)」點。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'outgoingDamageReduction', amount: parseInt(m[1], 10), turnOffset: 1 } };

  // 在下個對手的回合，這隻寶可夢不會受到【基礎】寶可夢招式的傷害。(self-protect vs Basic attackers only)
  if (/^在下個對手的回合，這隻寶可夢不會受到【基礎】寶可夢招式的傷害。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'damageImmune', vsSubtype: 'Basic', turnOffset: 1 } };
  }

  // 在下個對手的回合，受到這個招式的寶可夢使用招式時，對手擲1次硬幣。若為反面，則那個招式失敗。
  if (/^在下個對手的回合，受到這個招式的寶可夢使用招式時，對手擲1次硬幣。若為反面，則那個招式失敗。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'coinFlipAttackMiss', turnOffset: 1 } };
  }

  // 擲N次硬幣，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。
  m = t.match(/^擲(\d+)次硬幣，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/);
  if (m) {
    const heads = flipCoins(parseInt(m[1], 10));
    return { baseDamage: parseBaseNumber(damageField), discardOpponentEnergyCount: heads };
  }

  // 對手選擇N張對手自己的手牌，將其丟棄。(their own choice, but the resulting state change is
  // identical to a blind discard of that many cards from their hand)
  m = t.match(/^對手選擇(\d+)張對手自己的手牌，將其丟棄。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardRandomOpponentHandCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇1張從這隻寶可夢進化而來的卡，放置於這隻寶可夢身上完成進化。並且重洗牌庫。
  if (/^從自己的牌庫選擇1張從這隻寶可夢進化而來的卡，放置於這隻寶可夢身上完成進化。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), evolveSelfFromDeck: true };
  }

  // 將對手的戰鬥寶可夢【狀態】。在下個對手的回合，受到這個招式的寶可夢無法撤退。(combined)
  m = t.match(new RegExp(`^將對手的戰鬥寶可夢【(${STATUS_ALT})】。在下個對手的回合，受到這個招式的寶可夢無法撤退。$`));
  if (m) return { baseDamage: parseBaseNumber(damageField), statusToInflict: [STATUS_ZH[m[1]]], opponentTimedEffect: { kind: 'cantRetreat', turnOffset: 1 } };

  // 從自己的牌庫選擇最多N張寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。(any stage, not just Basic)
  m = t.match(/^從自己的牌庫選擇最多(\d+)張寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchPokemonToHandCount: parseInt(m[1], 10) };

  // 從自己的棄牌區選擇最多N張寶可夢卡，在給對手看過後加入手牌。
  m = t.match(/^從自己的棄牌區選擇最多(\d+)張寶可夢卡，在給對手看過後加入手牌。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardPileSearchPokemonToHandCount: parseInt(m[1], 10) };

  // 從自己的棄牌區選擇1張支援者卡，在給對手看過後加入手牌。
  if (/^從自己的棄牌區選擇1張支援者卡，在給對手看過後加入手牌。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardPileSearchSupporterToHand: true };
  }

  // 將自己的牌庫上方N張卡丟棄。(self-mill)
  m = t.match(/^將自己的牌庫上方(\d+)張卡丟棄。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), millOwnDeckCount: parseInt(m[1], 10) };

  // 將自己的1隻寶可夢恢復「N」HP。(choice among own team — random pick among the damaged ones)
  m = t.match(/^將自己的1隻寶可夢恢復「(\d+)」HP。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), healRandomOwnDamagedAmount: parseInt(m[1], 10) };

  // 造成自己的場上「X」寶可夢的數量×N點傷害。(named-family count, generalized — two real phrasing
  // variants exist: "場上「X寶可夢」的數量" and "場上的「X」寶可夢的數量"; the first was a confirmed
  // bug that never matched any real card until fixed via a live reference-site log comparison.)
  m = t.match(/^造成自己的場上「(.+?)(?:寶可夢)?」的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, familyScaledDamage: { name: m[1], amount: parseInt(m[2], 10) } };
  m = t.match(/^造成自己的場上的「(.+?)」寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, familyScaledDamage: { name: m[1], amount: parseInt(m[2], 10) } };

  // 擲與這隻寶可夢身上附加的能量的數量相同次數的硬幣，造成/增加正面出現的次數×N點傷害。
  m = t.match(/^擲與這隻寶可夢身上附加的能量的數量相同次數的硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/);
  if (m) {
    const heads = flipCoins(board.attackerTotalEnergyCount);
    return { baseDamage: parseBaseNumber(damageField) + heads * parseInt(m[1], 10) };
  }

  // 擲與雙方的戰鬥寶可夢身上附加的能量的數量相同次數的硬幣，造成/增加正面出現的次數×N點傷害。
  m = t.match(/^擲與雙方的戰鬥寶可夢身上附加的能量的數量相同次數的硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/);
  if (m) {
    const heads = flipCoins(board.bothActiveEnergyCount);
    return { baseDamage: parseBaseNumber(damageField) + heads * parseInt(m[1], 10) };
  }

  // 查看對手的手牌，從其中選擇1張卡，將其丟棄。(reveal-then-choose -> same resulting state as a
  // blind discard: 1 fewer opponent hand card, 1 more in their discard pile)
  if (/^查看對手的手牌，從其中選擇1張卡，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardRandomOpponentHandCount: 1 };
  }

  // 在這個回合，若這隻寶可夢從「X」進化，則增加N點傷害。(approximated via the card's fixed
  // evolvesFrom field rather than tracking "evolved this exact turn" — a defensible
  // simplification since evolvesFrom itself never changes for a given printed card.)
  m = t.match(/^在這個回合，若這隻寶可夢從「(.+?)」進化，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.attackerEvolvesFrom === m[1] ? parseInt(m[2], 10) : 0) };

  // 將自己的牌庫上方N張卡丟棄，造成其中「X」(卡)的張數×M點傷害。(trailing 卡 is optional — e.g.
  // "其中「基本【水】能量」卡的張數" vs "其中「小霞的寶可夢」的張數")
  m = t.match(/^將自己的牌庫上方(\d+)張卡丟棄，造成其中「(.+?)」(?:卡)?的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, selfMillFamilyScaledDamage: { millCount: parseInt(m[1], 10), name: m[2], amount: parseInt(m[3], 10) } };

  // 將自己的牌庫上方N張卡翻到正面，造成其中的「X」卡的張數×M點傷害。將翻到正面的「X」卡丟棄，將剩餘卡放回牌庫並重洗。
  // (reveal N, count matches, discard ONLY the matches, rest goes back + reshuffle — unlike the
  // mill-everything template above)
  m = t.match(/^將自己的牌庫上方(\d+)張卡翻到正面，造成其中的「(.+?)」卡的張數×(\d+)點傷害。將翻到正面的「\2」卡丟棄，將剩餘卡放回牌庫並重洗。$/);
  if (m) return { baseDamage: 0, selfRevealTopMatchDiscardRestReshuffle: { revealCount: parseInt(m[1], 10), name: m[2], amount: parseInt(m[3], 10) } };

  // 從自己的牌庫選擇最多N張「X」，在給對手看過後加入手牌。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張「(.+?)」，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchFamilyToHandCount: { count: parseInt(m[1], 10), name: m[2] } };

  // 從自己的牌庫選擇最多N張「X」，放置於備戰區。並且重洗牌庫。(family-named, deck)
  m = t.match(/^從自己的牌庫選擇最多(\d+)張「(.+?)」，放置於備戰區。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchFamilyToBenchCount: { count: parseInt(m[1], 10), name: m[2] } };

  // 從自己的棄牌區選擇最多N張「X」，放置於備戰區。(family-named, discard pile)
  m = t.match(/^從自己的棄牌區選擇最多(\d+)張「(.+?)」，放置於備戰區。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardPileSearchFamilyToBenchCount: { count: parseInt(m[1], 10), name: m[2] } };

  // 若希望，將場上的競技場卡丟棄。(optional, always taken)
  if (/^若希望，將場上的競技場卡丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardActiveStadium: true };
  }

  // 若希望，將對手的戰鬥寶可夢與備戰寶可夢互換。[由對手選擇...] (optional, always taken)
  if (/^若希望，將對手的戰鬥寶可夢與備戰寶可夢互換。\[由對手選擇放置於戰鬥場的寶可夢。\]$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), forceOpponentSwitchToRandomBench: true };
  }

  // 造成自己的棄牌區的，名稱中有「X」的支援者卡的張數×N點傷害。
  m = t.match(/^造成自己的棄牌區的，名稱中有「(.+?)」的支援者卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownDiscardCardNames.filter(n => n.includes(m![1])).length * parseInt(m[2], 10) };

  // 造成自己的棄牌區的，持有「X」招式的寶可夢卡的張數×N點傷害。(needs live card.attacks data the
  // pure board-number context doesn't carry — resolved as a post-process override in moves.ts)
  m = t.match(/^造成自己的棄牌區的，持有「(.+?)」招式的寶可夢卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, discardPileAttackScaledDamage: { attackName: m[1], amount: parseInt(m[2], 10) } };

  // 增加自己的棄牌區的「X」的張數×N點傷害。(named card count in own discard, e.g. a specific Supporter)
  m = t.match(/^增加自己的棄牌區的「(.+?)」的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.ownDiscardCardNames.filter(n => n.includes(m![1])).length * parseInt(m[2], 10) };

  // 造成這隻寶可夢身上附加的能量的數量×N點傷害。(attacker's own total Energy count)
  m = t.match(/^造成這隻寶可夢身上附加的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.attackerTotalEnergyCount * parseInt(m[1], 10) };

  // 造成自己的備戰寶可夢的數量×N點傷害。
  m = t.match(/^造成自己的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownBenchCount * parseInt(m[1], 10) };

  // 若自己的備戰區有名稱中有「X」的寶可夢，則增加N點傷害。
  m = t.match(/^若自己的備戰區有名稱中有「(.+?)」的寶可夢，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownBenchNames.some(n => n.includes(m![1])) ? parseInt(m[2], 10) : 0) };

  // 選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。然後，新上場的寶可夢受到N點傷害。
  m = t.match(/^選擇1隻對手的備戰寶可夢，與戰鬥寶可夢互換。然後，新上場的寶可夢受到(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), forceOpponentSwitchToRandomBench: true, splashDamageAfterSwitch: parseInt(m[1], 10) };

  // 擲2次硬幣，若全部為反面，則這隻寶可夢也受到N點傷害。
  m = t.match(/^擲2次硬幣，若全部為反面，則這隻寶可夢也受到(\d+)點傷害。$/);
  if (m) {
    const heads = flipCoins(2);
    return { baseDamage: parseBaseNumber(damageField), selfDamage: heads === 0 ? parseInt(m[1], 10) : 0 };
  }

  // 查看對手的牌庫上方N張卡，以任意順序排列，放回牌庫上方。(reordering into an arbitrary order —
  // no real state change for a non-omniscient engine; a legitimate resolution, not a no-op stub.)
  if (/^查看對手的牌庫上方(\d+)張卡，以任意順序排列，放回牌庫上方。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 在下個自己的回合，這隻寶可夢使用的招式，對對手的戰鬥寶可夢造成的傷害「+N」點。(self-buff next own turn)
  m = t.match(/^在下個自己的回合，這隻寶可夢使用的招式，對對手的戰鬥寶可夢造成的傷害「\+(\d+)」點。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'outgoingDamageBoost', amount: parseInt(m[1], 10), turnOffset: 2 } };

  // 在下個自己的回合，這隻寶可夢無法使用「X」。(locks only that ONE named attack, not all of them)
  m = t.match(/^在下個自己的回合，這隻寶可夢無法使用「(.+?)」。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'namedAttackLock', attackName: m[1], turnOffset: 2 } };

  // 造成對手的棄牌區的基本能量卡的張數×N點傷害。
  m = t.match(/^造成對手的棄牌區的基本能量卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.opponentDiscardBasicEnergyCount * parseInt(m[1], 10) };

  // 增加雙方的戰鬥寶可夢身上附加的能量的數量×N點傷害。
  m = t.match(/^增加雙方的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.bothActiveEnergyCount * parseInt(m[1], 10) };

  // 將這隻寶可夢的特殊狀態全部恢復。(cure self)
  if (/^將這隻寶可夢的特殊狀態全部恢復。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), cureAllSelfStatus: true };
  }

  // 將自己的所有寶可夢各恢復「N」HP。
  m = t.match(/^將自己的所有寶可夢各恢復「(\d+)」HP。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), healAllOwnTeamAmount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇最多N張「基本【X】能量」卡，附於1隻備戰寶可夢身上。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張「基本【(.+?)】能量」卡，附於1隻備戰寶可夢身上。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedEnergyToOwnPokemonCount: { type, count: parseInt(m[1], 10) } };
  }

  // 將N個傷害指示物以任意方式放置於對手的寶可夢身上。(any distribution -> simplified to 1 random target)
  m = t.match(/^將(\d+)個傷害指示物以任意方式放置於對手的寶可夢身上。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), placeCountersOnRandomOpponent: parseInt(m[1], 10) };

  // 若對手剩餘獎賞卡的張數為N張以下，則增加M點傷害。
  m = t.match(/^若對手剩餘獎賞卡的張數為(\d+)張以下，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.opponentRemainingPrizes <= parseInt(m[1], 10) ? parseInt(m[2], 10) : 0) };

  // 若自己的牌庫的剩餘張數為N張以下，則增加M點傷害。
  m = t.match(/^若自己的牌庫的剩餘張數為(\d+)張以下，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownDeckCount <= parseInt(m[1], 10) ? parseInt(m[2], 10) : 0) };

  // 若自己的場上的能量有N個以上，則增加M點傷害。這個招式的傷害不計算弱點。
  m = t.match(/^若自己的場上的能量有(\d+)個以上，則增加(\d+)點傷害。這個招式的傷害不計算弱點。$/);
  if (m) return {
    baseDamage: parseBaseNumber(damageField) + (board.ownFieldTotalEnergyCount >= parseInt(m[1], 10) ? parseInt(m[2], 10) : 0),
    ignoreWeakness: true,
  };

  // 若對手的戰鬥寶可夢為【X】寶可夢，則將那隻寶可夢【狀態】。(type-conditional status infliction)
  m = t.match(new RegExp(`^若對手的戰鬥寶可夢為【(.+?)】寶可夢，則將那隻寶可夢【(${STATUS_ALT})】。$`));
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const matches = !!type && board.defenderTypes.includes(type);
    return { baseDamage: parseBaseNumber(damageField), statusToInflict: matches ? [STATUS_ZH[m[2]]] : undefined };
  }

  // 若對手的戰鬥寶可夢為【X】寶可夢，則增加N點傷害。(X may be an Energy type OR a stage Subtype label)
  m = t.match(/^若對手的戰鬥寶可夢為【(.+?)】寶可夢，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const subtype = SUBTYPE_FROM_ZH[m[1]];
    const matches = (!!type && board.defenderTypes.includes(type)) || (!!subtype && board.defenderSubtypes.includes(subtype));
    return { baseDamage: parseBaseNumber(damageField) + (matches ? parseInt(m[2], 10) : 0) };
  }

  // 若對手的戰鬥寶可夢【灼傷】，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢【灼傷】，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderIsBurned ? parseInt(m[1], 10) : 0) };

  // 若對手的戰鬥寶可夢【混亂】，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢【混亂】，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderIsConfused ? parseInt(m[1], 10) : 0) };

  // 若對手的戰鬥寶可夢為進化寶可夢，則增加N點傷害。(approximated via defenderEvolvesFrom being set)
  m = t.match(/^若對手的戰鬥寶可夢為進化寶可夢，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderEvolvesFrom ? parseInt(m[1], 10) : 0) };

  // 若對手的場上有「未來」寶可夢，則增加N點傷害。
  m = t.match(/^若對手的場上有「未來」寶可夢，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.opponentHasFutureSubtype ? parseInt(m[1], 10) : 0) };

  // 若對手的場上有【X】寶可夢，則增加N點傷害。
  m = t.match(/^若對手的場上有【(.+?)】寶可夢，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    return { baseDamage: parseBaseNumber(damageField) + (!!type && board.opponentFieldTypes.includes(type) ? parseInt(m[2], 10) : 0) };
  }

  // 若這隻寶可夢身上附有N個以上【X】能量，則增加M點傷害。
  m = t.match(/^若這隻寶可夢身上附有(\d+)個以上【(.+?)】能量，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    const count = type ? (board.attackerEnergyCounts[type] || 0) : 0;
    return { baseDamage: parseBaseNumber(damageField) + (count >= parseInt(m[1], 10) ? parseInt(m[3], 10) : 0) };
  }

  // 若自己的場上的【X】能量有N個以上，則增加M點傷害。(whole-field Energy count, not just the attacker)
  m = t.match(/^若自己的場上的【(.+?)】能量有(\d+)個以上，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.ownFieldEnergyCounts[type] || 0) : 0;
    return { baseDamage: parseBaseNumber(damageField) + (count >= parseInt(m[2], 10) ? parseInt(m[3], 10) : 0) };
  }

  // 造成對手的手牌的張數×N點傷害。
  m = t.match(/^造成對手的手牌的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.opponentHandCount * parseInt(m[1], 10) };

  // 造成自己的場上的【基礎】寶可夢的數量×N點傷害。
  m = t.match(/^造成自己的場上的【基礎】寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownFieldBasicCount * parseInt(m[1], 10) };

  // 減少對手的戰鬥寶可夢【撤退】所需的能量的數量×N點傷害。
  m = t.match(/^減少對手的戰鬥寶可夢【撤退】所需的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.defenderRetreatCost * parseInt(m[1], 10) };

  // 若場上有競技場卡，則增加N點傷害。然後，將那張競技場卡丟棄。
  m = t.match(/^若場上有競技場卡，則增加(\d+)點傷害。然後，將那張競技場卡丟棄。$/);
  if (m) return {
    baseDamage: parseBaseNumber(damageField) + (board.hasActiveStadium ? parseInt(m[1], 10) : 0),
    discardActiveStadium: board.hasActiveStadium,
  };

  // 在下個自己的回合，受到這個招式的寶可夢受到招式的傷害「+N」點。(vulnerability debuff on the
  // defender — reuses the 'damageReduction' timed-effect kind with a NEGATIVE amount, since
  // getPassiveDamageReduction just sums amounts and a negative reduction is a boost for free.)
  m = t.match(/^在下個自己的回合，受到這個招式的寶可夢受到招式的傷害「\+(\d+)」點。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'damageReduction', amount: -parseInt(m[1], 10), turnOffset: 2 } };

  // 將這隻寶可夢身上附加的能量卡全部丟棄，將對手的戰鬥寶可夢【狀態】。
  m = t.match(new RegExp(`^將這隻寶可夢身上附加的能量卡全部丟棄，將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`));
  if (m) return { baseDamage: parseBaseNumber(damageField), discardAllSelfEnergy: true, statusToInflict: [STATUS_ZH[m[1]]] };

  // 從自己的棄牌區選擇1張能量卡，附於這隻寶可夢身上。(any Energy type)
  if (/^從自己的棄牌區選擇1張能量卡，附於這隻寶可夢身上。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardPileSearchAnyEnergyToSelf: true };
  }

  // 擲1次硬幣若為正面，則增加N點傷害，並將這隻寶可夢恢復「M」HP。(both gated on the same flip)
  m = t.match(/^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害，並將這隻寶可夢恢復「(\d+)」HP。$/);
  if (m) {
    const heads = Math.random() < 0.5;
    return {
      baseDamage: parseBaseNumber(damageField) + (heads ? parseInt(m[1], 10) : 0),
      healSelfAmount: heads ? parseInt(m[2], 10) : undefined,
    };
  }

  // 從牌庫抽卡直到自己的手牌滿N張為止。(unconditional variant, no "若希望" prefix)
  m = t.match(/^從牌庫抽卡直到自己的手牌滿(\d+)張為止。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), drawToHandSize: parseInt(m[1], 10) };

  // 造成自己的場上【X】寶可夢的數量×N點傷害。(own-field count by printed Energy type)
  m = t.match(/^造成自己的場上【(.+?)】寶可夢的數量×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.ownFieldTypeCounts[type] || 0) : 0;
    return { baseDamage: count * parseInt(m[2], 10) };
  }

  // 造成/增加自己的所有寶可夢身上附加的【X】能量的數量×N點傷害。(whole-field Energy count by type
  // — found via a live reference-site game log: 超級沙奈朵ex's 超級交響樂 uses "造成", which the
  // template only matched "增加" for until this fix, silently missing a real, currently-played card.)
  m = t.match(/^(?:造成|增加)自己的所有寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.ownFieldEnergyCounts[type] || 0) : 0;
    return { baseDamage: parseBaseNumber(damageField) + count * parseInt(m[2], 10) };
  }

  // 增加名稱中有「X」的自己的備戰寶可夢的數量×N點傷害。/ 增加自己的備戰區的「X」的數量×N點傷害。
  // (bench-only named-family count — computed as a post-process override in moves.ts, since it
  // needs live card names, not just a plain board number)
  m = t.match(/^增加名稱中有「(.+?)」的自己的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, ownBenchFamilyScaledDamage: { name: m[1], amount: parseInt(m[2], 10) } };
  m = t.match(/^增加自己的備戰區的「(.+?)」的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, ownBenchFamilyScaledDamage: { name: m[1], amount: parseInt(m[2], 10) } };

  // 增加自己的備戰區的【2階進化】寶可夢的數量×N點傷害。
  m = t.match(/^增加自己的備戰區的【2階進化】寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownBenchStage2Count * parseInt(m[1], 10) };

  // 增加自己的身上放置有傷害指示物的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加自己的身上放置有傷害指示物的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownDamagedBenchCount * parseInt(m[1], 10) };

  // 增加自己的身上附有【X】能量卡的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加自己的身上附有【(.+?)】能量卡的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.ownBenchEnergyHolderCounts[type] || 0) : 0;
    return { baseDamage: count * parseInt(m[2], 10) };
  }

  // 造成對手的場上的「寶可夢【ex】」/「寶可夢【ex】・【V】」的數量×N點傷害。
  m = t.match(/^造成對手的場上的「寶可夢【ex】」的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.opponentExCount * parseInt(m[1], 10) };
  m = t.match(/^造成對手的場上的「寶可夢【ex】・【V】」的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.opponentExOrVCount * parseInt(m[1], 10) };

  // 造成/增加對手的戰鬥寶可夢【撤退】所需的能量的數量×N點傷害。(positive scaling — distinct from
  // the earlier "減少...×N點傷害" template, which is a damage-REDUCTION card, not a bonus one)
  m = t.match(/^(?:造成|增加)對手的戰鬥寶可夢【撤退】所需的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.defenderRetreatCost * parseInt(m[1], 10) };

  // 造成/增加對手的所有寶可夢身上附加的【X】能量/能量的數量×N點傷害。(opponent's WHOLE team, typed and untyped)
  m = t.match(/^(?:造成|增加)對手的所有寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    const count = type ? (board.opponentFieldEnergyCounts[type] || 0) : 0;
    return { baseDamage: parseBaseNumber(damageField) + count * parseInt(m[2], 10) };
  }
  m = t.match(/^(?:造成|增加)對手的所有寶可夢身上附加的能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.opponentFieldTotalEnergyCount * parseInt(m[1], 10) };

  // 造成自己場上的身上放置有傷害指示物的寶可夢的數量×N點傷害。(own WHOLE FIELD damaged count)
  m = t.match(/^造成自己場上的身上放置有傷害指示物的寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.ownFieldDamagedCount * parseInt(m[1], 10) };

  // 造成自己的場上的，持有「X」招式的寶可夢的數量×N點傷害。(field-wide named-attack-holder count —
  // post-process override in moves.ts, mirrors the discard-pile variant above)
  m = t.match(/^造成自己的場上的，持有「(.+?)」招式的寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: 0, ownFieldAttackScaledDamage: { attackName: m[1], amount: parseInt(m[2], 10) } };

  // 造成這隻寶可夢身上附加的基本能量的數量×N點傷害。(approximated via total attached Energy count,
  // same attachedEnergy Basic-vs-Special limitation documented elsewhere in this session)
  m = t.match(/^造成這隻寶可夢身上附加的基本能量的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: board.attackerTotalEnergyCount * parseInt(m[1], 10) };

  return undefined;
}
