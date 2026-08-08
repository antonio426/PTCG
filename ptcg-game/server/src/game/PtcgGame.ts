import { Game, Ctx } from 'boardgame.io';
import { GameCard } from '@ptcg/shared';
import { PtcgGameState } from './GameState';
import { setup } from './setup';
import { moves } from './moves';
import { processBetweenTurns, processWakeUpCheck } from './statusConditions';

export const PtcgGame: Game<PtcgGameState> = {
  name: 'ptcg',

  setup: ({ ctx }: { ctx: Ctx }, setupData: any) => {
    const G = setup(setupData);
    G.turn = ctx.turn;
    G.currentPlayer = parseInt(ctx.currentPlayer) as 0 | 1;
    return G;
  },

  moves,

  turn: {
    onBegin: ({ G, ctx }: { G: PtcgGameState; ctx: Ctx }) => {
      if (ctx.turn > 1) processBetweenTurns(G);
      G.turn = ctx.turn;
      G.currentPlayer = parseInt(ctx.currentPlayer) as 0 | 1;
      G.phase = ctx.turn === 1 ? 'main' : 'draw';
      processWakeUpCheck(G, G.currentPlayer as 0 | 1);
      const player = G.players[G.currentPlayer];
      player.energyAttachedThisTurn = 0;
      player.basicPokemonPlayedThisTurn = 0;
      player.supporterPlayedThisTurn = false;
      player.pokemonPlayedThisTurn = [];
      player.cardsPlayedThisTurn = 0;
    },
  },

  endIf: ({ G, ctx }: { G: PtcgGameState; ctx: Ctx }) => {
    if (G.winner !== null) return G.winner;
    for (let p = 0; p < 2; p++) {
      const player = G.players[p as 0 | 1];
      const opponent = G.players[(1 - p) as 0 | 1];
      if (player.takenPrizes >= 6) return p;
      if (!opponent.active && opponent.bench.every((s: GameCard | null) => s === null)) return p;
    }
    const cur = G.players[G.currentPlayer];
    if (cur.deck.length === 0 && G.phase === 'draw') return 1 - G.currentPlayer;
    return undefined;
  },
};
