import { GameCard, TurnAction, PendingChoice } from '@ptcg/shared';

export type { PendingChoice };

export interface PtcgPlayerState {
  deck: GameCard[];
  hand: GameCard[];
  bench: (GameCard | null)[];
  active: GameCard | null;
  discardPile: GameCard[];
  prizes: GameCard[];
  takenPrizes: number;
  /** Prize cards redirected here instead of hand by an opponent's "放逐區障礙"-style ability — permanently out of the game. */
  exileZone: GameCard[];
  energyAttachedThisTurn: number;
  basicPokemonPlayedThisTurn: number;
  supporterPlayedThisTurn: boolean;
  /** Names of every Supporter card played this turn — 供 family-scoped "if you played a X-named
   * Supporter this turn" conditions (e.g. 火箭隊的工廠 Stadium) that a plain boolean can't answer. */
  supporterNamesPlayedThisTurn: string[];
  pokemonPlayedThisTurn: string[];
  cardsPlayedThisTurn: number;
  /** Instance ids of Pokémon whose once-per-turn ability has already been used this turn. */
  abilitiesUsedThisTurn: string[];
  /** 祭典樂舞-style "attack twice" abilities: whether the bonus second attack has been used this turn. */
  usedBonusAttackThisTurn: boolean;
  /** "This turn, your X Pokémon's attacks deal +N to the opponent's active" Item/Supporter effects (e.g. 力量蛋白飲). */
  turnDamageBoosts: { typeFilter?: string; vsBigOnly?: boolean; excludeRuleBoxAttacker?: boolean; amount: number }[];
  /** 白蕾雅-style "your next KO this turn gives N extra prizes" count (0 = none). */
  bonusPrizeNextKo: number;
  /** 阿蜜的目光 / 鐵之防禦強化-style "damage you take next opponent-turn is reduced" — set on the
   * PROTECTED side, consumed naturally since it's cleared at that side's own next turn-begin
   * (the same reset pass that clears turnDamageBoosts etc.), which lands right after the one
   * opponent turn it's meant to cover. */
  incomingDamageReduction: { typeFilter?: string; amount: number }[];
  /** "在下個對手的回合，對手無法從手牌使出物品卡"-style timed Item-lock — an absolute G.turn
   * number, active while G.turn === this value (same single-turn-exact pattern as GameCard's
   * timedEffects). Set on the LOCKED side (the attacker's opponent), so validation just checks
   * the locked player's own field. */
  itemLockedUntilTurn: number | null;
  /** 霍米加的演奏-style "opponent's Poisoned Pokémon can't retreat next turn (including newly
   * poisoned ones)" — set on the AFFECTED side (mirrors itemLockedUntilTurn's convention), since
   * it's a condition-based check (any Poisoned Pokémon) rather than tied to one specific card. */
  poisonedCantRetreatUntilTurn: number | null;
  /** Real rules allow at most one retreat per turn (barring a specific card effect granting an
   * extra one, not currently modeled). Reset at this player's own turn-begin, same as the other
   * *ThisTurn flags. */
  retreatedThisTurn: boolean;
  /** Turn number on which this player last had one of their own Pokémon Knocked Out (any cause —
   * attack, Poison/Burn, self-damage, ability effect). Since turns strictly alternate, "did my
   * Pokémon faint during the opponent's last turn" (e.g. 吉雉雞ex's 扭轉乾坤) is just this value
   * === G.turn - 1 once it's this player's turn again. Never reset — a stale value from turns ago
   * simply won't equal G.turn - 1, so it naturally stops mattering on its own. */
  lastPokemonFaintedTurn: number | null;
  /** Once-per-own-turn Stadium field action (e.g. 稜鏡塔's "discard 2, draw 1") already used this
   * turn. A single flag suffices regardless of which Stadium grants it, since only one Stadium is
   * ever in play at a time (see stadiums.ts) — reset every turn-begin like the other *ThisTurn
   * flags. */
  stadiumActionUsedThisTurn: boolean;
  /** 古舊能量's prize reduction is once per GAME per player (「對戰中…只生效1次」), so unlike the
   * per-turn counters above this is never reset — it is set the first time it applies and stays. */
  usedAncientEnergyPrizeReduction?: boolean;

  /** Instance id of whoever was Active when this turn began. Anything else standing in the
   * Active spot later in the turn therefore got there from the Bench this turn — which is what
   * "在這個回合，若從備戰區將這隻寶可夢放置於戰鬥場" keys off. Recorded once per turn instead
   * of flagging every promote site (retreat, KO promotion, Trainer/ability switches, …), so no
   * future switch effect can forget to set it. */
  activeIdAtTurnStart?: string;
}

export interface PtcgGameState {
  players: [PtcgPlayerState, PtcgPlayerState];
  turn: number;
  currentPlayer: number;
  /** 'choose_first' (winner of the opening coin flip picks going first/second, only when an
   * interactive player won the flip — AI winners decide instantly in setup) precedes
   * 'choose_active', which precedes the very first turn for a player who was dealt a hand
   * without an auto-placed Active — see setup.ts's `interactivePlayer` option. */
  phase: 'choose_first' | 'choose_active' | 'draw' | 'main' | 'attack' | 'end';
  /** Who won the opening coin flip (real rules: the winner CHOOSES first or second). */
  coinWinner?: 0 | 1;
  /** The decided turn-1 player. Set immediately in setup when the flip winner is an AI (they
   * always choose to go first, matching common play); set by the chooseFirst move when the
   * interactive player won. During choose_first/choose_active, currentPlayer stays the
   * interactive player so getLegalMoves keeps working — chooseActive applies this afterward. */
  firstPlayer?: 0 | 1;
  /** Which seats are driven by a human (vs-AI: [0]; local hotseat: [0,1]; headless: []).
   * Read by chooseActive/chooseFirst to route the setup phases through every human seat. */
  interactivePlayers?: (0 | 1)[];
  /** Deferred mulligan compensations for INTERACTIVE players (real rules: drawing the bonus
   * cards is optional, 0..max). Non-interactive sides auto-draw the max in setup as before.
   * Converted into PendingChoices one at a time after all Actives are placed, resolved before
   * turn 1 begins. A queue because in local 2P BOTH sides can be owed compensation. */
  pendingMulliganBonuses?: { player: 0 | 1; max: number }[];
  /** Real rules: every mulligan reshuffle first reveals the whole hand to the opponent.
   * Captured during setup (name+image are enough to render — no instance ids needed since
   * these cards went straight back into the deck), shown once by the client at battle start. */
  mulliganReveals?: { player: 0 | 1; cards: { name: string; image: string }[] }[];
  winner: number | null;
  winReason: string | null;
  turnLog: TurnAction[];
  pendingChoice: PendingChoice | null;
  /** Only one Stadium card may be in play at a time; playing a new one discards the old (to its owner's pile). */
  activeStadium: GameCard | null;
  /** 回力鏢能量/燃料【火】能量: 「在招式的傷害與效果的影響之後」 they come back if the holder's own
   * attack's effect discarded them. That moment has no single call site — an attack can finish
   * synchronously or through a PendingChoice resolved moves later — so moves.attack records the
   * attacker's copies here going in, and the central post-move wrapper consumes the record at the
   * first moment no pendingChoice is open (see processAttackEnergyReturns). null between attacks. */
  attackEnergyReturns: { owner: 0 | 1; holderId: string; energyId: string; kind: 'reattach' | 'hand' }[] | null;
}

export type GamePhase = PtcgGameState['phase'];
