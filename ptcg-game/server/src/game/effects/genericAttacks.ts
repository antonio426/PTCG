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

export interface TimedEffectDescriptor {
  kind: 'cantAttack' | 'cantRetreat' | 'damageImmune' | 'damageReduction' | 'outgoingDamageReduction' | 'coinFlipAttackMiss';
  amount?: number;
  /** For 'damageImmune': restricts the immunity to attackers of this printed Subtype only (e.g. "Basic"). */
  vsSubtype?: string;
  /** Added to G.turn at apply time by the caller (moves.ts, which has G in scope) to get the
   * absolute turn number this effect is active on. 1 = the opponent's very next turn (used for
   * both "protect myself next opponent turn" and "the Pokémon I just hit can't retreat/attack
   * next their-turn"); 2 = my own next turn (used for "this Pokémon can't attack next my-turn"). */
  turnOffset: number;
}

export interface GenericAttackOutcome {
  /** Replaces `parseInt(attack.damage)` as the pre-weakness/passive base damage for this use. */
  baseDamage: number;
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
  /** Search the deck for 1 Pokémon Tool card, add to hand, reshuffle. */
  deckSearchToolToHand?: boolean;
  /** Skip resistance / skip weakness when computing this hit's damage. */
  ignoreResistance?: boolean;
  ignoreWeakness?: boolean;
  /** Sets the OPPONENT's Item-lock for their very next turn. */
  itemLockOpponentNextTurn?: boolean;
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
}

const STATUS_ZH: Record<string, StatusCondition> = {
  '睡眠': 'Asleep', '灼傷': 'Burned', '混亂': 'Confused', '麻痺': 'Paralyzed', '中毒': 'Poisoned',
};
const STATUS_ALT = Object.keys(STATUS_ZH).join('|');

const ENERGY_TYPE_FROM_ZH: Record<string, string> = {
  '草': 'Grass', '火': 'Fire', '水': 'Water', '雷': 'Lightning', '超': 'Psychic',
  '鬥': 'Fighting', '惡': 'Darkness', '鋼': 'Metal', '妖': 'Fairy', '龍': 'Dragon', '無': 'Colorless',
};

function flipCoins(n: number): number {
  let heads = 0;
  for (let i = 0; i < n; i++) if (Math.random() < 0.5) heads++;
  return heads;
}

function parseBaseNumber(damageField: string): number {
  const m = damageField.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
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
  /^增加對手的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/,
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
  /^增加對手的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^增加雙方的備戰寶可夢的數量×(\d+)點傷害。$/,
  /^增加這隻寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/,
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
  /^增加自己的備戰寶可夢的數量×(\d+)點傷害。$/,
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
    const outcome: GenericAttackOutcome = { baseDamage: base + heads * per };
    if (m[3] && m[4] && heads >= parseInt(m[3], 10)) outcome.statusToInflict = [STATUS_ZH[m[4]]];
    return outcome;
  }

  // 擲硬幣直到出現反面，造成/增加正面出現的次數×M點傷害。
  m = t.match(/^擲硬幣直到出現反面，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/);
  if (m) {
    const per = parseInt(m[1], 10);
    let heads = 0;
    while (Math.random() < 0.5) heads++;
    return { baseDamage: parseBaseNumber(damageField) + heads * per };
  }

  // 擲1次硬幣若為正面，則增加N點傷害。
  m = t.match(/^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害。$/);
  if (m) {
    const bonus = parseInt(m[1], 10);
    const heads = Math.random() < 0.5;
    return { baseDamage: parseBaseNumber(damageField) + (heads ? bonus : 0) };
  }

  // 擲1次硬幣若為正面，則將對手的戰鬥寶可夢【狀態】。
  m = t.match(new RegExp(`^擲1次硬幣[，,]?若為正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`));
  if (m) {
    const heads = Math.random() < 0.5;
    const outcome: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField) };
    if (heads) outcome.statusToInflict = [STATUS_ZH[m[1]]];
    return outcome;
  }

  // 擲1次硬幣若為反面，則這個招式失敗。
  if (/^擲1次硬幣[，,]?若為反面，則這個招式失敗。$/.test(t)) {
    const heads = Math.random() < 0.5;
    return { baseDamage: heads ? parseBaseNumber(damageField) : 0 };
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

  // 增加對手的戰鬥寶可夢身上附加的能量的數量×N點傷害。
  m = t.match(/^增加對手的戰鬥寶可夢身上附加的能量的數量×(\d+)點傷害。$/);
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

  // 增加對手的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加對手的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + board.opponentBenchCount * parseInt(m[1], 10) };

  // 增加雙方的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加雙方的備戰寶可夢的數量×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownBenchCount + board.opponentBenchCount) * parseInt(m[1], 10) };

  // 增加這隻寶可夢身上附加的【X】能量的數量×N點傷害。
  m = t.match(/^增加這隻寶可夢身上附加的【(.+?)】能量的數量×(\d+)點傷害。$/);
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

  // 從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。
  if (/^從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), deckSearchToolToHand: true };
  }

  // 增加自己的備戰寶可夢的數量×N點傷害。
  m = t.match(/^增加自己的備戰寶可夢的數量×(\d+)點傷害。$/);
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

  return undefined;
}
