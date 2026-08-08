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
 * Deliberately NOT handled here (left to the bespoke attacks.ts registry or genuinely
 * unsupported): anything requiring a player CHOICE among multiple valid targets (bench damage
 * distribution, "choose 1 of your opponent's benched Pokémon to also hit", search-and-choose —
 * where WHICH one matters strategically); "ignore the defender's attached-card effects" (this
 * engine has no Tool-based incoming-damage-reduction mechanic yet for that to meaningfully
 * override); and "look at the opponent's hand" (no information-asymmetry state exists to reveal
 * into, so there'd be nothing to actually change).
 */
import { StatusCondition } from '@ptcg/shared';

export interface TimedEffectDescriptor {
  kind: 'cantAttack' | 'cantRetreat' | 'damageImmune' | 'damageReduction';
  amount?: number;
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
}

const STATUS_ZH: Record<string, StatusCondition> = {
  '睡眠': 'Asleep', '灼傷': 'Burned', '混亂': 'Confused', '麻痺': 'Paralyzed', '中毒': 'Poisoned',
};
const STATUS_ALT = Object.keys(STATUS_ZH).join('|');

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
  /^擲硬幣直到出現反面，增加正面出現的次數×(\d+)點傷害。$/,
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

  // 擲硬幣直到出現反面，增加正面出現的次數×M點傷害。
  m = t.match(/^擲硬幣直到出現反面，增加正面出現的次數×(\d+)點傷害。$/);
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

  return undefined;
}
