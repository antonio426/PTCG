/**
 * With 1400+ unique Pokémon+attack combos carrying non-trivial text, hand-writing a bespoke
 * EffectHandler (attacks.ts's per-combo registry) for every one isn't tractable. Most of that
 * text, though, follows a small number of recurring templates (coin-flip-scaled damage, single
 * coin-flip status/bonus-damage, unconditional status infliction, self-heal, draw). This module
 * recognizes those templates directly from the printed attack text/damage string at attack time
 * and resolves them — no per-card registration needed, so it automatically covers reprints and
 * any future card sharing the same template.
 *
 * Deliberately NOT handled here (left to the bespoke attacks.ts registry or genuinely
 * unsupported): anything requiring a player choice (bench damage distribution, energy
 * discard-choice, search-and-choose), "can't attack next turn"-style disables (no per-card
 * disable flag exists), and per-card "protected during opponent's next turn" (only a
 * player-wide version of that exists, via G.players[].incomingDamageReduction).
 */
import { StatusCondition } from '@ptcg/shared';

export interface GenericAttackOutcome {
  /** Replaces `parseInt(attack.damage)` as the pre-weakness/passive base damage for this use. */
  baseDamage: number;
  /** Applied to the defender only if final damage > 0, matching real rules for on-hit effects. */
  statusToInflict?: StatusCondition[];
  healSelfAmount?: number;
  drawCards?: number;
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

/** Pure classifier (no randomness) — used by coverage-report.ts to count these as covered. */
export function matchesGenericAttackTemplate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /^擲(\d+)次硬幣，(?:造成|增加)正面出現的次數×(\d+)點傷害。$/.test(t)
    || new RegExp(`^擲(\\d+)次硬幣，(?:造成|增加)正面出現的次數×(\\d+)點傷害。若出現(\\d+)次以上正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`).test(t)
    || /^擲硬幣直到出現反面，增加正面出現的次數×(\d+)點傷害。$/.test(t)
    || /^擲1次硬幣[，,]?若為正面，則增加(\d+)點傷害。$/.test(t)
    || new RegExp(`^擲1次硬幣[，,]?若為正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`).test(t)
    || /^擲1次硬幣[，,]?若為反面，則這個招式失敗。$/.test(t)
    || new RegExp(`^將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`).test(t)
    || new RegExp(`^將對手的戰鬥寶可夢(【(${STATUS_ALT})】[、與]?)+。$`).test(t)
    || /^將這隻寶可夢恢復「(\d+)」HP。$/.test(t)
    || /^從自己的牌庫抽出(\d+)張卡。$/.test(t)
  );
}

/** Resolves a matching template into a concrete outcome, rolling any coin flips exactly once. Returns undefined if no template matches. */
export function resolveGenericAttackEffect(text: string, damageField: string): GenericAttackOutcome | undefined {
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

  return undefined;
}
