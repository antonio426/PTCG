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
}

export interface PtcgGameState {
  players: [PtcgPlayerState, PtcgPlayerState];
  turn: number;
  currentPlayer: number;
  phase: 'draw' | 'main' | 'attack' | 'end';
  winner: number | null;
  winReason: string | null;
  turnLog: TurnAction[];
  pendingChoice: PendingChoice | null;
  /** Only one Stadium card may be in play at a time; playing a new one discards the old (to its owner's pile). */
  activeStadium: GameCard | null;
}

export type GamePhase = PtcgGameState['phase'];
