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
  kind: 'cantAttack' | 'cantRetreat' | 'damageImmune' | 'damageReduction' | 'outgoingDamageReduction' | 'outgoingDamageBoost' | 'coinFlipAttackMiss' | 'namedAttackLock' | 'weaknessRemoved' | 'retaliationCounters';
  amount?: number;
  /** For 'damageImmune': restricts the immunity to attackers of this printed Subtype only (e.g. "Basic"). */
  vsSubtype?: string;
  /** For 'damageImmune': only attacks printing at most this much damage are blocked. */
  maxImmuneDamage?: number;
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
  /** Same, but moving up to N Energy at once (all to the same randomly-picked target). */
  moveSelfEnergyToRandomBenchCount?: number;

  /** Flat damage (no weakness/resistance) to 1 random opponent Benched Pokémon. */
  benchSplashDamage?: number;
  /** Flat damage (no weakness/resistance) to EVERY one of the attacker's own Benched Pokémon. */
  selfAllBenchSplashDamage?: number;
  /** Flat damage (no weakness/resistance) to EVERY one of the OPPONENT's Benched Pokémon (the
   * mirror image of selfAllBenchSplashDamage, for "both sides' whole Bench" texts). */
  opponentAllBenchSplashDamage?: number;
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
  /** Place N damage counters on the opponent's Active specifically (斯魔茶::無聲加害). Counters, not
   * damage — Weakness/Resistance never apply, so this can't go through the damage pipeline. */
  placeCountersOnOpponentActive?: number;
  /** Place N damage counters on EVERY opponent Pokémon (來悲粗茶::抹茶旋濺). */
  placeCountersOnAllOpponent?: number;
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

  /** Heal 1 random own-Bench Pokémon of the given type by amount (no-op if none match). */
  healBenchTypedAmount?: { type: string; amount: number };
  /** Search the deck for up to N Pokémon of the given type ONLY (no Energy alternative, unlike
   * deckSearchTypedPokemonOrEnergyToHand), add to hand, reshuffle. */
  deckSearchTypedPokemonToHandCount?: { type: string; count: number };
  /** Place `amount`x10 damage counters on EVERY opponent Pokémon (active+bench) that already has
   * at least 1 damage counter (not just one random target). */
  damageToEachDamagedOpponentAmount?: number;
  /** Discard the attacker's own whole hand (NOT shuffled back, unlike shuffleHandThenDrawCount), then draw N. */
  discardHandThenDrawCount?: number;
  /** Flat damage (no weakness/resistance), split across `count` DIFFERENT random opponent
   * Pokémon (active+bench pool), `amount` each — the auto-pick-random simplification for "choose
   * N times" / "N different Pokémon" texts. */
  multiTargetOpponentFlatDamage?: { count: number; amount: number };
  /** Pick 1 random card from the opponent's hand, put it on the BOTTOM of their deck (distinct
   * from shuffleRandomOpponentHandCardIntoDeck, which shuffles to a random position). */
  randomOpponentHandCardToDeckBottom?: boolean;
  /** Force-KO the defender if its damage counters exactly equal this count, regardless of remaining HP. */
  koDefenderIfDamageCountersEqual?: number;
  /** Damage to 1 random opponent Bench Pokémon equal to THAT Pokémon's own damage counters x multiplier. */
  opponentBenchDamageScaledSplash?: { multiplier: number };
  /** If the attacker has at least 1 Energy of `type` attached, return one to hand and add `amount` damage. */
  returnSelfEnergyToHandTypeBonus?: { type: string; amount: number };
  /** Optional (auto-taken if available): shuffle up to `max` of the attacker's own attached
   * Energy back into the deck, and if any were actually moved, splash `benchDamage` onto 1
   * random opponent Bench Pokémon (no weakness/resistance). */
  optionalEnergyToDeckForBenchDamage?: { max: number; benchDamage: number };
  /** Return 1 random attached Energy from the attacker to hand (no damage bonus attached). */
  returnSelfEnergyToHandCount?: number;
  /** Discard this many random cards from the ATTACKER's own hand (mirrors discardRandomOpponentHandCount). */
  discardRandomSelfHandCount?: number;
  /** Pick `count` random opponent Bench Pokémon, remove them (with attachments) from play, shuffle into their deck. */
  shuffleOpponentBenchToDeckCount?: number;
  /** Heal every one of the attacker's own BENCH Pokémon (not the Active) by this amount. */
  healAllOwnBenchAmount?: number;
  /** Flip coins until the first tails (capped at 20 to stay finite); discard that many random
   * Energy from the DEFENDER's attachedEnergy. */
  flipUntilTailsDiscardOpponentEnergy?: boolean;
  /** Shuffle ALL of the attacker's own attached Energy back into the deck (distinct from
   * discardAllSelfEnergy, which sends them to the discard pile), reshuffle. */
  shuffleAllSelfEnergyToDeck?: boolean;
  /** Move up to N random cards from the attacker's own deck to the TOP of the deck (an omniscient
   * "look at your whole deck, pick N, put them on top" simplified to a random pick — this engine
   * has no hidden-information model preventing that lookup anyway). */
  deckSearchAnyCardsToTopOfDeck?: number;
  /** Same as shuffleRandomOpponentHandCardIntoDeck, but for N cards at once (opponent's own choice
   * of which — auto-random per this file's convention). */
  shuffleRandomOpponentHandCardsIntoDeckCount?: number;
  /** Flip N coins; discard this many random Energy from the ATTACKER's own attachedEnergy, where
   * the count discarded equals however many of the N flips came up TAILS (the mirror image of the
   * existing heads-scaled-damage coin templates). */
  flipCoinsDiscardSelfEnergyByTailsCount?: number;
  /** Discard N random SPECIAL Energy attached to the defender (basic Energy is untouchable). */
  discardOpponentSpecialEnergyCount?: number;
  /** Detach N random Energy from the defender and put them into the OPPONENT's hand (as cards). */
  returnOpponentEnergyToHandCount?: number;
  /** Flat no-w/r damage to `count` DIFFERENT random own-Bench Pokémon, `amount` each. */
  multiTargetSelfBenchFlatDamage?: { count: number; amount: number };
  /** Flat no-w/r damage to `count` DIFFERENT random opponent BENCH Pokémon, `amount` each. */
  multiTargetOpponentBenchFlatDamage?: { count: number; amount: number };
  /** Same, but only opponent Bench Pokémon that already carry at least 1 damage counter. */
  multiTargetOpponentDamagedBenchFlatDamage?: { count: number; amount: number };
  /** Take up to `count` cards whose name includes `name` from the own discard pile and attach
   * them to the attacker (Energy cards attach as energy; anything else is left alone). */
  discardPileSearchNamedToSelfCount?: { name: string; count: number };
  /** Discard `count` random attached Energy of exactly this flat type from the attacker. */
  discardSelfTypedEnergy?: { type: string; count: number };
  /** Search the deck for up to `count` cards whose name includes `name` (Energy cards), attach
   * to a random own Pokémon (Bench only when `benchOnly`), reshuffle. */
  deckSearchNamedEnergyAttachCount?: { name: string; count: number; benchOnly?: boolean };
  /** Search the deck for up to N cards of ANY kind (random pick), add to hand, reshuffle. */
  deckSearchAnyCardsToHandCount?: number;
  /** With a Poisoned statusToInflict: the between-turns Poison tick places N counters, not 1. */
  poisonCounterOverride?: number;
  /** Reveal the top N deck cards; every Pokémon among them goes to the Bench (space allowing),
   * the rest are shuffled back. */
  revealTopBenchPokemonCount?: number;
  /** Flat no-w/r damage to up to `count` opponent Pokémon whose name includes `name`. */
  opponentNamedFlatDamage?: { name: string; amount: number; count: number; benchOnly?: boolean };
  /** If this attack's damage KO'd the defender, the attacker is damage-immune next opponent turn. */
  selfProtectNextTurnIfKo?: boolean;
  /** Return the attacker alone to hand (with its stacked lower Stages — they are Pokémon cards);
   * every non-Pokémon attachment (Energy, Tool) is discarded instead. */
  returnSelfToHandDiscardAttachments?: boolean;
  /** Move ALL damage counters from up to `count` own-Bench Pokémon whose name includes `name`
   * onto the defender. */
  moveNamedBenchDamageToDefender?: { name: string; count: number };
  /** Place `counters` damage counters on each of `count` DIFFERENT random opponent Pokémon. */
  placeCountersOnMultipleOpponents?: { count: number; counters: number };
  /** Place counters on the defender until its remaining HP is exactly N (no-op if already at or
   * below N). Counters, not damage — no weakness/resistance. */
  setDefenderRemainingHp?: number;
  /** Search the own discard pile for up to `count` Pokémon of `type`, place onto the Bench. */
  discardPileSearchTypedPokemonToBenchCount?: { type: string; count: number };
  /** Discard `count` cards whose name includes `name` from the attacker's own hand (the matcher
   * already verified they exist — 「若無法丟棄，則這個招式失敗」 resolves to a 0-damage no-op). */
  discardNamedFromHandCount?: { name: string; count: number };
  /** 「選擇自己的所有備戰寶可夢進化而來的卡各1張…完成進化」 — evolve every own Benched Pokémon
   * (optionally type-filtered) using a matching evolution from the deck, reshuffle. */
  massEvolveBenchFromDeck?: { type?: string };
  /** Discard every Special Energy attached anywhere on the opponent's field. */
  discardAllOpponentFieldSpecialEnergy?: boolean;
  /** Reveal the top N deck cards; every Energy among them attaches to a random own Pokémon,
   * the rest are shuffled back. */
  revealTopAttachEnergiesCount?: number;
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
  /** Every attached Energy CARD's printed name (not just its EnergyType) — for conditions keyed
   * to a specific named Special Energy (e.g. "火箭隊能量") rather than a basic type. */
  attackerEnergyCardNames: string[];
  /** The defender's own current damage counters, ONE ENTRY PER own-Bench Pokémon (order matches
   * `ownBenchNames`/`ownBenchTypes`'s own-side convention, but for the OPPONENT's Bench) — for
   * "damage to 1 Bench Pokémon equal to ITS OWN counters" texts, which the aggregate opponent
   * counts elsewhere in this interface can't express. */
  opponentBenchDamageCounters: number[];
  /** Every one of the defender's own printed attack names (for "choose one of the defending
   * Pokémon's attacks and lock it" texts — auto-picked randomly, same convention as every other
   * "player's choice" template in this file). */
  defenderAttackNames: string[];
  /** Whether the defending Pokémon is a 太晶 (Tera) print — see hasTeraBenchedImmunity. */
  defenderIsTera: boolean;
  /** True when this side had a Pokémon faint during the opponent's last turn (any cause — the
   * same lastPokemonFaintedTurn simplification 八朔/鏽蝕組手下 document). */
  ownPokemonFaintedLastTurn: boolean;
  /** The defender's current Special Conditions (English names, e.g. 'Poisoned'). */
  defenderStatusConditions: string[];
  /** The defender's printed card name. */
  defenderName: string;
  /** The attacker's own hand size (the attack card user's side). */
  ownHandCount: number;
  /** Every card name currently in the attacker's own hand (for printed hand-cost checks). */
  ownHandNames: string[];
  /** Every own in-play Pokémon's printed name (active + bench). */
  ownFieldNames: string[];
  /** Every opponent in-play Pokémon's printed name (active + bench). */
  opponentFieldNames: string[];
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

/** A shape-only stand-in board (every count 0, every list empty) — safe to feed to
 * `resolveGenericAttackEffect` purely to ask "does ANY template recognize this text", without
 * needing a real game state. Kept as the single source of truth for "is this text coverable" so
 * this check can never drift from what actually runs during a battle — the old approach (a
 * hand-maintained `TEMPLATES` regex list mirroring the resolver's own inline patterns) silently
 * fell out of sync as new templates were added to the resolver but not back-ported here, which
 * made coverage tooling under-report cards whose attacks actually already worked in real games
 * (e.g. 超級沙奈朵ex's 盈溢祈願 — resolved correctly, but reported as uncovered). */
export const NEUTRAL_BOARD: AttackBoardContext = {
  ownFieldPokemonCount: 0, ownToolCount: 0, selfDamageCounters: 0, opponentEnergyCount: 0,
  opponentDamageCounters: 0, ownBenchCount: 0, opponentBenchCount: 0, ownRemainingPrizes: 0,
  opponentRemainingPrizes: 0, defenderStatusConditionCount: 0, defenderIsBurned: false,
  defenderIsEx: false, attackerEnergyCounts: {}, ownBenchTypes: [], attackerTotalEnergyCount: 0,
  bothActiveEnergyCount: 0, ownDiscardCardNames: [], attackerEvolvesFrom: undefined,
  ownBenchNames: [], opponentDiscardBasicEnergyCount: 0, ownDeckCount: 0,
  ownFieldTotalEnergyCount: 0, ownFieldEnergyCounts: {}, defenderTypes: [], defenderSubtypes: [],
  defenderEvolvesFrom: undefined, defenderIsConfused: false, defenderRetreatCost: 0,
  opponentFieldTypes: [], opponentHasFutureSubtype: false, opponentHandCount: 0,
  ownFieldBasicCount: 0, hasActiveStadium: false, ownFieldTypeCounts: {},
  opponentFieldEnergyCounts: {}, opponentFieldTotalEnergyCount: 0, opponentExCount: 0,
  opponentExOrVCount: 0, ownDamagedBenchCount: 0, ownFieldDamagedCount: 0, ownBenchStage2Count: 0,
  ownBenchEnergyHolderCounts: {}, attackCostCount: 0, opponentTakenPrizes: 0,
  ownBenchDamageCountersByName: [], ownDiscardAbilityCounts: {},
  attackerPromotedFromBenchThisTurn: false, ownDiscardEnergyCounts: {},
  attackerEnergyCardNames: [], opponentBenchDamageCounters: [], defenderAttackNames: [],
  defenderIsTera: false, ownPokemonFaintedLastTurn: false, defenderStatusConditions: [],
  defenderName: '', ownHandCount: 0, ownHandNames: [], ownFieldNames: [], opponentFieldNames: [],
};

export function matchesGenericAttackTemplate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  try {
    return resolveGenericAttackEffect(t, '0', NEUTRAL_BOARD) !== undefined;
  } catch {
    // A template matched but choked on the neutral stand-in board (e.g. indexed into a name
    // that isn't there) — the text pattern IS recognized, so this still counts as covered.
    return true;
  }
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

  // 擲1次硬幣若為正面，則可將對手的戰鬥寶可夢【狀態】。("則可將" — optional even on heads, distinct from
  // the unconditional "則將" template above; the "若希望" convention elsewhere always takes an
  // optional upside, so heads always applies the status here too.)
  m = t.match(new RegExp(`^擲1次硬幣[，,]?若為正面，則可將對手的戰鬥寶可夢【(${STATUS_ALT})】。$`));
  if (m) {
    const heads = Math.random() < 0.5;
    const outcome: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField), coinFlipNote: heads ? '正面' : '反面' };
    if (heads) outcome.statusToInflict = [STATUS_ZH[m[1]]];
    return outcome;
  }

  // 對手的1隻寶可夢受到這隻寶可夢身上附加的能量的數量×N點傷害。[在備戰區不計算弱點・抵抗力。]
  // ("1隻寶可夢", not "1隻備戰寶可夢" — real rules let the player pick Active OR Bench, with the
  // bracket only clarifying the Bench case skips weakness/resistance; simplified to always
  // targeting the Active through the normal weakness/resistance pipeline, matching how every
  // other dynamically-scaled "N energy x M damage" template here already resolves.)
  m = t.match(/^對手的1隻寶可夢受到這隻寶可夢身上附加的能量的數量×(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: board.attackerTotalEnergyCount * parseInt(m[1], 10) };

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

  // 在對手的戰鬥寶可夢身上放置N個傷害指示物。(斯魔茶::無聲加害)
  m = t.match(/^在對手的戰鬥寶可夢身上放置(\d+)個傷害指示物。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), placeCountersOnOpponentActive: parseInt(m[1], 10) };

  // 若自己的棄牌區有N張以上擁有特性「X」的寶可夢卡，則在對手的所有寶可夢身上各放置M個傷害指示物。
  // (來悲粗茶::抹茶旋濺 — same discard-pile condition as 破破舵輪::悔念錨 above, different payoff.)
  m = t.match(/^若自己的棄牌區有(\d+)張以上擁有特性「(.+?)」的寶可夢卡，則在對手的所有寶可夢身上各放置(\d+)個傷害指示物。$/);
  if (m) {
    const have = board.ownDiscardAbilityCounts[normalizeAbilityName(m[2])] || 0;
    return have >= parseInt(m[1], 10)
      ? { baseDamage: parseBaseNumber(damageField), placeCountersOnAllOpponent: parseInt(m[3], 10) }
      : { baseDamage: parseBaseNumber(damageField) };
  }

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

  // 將場上的競技場卡丟棄。若無法丟棄，則這個招式失敗。(fails outright — 0 damage — with no Stadium in play)
  if (/^將場上的競技場卡丟棄。若無法丟棄，則這個招式失敗。$/.test(t)) {
    return { baseDamage: board.hasActiveStadium ? parseBaseNumber(damageField) : 0, discardActiveStadium: true };
  }

  // 若場上沒有競技場卡，則這個招式失敗。(inverse of the above — needs an EXISTING Stadium to work at all)
  if (/^若場上沒有競技場卡，則這個招式失敗。$/.test(t)) {
    return { baseDamage: board.hasActiveStadium ? parseBaseNumber(damageField) : 0 };
  }

  // 若希望，選擇1張自己的反面朝上的獎賞卡，翻到正面。這個情況下，增加N點傷害。(the face-up prize itself
  // has no further gameplay effect in this engine — no hidden-information model for prizes — so
  // this is equivalent to always taking the optional bonus, matching the file's "若希望" convention.)
  m = t.match(/^若希望，選擇1張自己的反面朝上的獎賞卡，翻到正面。這個情況下，增加(\d+)點傷害。(?:（在對戰結束前，那張獎賞卡維持正面朝上。）)?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + parseInt(m[1], 10) };

  // 若對手的戰鬥寶可夢身上放置有傷害指示物，則這個招式的傷害改為「N」點。(REPLACES, not adds to, base damage)
  m = t.match(/^若對手的戰鬥寶可夢身上放置有傷害指示物，則這個招式的傷害改為「(\d+)」點。$/);
  if (m) return { baseDamage: board.opponentDamageCounters > 0 ? parseInt(m[1], 10) : parseBaseNumber(damageField) };

  // 造成自己已經獲得的獎賞卡的張數×N點傷害。(taken = 6 - remaining)
  m = t.match(/^造成自己已經獲得的獎賞卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: (6 - board.ownRemainingPrizes) * parseInt(m[1], 10) };

  // 若自己的備戰區有「X」「Y」，則增加N點傷害。(two specific named cards, both required — exact name,
  // not the substring match the single-name "有名稱中有「X」的寶可夢" template above uses)
  m = t.match(/^若自己的備戰區有「(.+?)」「(.+?)」，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownBenchNames.includes(m[1]) && board.ownBenchNames.includes(m[2]) ? parseInt(m[3], 10) : 0) };

  // 若自己的場上有與對手的場上寶可夢相同屬性的寶可夢，則增加N點傷害。(any own-field type overlapping ANY
  // of the opponent's Active's printed types — approximated via the defender's own types, which is
  // what "對手的場上寶可夢" resolves to for a single-Active engine like this one.)
  m = t.match(/^若自己的場上有與對手的場上寶可夢相同屬性的寶可夢，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderTypes.some(ty => (board.ownFieldTypeCounts[ty] || 0) > 0) ? parseInt(m[1], 10) : 0) };

  // 若這隻寶可夢身上附有【X】能量卡，則增加N點傷害。(attacker's OWN attached Energy of one type — distinct
  // from the "身上附加的能量的數量" scaling templates above; this is a flat bonus, not per-count)
  m = t.match(/^若這隻寶可夢身上附有【(.+?)】能量卡，則增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    return { baseDamage: parseBaseNumber(damageField) + (!!type && (board.attackerEnergyCounts[type] || 0) > 0 ? parseInt(m[2], 10) : 0) };
  }

  // 增加自己的棄牌區的能量卡的張數×N點傷害。(ALL Energy types combined, not one specific type)
  m = t.match(/^增加自己的棄牌區的能量卡的張數×(\d+)點傷害。$/);
  if (m) {
    const total = Object.values(board.ownDiscardEnergyCounts).reduce((a, b) => a + b, 0);
    return { baseDamage: parseBaseNumber(damageField) + total * parseInt(m[1], 10) };
  }

  // 若這隻寶可夢身上放置有傷害指示物，則增加N點傷害。(the ATTACKER's own damage counters — distinct from
  // the defender-damage-counter templates above)
  m = t.match(/^若這隻寶可夢身上放置有傷害指示物，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.selfDamageCounters > 0 ? parseInt(m[1], 10) : 0) };

  // 將最多N張自己的場上寶可夢身上附加的【X】能量卡丟棄，造成其張數×M點傷害。(field-wide, typed —
  // ownFieldEnergyDiscardScaledDamage already scans the attacker's whole field, not just itself)
  m = t.match(/^將最多(\d+)張自己的場上寶可夢身上附加的【(.+?)】能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: 0, ownFieldEnergyDiscardScaledDamage: { type, max: parseInt(m[1], 10), amount: parseInt(m[3], 10) } };
  }

  // 將這隻寶可夢身上附加的能量卡全部丟棄，對手的1隻備戰寶可夢也受到N點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^將這隻寶可夢身上附加的能量卡全部丟棄，對手的1隻備戰寶可夢也受到(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardAllSelfEnergy: true, benchSplashDamage: parseInt(m[1], 10) };

  // 從自己的牌庫選擇最多N張基本能量卡，附於自己的1隻寶可夢身上。並且重洗牌庫。(any type, not one fixed type
  // — deckSearchBasicEnergyToOwnPokemonCount already matches this shape exactly)
  m = t.match(/^從自己的牌庫選擇最多(\d+)張基本能量卡，附於自己的1隻寶可夢身上。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchBasicEnergyToOwnPokemonCount: parseInt(m[1], 10) };

  // 將自己的備戰區的1隻【X】寶可夢恢復「N」HP。
  m = t.match(/^將自己的備戰區的1隻【(.+?)】寶可夢恢復「(\d+)」HP。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), healBenchTypedAmount: { type, amount: parseInt(m[2], 10) } };
  }

  // 從自己的牌庫選擇與這隻寶可夢身上附加的基本能量卡相同屬性的寶可夢卡合計最多N張，在給對手看過後
  // 加入手牌。並且重洗牌庫。(the reveal-to-opponent step is cosmetic — no information-asymmetry model
  // for hands here — and "same type as attached Basic Energy" picks whichever type the attacker
  // actually has the most of when multiple are attached.)
  m = t.match(/^從自己的牌庫選擇與這隻寶可夢身上附加的基本能量卡相同屬性的寶可夢卡合計最多(\d+)張，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) {
    // Falls back to Colorless (0 real matches, a legitimate empty search) if no Energy happens
    // to be attached yet — this attack still has a cost, so real games always have some, but the
    // template must resolve to a defined outcome either way, not bail with `undefined`.
    const entries = Object.entries(board.attackerEnergyCounts);
    const type = entries.length > 0 ? entries.sort((a, b) => b[1] - a[1])[0][0] : 'Colorless';
    return { baseDamage: parseBaseNumber(damageField), deckSearchTypedPokemonToHandCount: { type, count: parseInt(m[1], 10) } };
  }

  // 選擇N個這隻寶可夢身上附加的能量，改附於1隻備戰寶可夢身上。
  m = t.match(/^選擇(\d+)個這隻寶可夢身上附加的能量，改附於1隻備戰寶可夢身上。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), moveSelfEnergyToRandomBenchCount: parseInt(m[1], 10) };

  // 將對手的戰鬥寶可夢【混亂】。選擇任意數量的對手的場上寶可夢身上放置的傷害指示物，以任意方式改放於
  // 對手的場上寶可夢身上。(the counter-redistribution is entirely among the OPPONENT's own field —
  // zero-sum for their total damage taken, so skipped as a documented simplification; the confuse
  // is the only externally-observable part.)
  if (/^將對手的戰鬥寶可夢【混亂】。選擇任意數量的對手的場上寶可夢身上放置的傷害指示物，以任意方式改放於對手的場上寶可夢身上。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), statusToInflict: ['Confused'] };
  }

  // 在對手的身上放置有傷害指示物的所有寶可夢身上，各放置N個傷害指示物。
  m = t.match(/^在對手的身上放置有傷害指示物的所有寶可夢身上，各放置(\d+)個傷害指示物。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), damageToEachDamagedOpponentAmount: parseInt(m[1], 10) };

  // 若希望，將最多N張自己的備戰寶可夢身上附加的能量卡丟棄，增加其張數×M點傷害。(field-wide, untyped)
  m = t.match(/^若希望，將最多(\d+)張自己的備戰寶可夢身上附加的能量卡丟棄，增加其張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), ownFieldEnergyDiscardScaledDamage: { max: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 若這隻寶可夢身上附有「X能量」，則增加N點傷害。(a specific NAMED Special Energy card, not a basic type)
  m = t.match(/^若這隻寶可夢身上附有「(.+?)能量」，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.attackerEnergyCardNames.includes(`${m[1]}能量`) ? parseInt(m[2], 10) : 0) };

  // 將自己的手牌全部丟棄，從牌庫抽出N張卡。(discard, not shuffle back — distinct from shuffleHandThenDrawCount)
  m = t.match(/^將自己的手牌全部丟棄，從牌庫抽出(\d+)張卡。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardHandThenDrawCount: parseInt(m[1], 10) };

  // 將這隻寶可夢身上附加的能量卡全部丟棄，對手的N隻寶可夢各受到M點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^將這隻寶可夢身上附加的能量卡全部丟棄，對手的(\d+)隻寶可夢各受到(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: 0, discardAllSelfEnergy: true, multiTargetOpponentFlatDamage: { count: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 選擇N次對手的寶可夢，對所選的所有寶可夢不計算弱點・抵抗力，造成其選擇次數×M點傷害。(1隻可選擇2次以上。)
  // (total output is choice-count-independent — simplified to 1 target taking the full combined total)
  m = t.match(/^選擇(\d+)次對手的寶可夢，對所選的所有寶可夢不計算弱點・抵抗力，造成其選擇次數×(\d+)點傷害。(?:（1隻可選擇2次以上。）)?$/);
  if (m) return { baseDamage: 0, multiTargetOpponentFlatDamage: { count: 1, amount: parseInt(m[1], 10) * parseInt(m[2], 10) } };

  // 在下個對手的回合，這隻寶可夢的弱點全部消除。
  if (/^在下個對手的回合，這隻寶可夢的弱點全部消除。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'weaknessRemoved', turnOffset: 1 } };
  }

  // 查看對手的手牌，從其中選擇1張卡，放回對手的牌庫下方。
  if (/^查看對手的手牌，從其中選擇1張卡，放回對手的牌庫下方。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), randomOpponentHandCardToDeckBottom: true };
  }

  // 若對手的戰鬥寶可夢身上放置的傷害指示物為N個，則將那隻寶可夢【昏厥】。
  m = t.match(/^若對手的戰鬥寶可夢身上放置的傷害指示物為(\d+)個，則將那隻寶可夢【昏厥】。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), koDefenderIfDamageCountersEqual: parseInt(m[1], 10) };

  // 對手的1隻備戰寶可夢，受到那隻寶可夢身上放置的傷害指示物的數量×N點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^對手的1隻備戰寶可夢，受到那隻寶可夢身上放置的傷害指示物的數量×(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), opponentBenchDamageScaledSplash: { multiplier: parseInt(m[1], 10) } };

  // 若希望，將1個這隻寶可夢身上附加的【X】能量放回手牌，增加N點傷害。
  m = t.match(/^若希望，將1個這隻寶可夢身上附加的【(.+?)】能量放回手牌，增加(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[1]];
    if (type) return { baseDamage: parseBaseNumber(damageField), returnSelfEnergyToHandTypeBonus: { type, amount: parseInt(m[2], 10) } };
  }

  // 將N個這隻寶可夢身上附加的能量丟棄，對手的M隻寶可夢各受到K點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^將(\d+)個這隻寶可夢身上附加的能量丟棄，對手的(\d+)隻寶可夢各受到(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: 0, discardSelfEnergyCount: parseInt(m[1], 10), multiTargetOpponentFlatDamage: { count: parseInt(m[2], 10), amount: parseInt(m[3], 10) } };

  // 若希望，選擇N個這隻寶可夢身上附加的能量，放回牌庫並重洗。這個情況下，對手的1隻備戰寶可夢也受到M點傷害。
  m = t.match(/^若希望，選擇(\d+)個這隻寶可夢身上附加的能量，放回牌庫並重洗。這個情況下，對手的1隻備戰寶可夢也受到(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), optionalEnergyToDeckForBenchDamage: { max: parseInt(m[1], 10), benchDamage: parseInt(m[2], 10) } };

  // 若使用了這個招式，則這隻寶可夢離開戰鬥場前無法使用「X」。(approximated as a next-own-turn lock —
  // real rule is "until this Pokémon leaves Active", which this engine's turn-numbered timed
  // effects can't express; a Pokémon that survives many consecutive turns in a row is rare enough
  // for the approximation to be a reasonable simplification.)
  m = t.match(/^若使用了這個招式，則這隻寶可夢離開戰鬥場前無法使用「(.+?)」。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'namedAttackLock', attackName: m[1], turnOffset: 2 } };

  // 選擇1個這隻寶可夢身上附加的能量，放回手牌。
  if (/^選擇1個這隻寶可夢身上附加的能量，放回手牌。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), returnSelfEnergyToHandCount: 1 };
  }

  // 選擇1個對手的戰鬥寶可夢持有的招式。在下個對手的回合，受到這個招式的寶可夢無法使用被選擇的招式。
  // (which attack is picked is the player's choice — auto-random among the defender's own printed
  // attacks, same convention as every other "player's choice" template in this file.)
  if (/^選擇1個對手的戰鬥寶可夢持有的招式。在下個對手的回合，受到這個招式的寶可夢無法使用被選擇的招式。$/.test(t)) {
    if (board.defenderAttackNames.length === 0) return { baseDamage: parseBaseNumber(damageField) };
    const pick = board.defenderAttackNames[Math.floor(Math.random() * board.defenderAttackNames.length)];
    return { baseDamage: parseBaseNumber(damageField), opponentTimedEffect: { kind: 'namedAttackLock', attackName: pick, turnOffset: 1 } };
  }

  // 選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。
  if (/^選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardRandomSelfHandCount: 1, discardRandomOpponentHandCount: 1 };
  }

  // 選擇2隻對手的備戰寶可夢，將那些寶可夢與附加的卡全部放回牌庫並重洗。在上個自己的回合，若自己的寶可夢
  // 使出了「X」，則無法使用這個招式。(the "can't reuse last-turn" self-gate is approximated the same
  // way as the 烈火爆進-style locks above: a next-own-turn lock set whenever this attack fires.)
  m = t.match(/^選擇2隻對手的備戰寶可夢，將那些寶可夢與附加的卡全部放回牌庫並重洗。在上個自己的回合，若自己的寶可夢使出了「(.+?)」，則無法使用這個招式。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), shuffleOpponentBenchToDeckCount: 2, selfTimedEffect: { kind: 'namedAttackLock', attackName: m[1], turnOffset: 2 } };

  // 將自己的所有備戰寶可夢各恢復「N」HP。(BENCH only, not the Active — distinct from healAllOwnTeamAmount)
  m = t.match(/^將自己的所有備戰寶可夢各恢復「(\d+)」HP。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), healAllOwnBenchAmount: parseInt(m[1], 10) };

  // 對手的2隻寶可夢各受到N點傷害。這個招式的傷害不計算弱點・抵抗力與受到傷害的寶可夢身上的附加效果。
  m = t.match(/^對手的2隻寶可夢各受到(\d+)點傷害。這個招式的傷害不計算弱點・抵抗力與受到傷害的寶可夢身上的附加效果。$/);
  if (m) return { baseDamage: 0, multiTargetOpponentFlatDamage: { count: 2, amount: parseInt(m[1], 10) } };

  // 擲硬幣直到出現反面，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。
  if (/^擲硬幣直到出現反面，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), flipUntilTailsDiscardOpponentEnergy: true };
  }

  // 將這隻寶可夢身上附加的能量卡全部放回牌庫並重洗，對手的1隻寶可夢受到N點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^將這隻寶可夢身上附加的能量卡全部放回牌庫並重洗，對手的1隻寶可夢受到(\d+)點傷害。(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseInt(m[1], 10), shuffleAllSelfEnergyToDeck: true };

  // 從自己的牌庫任意選擇N張卡。重洗剩餘牌庫，將所選的卡以任意順序排列，放回牌庫上方。
  m = t.match(/^從自己的牌庫任意選擇(\d+)張卡。重洗剩餘牌庫，將所選的卡以任意順序排列，放回牌庫上方。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchAnyCardsToTopOfDeck: parseInt(m[1], 10) };

  // 若對手的戰鬥寶可夢為「太晶」寶可夢，則增加N點傷害。
  m = t.match(/^若對手的戰鬥寶可夢為「太晶」寶可夢，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.defenderIsTera ? parseInt(m[1], 10) : 0) };

  // 對手選擇N張對手自己的手牌，放回牌庫並重洗。
  m = t.match(/^對手選擇(\d+)張對手自己的手牌，放回牌庫並重洗。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), shuffleRandomOpponentHandCardsIntoDeckCount: parseInt(m[1], 10) };

  // 擲N次硬幣，選擇與反面出現的次數相同數量的這隻寶可夢身上附加的能量，將其丟棄。
  m = t.match(/^擲(\d+)次硬幣，選擇與反面出現的次數相同數量的這隻寶可夢身上附加的能量，將其丟棄。$/);
  if (m) {
    const tails = parseInt(m[1], 10) - flipCoins(parseInt(m[1], 10));
    return { baseDamage: parseBaseNumber(damageField), flipCoinsDiscardSelfEnergyByTailsCount: tails };
  }

  // 雙方的所有備戰寶可夢也各受到N點傷害。 [在備戰區不計算弱點・抵抗力。](BOTH sides' whole Bench)
  m = t.match(/^雙方的所有備戰寶可夢也各受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfAllBenchSplashDamage: parseInt(m[1], 10), opponentAllBenchSplashDamage: parseInt(m[1], 10) };

  /* ---- Standard-wide coverage push: clause-level matchers. Each also serves as a building
   * block for the clause-composition fallback below. ---- */

  // 查看對手的手牌。(reveal only — the engine has no hidden-information model, so a no-op)
  if (/^查看對手的手牌。$/.test(t)) return { baseDamage: parseBaseNumber(damageField) };

  // 只要這隻寶可夢在備戰區，不會受到招式的傷害。— the Tera MARKER pseudo-attack. Its behavior
  // lives in hasTeraBenchedImmunity/isTeraPokemon; recognized here so audits count it handled.
  // canAttack refuses to offer the damage-less marker as a usable attack (it isn't one); printed
  // damage is preserved so a synthetic damage+marker attack still hits.
  if (/^只要這隻寶可夢在備戰區，不會受到招式的傷害。$/.test(t)) return { baseDamage: parseBaseNumber(damageField) };

  // 這個招式的傷害不計算弱點・抵抗力。
  if (/^這個招式的傷害不計算弱點・抵抗力。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), ignoreWeakness: true, ignoreResistance: true };
  }

  // 這個招式在先攻玩家的最初回合也可使用。/ 這個招式可在先攻玩家的最初回合使用。/
  // 這個招式只可在後攻玩家的最初回合使用。— play-timing properties enforced in canAttack
  // (which reads the printed text directly); resolved as no-ops here.
  if (/^這個招式(?:在先攻玩家的最初回合也可使用|可在先攻玩家的最初回合使用|只可在後攻玩家的最初回合使用)。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 在上個對手的回合，若自己的(「X」)寶可夢因招式的傷害而【昏厥】了，則增加N點傷害。
  // (lastPokemonFaintedTurn records every KO cause — attack-cause and family-name restrictions
  // are the same documented simplification 八朔/鏽蝕組手下 already use.)
  m = t.match(/^在上個對手的回合，若自己的(?:「.+?」|寶可夢)因招式的傷害而【昏厥】了，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownPokemonFaintedLastTurn ? parseInt(m[1], 10) : 0) };

  // 若自己的備戰寶可夢身上放置有傷害指示物，則增加N點傷害。
  m = t.match(/^若自己的備戰寶可夢身上放置有傷害指示物，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownDamagedBenchCount > 0 ? parseInt(m[1], 10) : 0) };

  // 若對手的戰鬥寶可夢【狀態】，則增加N點傷害。
  m = t.match(new RegExp(`^若對手的戰鬥寶可夢【(${STATUS_ALT})】，則增加(\\d+)點傷害。$`));
  if (m) {
    const has = board.defenderStatusConditions.includes(STATUS_ZH[m[1]]);
    return { baseDamage: parseBaseNumber(damageField) + (has ? parseInt(m[2], 10) : 0) };
  }

  // 若對手的戰鬥寶可夢為「X」，則增加N點傷害。(exact defender name)
  m = t.match(/^若對手的戰鬥寶可夢為「(.+?)」，則增加(\d+)點傷害。$/);
  if (m && !m[1].includes('太晶')) {
    return { baseDamage: parseBaseNumber(damageField) + (board.defenderName.includes(m[1].replace(/【ex】$/, 'ex')) ? parseInt(m[2], 10) : 0) };
  }

  // 若自己的備戰區有「X」，則增加N點傷害。
  m = t.match(/^若自己的備戰區有「(.+?)」，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.ownBenchNames.some(n => n.includes(m![1])) ? parseInt(m[2], 10) : 0) };

  // 若場上有競技場卡，則增加N點傷害。
  m = t.match(/^若場上有競技場卡，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.hasActiveStadium ? parseInt(m[1], 10) : 0) };

  // 若這隻寶可夢與對手的戰鬥寶可夢身上附加的能量數量相同，則增加N點傷害。
  m = t.match(/^若這隻寶可夢與對手的戰鬥寶可夢身上附加的能量數量相同，則增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (board.attackerTotalEnergyCount === board.opponentEnergyCount ? parseInt(m[1], 10) : 0) };

  // 增加對手已經獲得的獎賞卡的張數×N點傷害。
  m = t.match(/^增加對手已經獲得的獎賞卡的張數×(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + (6 - board.opponentRemainingPrizes) * parseInt(m[1], 10) };

  // 將最多N張這隻寶可夢身上附加的【T】能量卡丟棄，造成其張數×M點傷害。
  m = t.match(/^將最多(\d+)張這隻寶可夢身上附加的【(.+?)】能量卡丟棄，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), selfEnergyDiscardScaledDamage: { type, max: parseInt(m[1], 10), amount: parseInt(m[3], 10) } };
  }

  // 選擇N個對手的戰鬥寶可夢身上附加的特殊能量，將其丟棄。
  m = t.match(/^選擇(\d+)個對手的戰鬥寶可夢身上附加的特殊能量，將其丟棄。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardOpponentSpecialEnergyCount: parseInt(m[1], 10) };

  // 若希望，選擇N個對手的戰鬥寶可夢身上附加的能量，放回對手的手牌。(auto-taken)
  m = t.match(/^(?:若希望，)?選擇(\d+)個對手的戰鬥寶可夢身上附加的能量，放回對手的手牌。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), returnOpponentEnergyToHandCount: parseInt(m[1], 10) };

  // 自己的N隻備戰寶可夢也受到M點傷害。[在備戰區不計算弱點・抵抗力。]
  m = t.match(/^自己的(\d+)隻備戰寶可夢也(?:各)?受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), multiTargetSelfBenchFlatDamage: { count: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 對手的N隻備戰寶可夢也各受到M點傷害。[...] (bench-only, N picks)
  m = t.match(/^對手的(\d+)隻備戰寶可夢也各受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), multiTargetOpponentBenchFlatDamage: { count: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 對手的N隻寶可夢各受到M點傷害。[...] (active+bench pool)
  m = t.match(/^對手的(\d+)隻寶可夢(?:也)?各受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), multiTargetOpponentFlatDamage: { count: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 對手的身上放置有傷害指示物的N隻備戰寶可夢也受到M點傷害。[...] (damaged-bench-only picks)
  m = t.match(/^對手的身上放置有傷害指示物的(\d+)隻備戰寶可夢也(?:各)?受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), multiTargetOpponentDamagedBenchFlatDamage: { count: parseInt(m[1], 10), amount: parseInt(m[2], 10) } };

  // 在下個自己的回合，這隻寶可夢「招式名」的傷害「+N」點。(named-attack restriction simplified
  // to a general next-own-turn outgoing boost — the holder rarely has another attack worth using.)
  m = t.match(/^在下個自己的回合，這隻寶可夢「.+?」的傷害「\+(\d+)」點。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'outgoingDamageBoost', amount: parseInt(m[1], 10), turnOffset: 2 } };

  // 從自己的棄牌區選擇(最多)N張「X」卡，附於這隻寶可夢身上。(named Energy from discard to self)
  m = t.match(/^從自己的棄牌區選擇(?:最多)?(\d+)張「(.+?)」卡，附於這隻寶可夢身上。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardPileSearchNamedToSelfCount: { name: m[2], count: parseInt(m[1], 10) } };

  // 選擇N個這隻寶可夢身上附加的【T】能量，將其丟棄。(typed self-discard — random among that type)
  m = t.match(/^選擇(\d+)個這隻寶可夢身上附加的【(.+?)】能量，將其丟棄。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), discardSelfTypedEnergy: { type, count: parseInt(m[1], 10) } };
  }

  /* ---- Round 2 of the coverage push ---- */

  // 若希望，增加N點傷害。(optional bonus — auto-taken; any cost sits in its own clause)
  m = t.match(/^若希望，增加(\d+)點傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField) + parseInt(m[1], 10) };

  // Continuation halves of reveal-type sentences — the revealing clause carries the semantics.
  if (/^(?:然後，)?將(?:剩餘卡|翻到正面的卡|給對手看過的能量卡)放回牌庫並重洗。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 然後，從(自己的)牌庫抽出N張卡。(the bare form has its own template above)
  m = t.match(/^然後，從(?:自己的)?牌庫抽出(\d+)張卡。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), drawCards: parseInt(m[1], 10) };

  // 擲N次硬幣。若出現K次(以上)?正面，則增加M點傷害。
  m = t.match(/^擲(\d+)次硬幣。若出現(\d+)次(?:以上)?正面，則增加(\d+)點傷害。$/);
  if (m) {
    const heads = flipCoins(parseInt(m[1], 10));
    const hit = heads >= parseInt(m[2], 10);
    return { baseDamage: parseBaseNumber(damageField) + (hit ? parseInt(m[3], 10) : 0), coinFlipNote: `${heads}次正面` };
  }

  // 擲1次硬幣若為正面，則將對手的戰鬥寶可夢【A】與【B】。(two conditions at once)
  m = t.match(new RegExp(`^擲1次硬幣[，,]?若為正面，則將對手的戰鬥寶可夢【(${STATUS_ALT})】與【(${STATUS_ALT})】。$`));
  if (m) {
    const heads = Math.random() < 0.5;
    const outcome: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField), coinFlipNote: heads ? '正面' : '反面' };
    if (heads) outcome.statusToInflict = [STATUS_ZH[m[1]], STATUS_ZH[m[2]]];
    return outcome;
  }

  // 若自己的手牌不是N張，則這個招式失敗。
  m = t.match(/^若自己的手牌不是(\d+)張，則這個招式失敗。$/);
  if (m) return { baseDamage: board.ownHandCount === parseInt(m[1], 10) ? parseBaseNumber(damageField) : 0 };

  // 擲硬幣直到出現反面，將對手的牌庫上方與正面出現的次數相同數量的卡丟棄。
  if (/^擲硬幣直到出現反面，將對手的牌庫上方與正面出現的次數相同數量的卡丟棄。$/.test(t)) {
    let heads = 0;
    while (Math.random() < 0.5) heads++;
    return { baseDamage: parseBaseNumber(damageField), millOpponentDeckCount: heads, coinFlipNote: `${heads}次正面` };
  }

  // 在給對手看過自己的棄牌區的所有「X」卡後，造成其張數×N點傷害。
  m = t.match(/^在給對手看過自己的棄牌區的所有「(.+?)」卡後，造成其張數×(\d+)點傷害。$/);
  if (m) {
    const n = board.ownDiscardCardNames.filter(x => x.includes(m![1])).length;
    return { baseDamage: n * parseInt(m[2], 10) };
  }

  // 造成雙方的場上的，名稱中有「X」或者「Y」的寶可夢的數量×N點傷害。
  m = t.match(/^造成雙方的場上的，名稱中有「(.+?)」(?:或者「(.+?)」)?的寶可夢的數量×(\d+)點傷害。$/);
  if (m) {
    const names = [...board.ownFieldNames, ...board.opponentFieldNames];
    const n = names.filter(x => x.includes(m![1]) || (m![2] && x.includes(m![2]))).length;
    return { baseDamage: n * parseInt(m[3], 10) };
  }

  // 查看自己的牌庫上方N張卡，從其中選擇任意數量的寶可夢卡，放置於備戰區。將剩餘卡放回牌庫並重洗。
  m = t.match(/^查看自己的牌庫上方(\d+)張卡，從其中選擇任意數量的寶可夢卡，放置於備戰區。將剩餘卡放回牌庫並重洗。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), revealTopBenchPokemonCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇(最多)N張「X」卡，(以任意方式)附於(自己的寶可夢|備戰寶可夢)身上。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇(?:最多)?(\d+)張「(.+?)」卡，(?:以任意方式)?附於(自己的寶可夢|備戰寶可夢)身上。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchNamedEnergyAttachCount: { name: m[2], count: parseInt(m[1], 10), benchOnly: m[3] === '備戰寶可夢' } };

  // 從自己的牌庫選擇(最多)N張基本能量卡，在給對手看過後加入手牌。並且重洗牌庫。(bare-count variant
  // of the 最多-only template above)
  m = t.match(/^從自己的牌庫選擇(\d+)張基本能量卡，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchBasicEnergyToHandCount: parseInt(m[1], 10) };

  // 從自己的牌庫選擇最多N張【T】寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。
  m = t.match(/^從自己的牌庫選擇最多(\d+)張【(.+?)】寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), deckSearchTypedPokemonToHandCount: { type, count: parseInt(m[1], 10) } };
  }

  // 若希望，從自己的牌庫任意選擇最多N張卡加入手牌。並且重洗牌庫。
  m = t.match(/^若希望，從自己的牌庫任意選擇最多(\d+)張卡加入手牌。並且重洗牌庫。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), deckSearchAnyCardsToHandCount: parseInt(m[1], 10) };

  // 在下個對手的回合，這隻寶可夢受到招式的傷害時，在使用招式的寶可夢身上放置N個傷害指示物。
  m = t.match(/^在下個對手的回合，這隻寶可夢受到招式的傷害時，在使用招式的寶可夢身上放置(\d+)個傷害指示物。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'retaliationCounters', amount: parseInt(m[1], 10), turnOffset: 1 } };

  // 在下個對手的回合，這隻寶可夢不會受到「N」以下的招式的傷害。
  m = t.match(/^在下個對手的回合，這隻寶可夢不會受到「(\d+)」以下的招式的傷害。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'damageImmune', maxImmuneDamage: parseInt(m[1], 10), turnOffset: 1 } };

  // 因這個【中毒】而放置的傷害指示物的數量改為N個。(composes with the plain Poison clause)
  m = t.match(/^因這個【中毒】而放置的傷害指示物的數量改為(\d+)個。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), poisonCounterOverride: parseInt(m[1], 10) };

  // 對手的所有「X」各受到N點傷害。/ 對手的備戰區的N隻「X」也受到M點傷害。[...]
  m = t.match(/^對手的所有「(.+?)」(?:也)?各受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), opponentNamedFlatDamage: { name: m[1], amount: parseInt(m[2], 10), count: 99 } };
  m = t.match(/^對手的備戰區的(\d+)隻「(.+?)」也(?:各)?受到(\d+)點傷害。\s*(?:\[在備戰區不計算弱點・抵抗力。\])?$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), opponentNamedFlatDamage: { name: m[2].replace(/【ex】・【V】/, ''), amount: parseInt(m[3], 10), count: parseInt(m[1], 10), benchOnly: true } };

  // 若希望，將這隻寶可夢放回手牌。（寶可夢以外的卡全部丟棄。）
  if (/^若希望，將這隻寶可夢放回手牌。（寶可夢以外的卡全部丟棄。）$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), returnSelfToHandDiscardAttachments: true };
  }

  // 選擇N隻自己的備戰區的「X」，將所選的寶可夢身上放置的傷害指示物，全部改放於對手的戰鬥寶可夢身上。
  m = t.match(/^選擇(\d+)隻自己的備戰區的「(.+?)」，將所選的寶可夢身上放置的傷害指示物，全部改放於對手的戰鬥寶可夢身上。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), moveNamedBenchDamageToDefender: { name: m[2], count: parseInt(m[1], 10) } };

  // 在對手的N隻寶可夢身上放置M個傷害指示物。
  m = t.match(/^在對手的(\d+)隻寶可夢身上(?:各)?放置(\d+)個傷害指示物。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), placeCountersOnMultipleOpponents: { count: parseInt(m[1], 10), counters: parseInt(m[2], 10) } };

  // 在對手的戰鬥寶可夢身上放置傷害指示物直到剩餘HP變為「N」為止。
  m = t.match(/^在對手的戰鬥寶可夢身上放置傷害指示物直到剩餘HP變為「(\d+)」為止。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), setDefenderRemainingHp: parseInt(m[1], 10) };

  // 從自己的棄牌區選擇最多N張【T】寶可夢卡，放置於備戰區。
  m = t.match(/^從自己的棄牌區選擇最多(\d+)張【(.+?)】寶可夢卡，放置於備戰區。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), discardPileSearchTypedPokemonToBenchCount: { type, count: parseInt(m[1], 10) } };
  }

  // 從自己的手牌將N張「X」卡丟棄。若無法丟棄(N張卡)?，則這個招式失敗。
  m = t.match(/^從自己的手牌將(\d+)張「(.+?)」卡丟棄。若無法丟棄(?:\d+張卡)?，則這個招式失敗。$/);
  if (m) {
    const need = parseInt(m[1], 10);
    const have = board.ownHandNames.filter(x => x.includes(m![2])).length;
    if (have < need) return { baseDamage: 0 };
    return { baseDamage: parseBaseNumber(damageField), discardNamedFromHandCount: { name: m[2], count: need } };
  }

  // 從自己的牌庫，選擇自己的所有備戰寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。
  if (/^從自己的牌庫，選擇自己的所有備戰寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), massEvolveBenchFromDeck: {} };
  }
  // 選擇最多N隻自己的【T】寶可夢，從自己的牌庫選擇從那些寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。
  m = t.match(/^選擇最多(\d+)隻自己的【(.+?)】寶可夢，從自己的牌庫選擇從那些寶可夢進化而來的卡各1張，放置於各自身上完成進化。並且重洗牌庫。$/);
  if (m) {
    const type = ENERGY_TYPE_FROM_ZH[m[2]];
    if (type) return { baseDamage: parseBaseNumber(damageField), massEvolveBenchFromDeck: { type } };
  }

  // 若對手的寶可夢因這個招式的傷害而【昏厥】了，則在下個對手的回合，這隻寶可夢不會受到招式的傷害與效果的影響。
  // (approximated as damage immunity — the timed system has no combined effect-immunity kind)
  if (/^若對手的寶可夢因這個招式的傷害而【昏厥】了，則在下個對手的回合，這隻寶可夢不會受到招式的傷害(?:與效果)?的影響。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfProtectNextTurnIfKo: true };
  }

  /* ---- Round 3: cheap standalone clauses ---- */

  // 將自己的N張手牌丟棄。(player's choice of which — auto-random per this file's convention)
  m = t.match(/^將自己的(\d+)張手牌丟棄。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), discardRandomSelfHandCount: parseInt(m[1], 10) };

  // 將這隻寶可夢恢復「N」HP。(some prints carry a stray leading zero-width char)
  m = t.match(/^[‌​]*將這隻寶可夢恢復「(\d+)」HP。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), healSelfAmount: parseInt(m[1], 10) };

  // 在下個自己的回合，這隻寶可夢無法撤退。
  if (/^在下個自己的回合，這隻寶可夢無法撤退。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), selfTimedEffect: { kind: 'cantRetreat', turnOffset: 2 } };
  }

  // 擲N次硬幣，將對手的牌庫上方與正面出現的次數相同數量的卡丟棄。
  m = t.match(/^擲(\d+)次硬幣，將對手的牌庫上方與正面出現的次數相同數量的卡丟棄。$/);
  if (m) {
    const heads = flipCoins(parseInt(m[1], 10));
    return { baseDamage: parseBaseNumber(damageField), millOpponentDeckCount: heads, coinFlipNote: `${heads}次正面` };
  }

  // 將對手的所有寶可夢身上附加的特殊能量卡全部丟棄。
  if (/^將對手的所有寶可夢身上附加的特殊能量卡全部丟棄。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField), discardAllOpponentFieldSpecialEnergy: true };
  }

  // 選擇N張對手的反面朝上的獎賞卡，查看那張卡的正面後，回復原樣。(peek — no hidden-info model)
  if (/^選擇\d+張對手的反面朝上的獎賞卡，查看那張卡的正面後，回復原樣。$/.test(t)) {
    return { baseDamage: parseBaseNumber(damageField) };
  }

  // 查看自己的牌庫上方N張卡，從其中選擇任意數量的能量卡，以任意方式附於自己的寶可夢身上。將剩餘卡放回牌庫並重洗。
  m = t.match(/^查看自己的牌庫上方(\d+)張卡，從其中選擇任意數量的能量卡，以任意方式附於自己的寶可夢身上。將剩餘卡放回牌庫並重洗。$/);
  if (m) return { baseDamage: parseBaseNumber(damageField), revealTopAttachEnergiesCount: parseInt(m[1], 10) };

  /* ---- Round 3: general recursive combinators. Each strips a modal/timing wrapper and
   * resolves the remainder through this same resolver (strictly shorter text — terminates).
   * They sit AFTER every specific template so an exact match always wins first. ---- */

  // 擲1次硬幣若為正面，則(rest) — heads runs the rest, tails does nothing beyond the base.
  m = t.match(/^擲1次硬幣[，,]?若為正面，則(.+)$/);
  if (m) {
    const rest = resolveGenericAttackEffect(m[1], '0', board);
    if (rest) {
      const heads = Math.random() < 0.5;
      const base = parseBaseNumber(damageField);
      if (!heads) return { baseDamage: base, coinFlipNote: '反面' };
      return { ...rest, baseDamage: base + rest.baseDamage, coinFlipNote: rest.coinFlipNote ? `正面；${rest.coinFlipNote}` : '正面' };
    }
  }

  // 擲N次硬幣若為反面，則這個招式失敗。若為正面，則(rest) — the all-or-nothing flip.
  m = t.match(/^擲1次硬幣若為反面，則這個招式失敗。若為正面，則(.+)$/);
  if (m) {
    const rest = resolveGenericAttackEffect(m[1], '0', board);
    if (rest) {
      const heads = Math.random() < 0.5;
      if (!heads) return { baseDamage: 0, coinFlipNote: '反面（招式失敗）' };
      return { ...rest, baseDamage: parseBaseNumber(damageField) + rest.baseDamage, coinFlipNote: '正面' };
    }
  }

  // 若希望，增加N點傷害。這個情況下，(consequence) — optional boost with a rider, auto-taken.
  m = t.match(/^若希望，增加(\d+)點傷害。這個情況下，(.+)$/);
  if (m) {
    const rest = resolveGenericAttackEffect(m[2], '0', board);
    if (rest) return { ...rest, baseDamage: parseBaseNumber(damageField) + parseInt(m[1], 10) + rest.baseDamage };
  }

  // 若希望，(rest) — optional, auto-taken (the file's standing convention).
  m = t.match(/^若希望，(.+)$/);
  if (m) {
    const rest = resolveGenericAttackEffect(m[1], damageField, board);
    if (rest) return rest;
  }

  // 在造成傷害前，(rest) — ordering prefix; applyAttackOutcome applies signals in its own fixed
  // order regardless, so the wrapper is transparent here.
  m = t.match(/^在造成傷害前，(.+)$/);
  if (m) {
    const rest = resolveGenericAttackEffect(m[1], damageField, board);
    if (rest) return rest;
  }

  // ---- Clause-composition fallback: any text whose 。-separated clauses (bracket-aware) each
  // resolve on their own composes into one merged outcome. Runs LAST so every whole-text
  // template above keeps winning unchanged; a clause that no template knows keeps the whole
  // text uncovered rather than half-resolving it.
  const composed = composeClauses(t, damageField, board);
  if (composed) return composed;

  return undefined;
}

/** Bracket-aware 。-split: a 。 inside 【】/[]/（）/「」 never ends a clause, and the two pure
 * continuation fragments (「並且重洗牌庫。」, a leading bracket annotation) weld back onto their
 * predecessor — the deck-search templates embed those tails in their own regexes. */
function splitClauses(t: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of t) {
    cur += ch;
    if ('【[（「'.includes(ch)) depth++;
    else if ('】]）」'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '。' && depth === 0) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  const welded: string[] = [];
  for (const c of out) {
    if (welded.length > 0 && (c === '並且重洗牌庫。' || /^[\[（]/.test(c))) welded[welded.length - 1] += c;
    else welded.push(c);
  }
  return welded;
}

/** Cross-clause references whose meaning can't survive independent clause resolution — a text
 * containing any of these outside its first clause must NOT be composed. 然後/其中 clauses are
 * deliberately NOT blanket-blocked: the benign ones (draw N, rest-back-and-shuffle) have their
 * own standalone matchers, and any other keeps the text uncovered simply by not matching. */
const CROSS_CLAUSE_REF = /這個情況下|若為正面|若為反面|那(?:張|隻|些)|所選的/;

function composeClauses(t: string, damageField: string, board: AttackBoardContext): GenericAttackOutcome | undefined {
  const clauses = splitClauses(t);
  if (clauses.length < 2) return undefined;
  if (clauses.slice(1).some(c => CROSS_CLAUSE_REF.test(c))) return undefined;
  const parts: GenericAttackOutcome[] = [];
  for (const c of clauses) {
    // damageField '0' so each part reports only its own contribution — the printed base is
    // added exactly once by the merge below.
    const part = resolveGenericAttackEffect(c, '0', board);
    if (!part) return undefined;
    parts.push(part);
  }
  const merged: GenericAttackOutcome = { baseDamage: parseBaseNumber(damageField) };
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      if (k === 'baseDamage') { merged.baseDamage += v as number; continue; }
      if (k === 'coinFlipNote') { merged.coinFlipNote = merged.coinFlipNote ? `${merged.coinFlipNote}；${v}` : v as string; continue; }
      if (k === 'statusToInflict') { merged.statusToInflict = [...(merged.statusToInflict ?? []), ...(v as StatusCondition[])]; continue; }
      // The same signal set twice means the clauses overlap in a way the flat outcome can't
      // express — bail out and leave the text uncovered rather than dropping half an effect.
      if ((merged as unknown as Record<string, unknown>)[k] !== undefined) return undefined;
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}
