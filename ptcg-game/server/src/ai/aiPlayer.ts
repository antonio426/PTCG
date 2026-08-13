import { LegalAction } from '@ptcg/shared';
import type { PtcgGameState } from '../game/GameState';
import { getLegalMoves } from '../game/validation';

export interface IAIPlayer {
  name: string;
  decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]): Promise<{
    action: LegalAction;
    thought: string;
  }>;
}

export class RandomAI implements IAIPlayer {
  name = 'RandomAI';
  async decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]) {
    const validMoves = legalMoves.filter(m => m.type !== 'forfeit');
    const move = validMoves[Math.floor(Math.random() * validMoves.length)] || legalMoves[0];
    return { action: move, thought: '隨機選擇' };
  }
}

export class MockAI implements IAIPlayer {
  name = 'MockAI';
  async decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]) {
    const priority: string[] = ['attack', 'evolve_pokemon', 'attach_energy', 'play_pokemon', 'play_trainer', 'retreat', 'draw_card', 'end_turn'];
    for (const type of priority) {
      const move = legalMoves.find(m => m.type === type);
      if (move) return { action: move, thought: `優先執行 ${type}` };
    }
    return { action: legalMoves[0], thought: '預設行動' };
  }
}

export function selectRandomMove(G: PtcgGameState, playerIndex: number): LegalAction | null {
  const legalMoves = getLegalMoves(G, playerIndex);
  if (legalMoves.length === 0) return null;
  const validMoves = legalMoves.filter(m => m.type !== 'forfeit');
  const pool = validMoves.length > 0 ? validMoves : legalMoves;
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

export class ClaudeAI implements IAIPlayer {
  name = 'ClaudeAI';

  constructor(private config: { apiKey: string; apiUrl?: string; model?: string; showThought?: boolean; temperature?: number }) {}

  async decide(gameState: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]) {
    const prompt = this.buildPrompt(gameState, playerIndex, legalMoves);
    const response = await this.callClaude(prompt);
    return this.parseResponse(response, legalMoves);
  }

  private energyLabel(type: string): string {
    const map: Record<string, string> = {
      Grass: '草', Fire: '火', Water: '水', Lightning: '雷',
      Psychic: '超', Fighting: '鬥', Darkness: '惡', Metal: '鋼',
      Fairy: '妖', Dragon: '龍', Colorless: '無',
    };
    return map[type] || type;
  }

  private formatEnergyCost(cost: { type: string }[] | string[] | undefined): string {
    if (!cost || cost.length === 0) return '—';
    return cost.map(c => this.energyLabel(typeof c === 'string' ? c : c.type)).join('');
  }

  private formatEnergyAttached(energy: { type: string }[] | undefined): string {
    if (!energy || energy.length === 0) return '無';
    const counts: Record<string, number> = {};
    for (const e of energy) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return Object.entries(counts).map(([t, n]) => `${this.energyLabel(t)}×${n}`).join(' ');
  }

  private canPayCost(attachedEnergy: { type: string }[], cost: string[]): boolean {
    if (cost.length === 0) return true;
    const counts: Record<string, number> = {};
    for (const e of attachedEnergy) counts[e.type] = (counts[e.type] || 0) + 1;
    const specificCosts = cost.filter(c => c !== 'Colorless');
    const colorlessCount = cost.filter(c => c === 'Colorless').length;
    const remaining = { ...counts };
    for (const requiredType of specificCosts) {
      if (!remaining[requiredType] || remaining[requiredType] <= 0) return false;
      remaining[requiredType]--;
    }
    const totalRemaining = Object.values(remaining).reduce((a, b) => a + b, 0);
    return totalRemaining >= colorlessCount;
  }

  private buildPrompt(G: PtcgGameState, playerIndex: number, legalMoves: LegalAction[]): string {
    const player = G.players[playerIndex];
    const opponent = G.players[1 - playerIndex];
    const phaseMap: Record<string, string> = { draw: '抽牌階段', main: '主要階段', attack: '攻擊階段', end: '結束階段' };
    const lines: string[] = [];
    lines.push('=== 寶可夢卡牌遊戲對戰 ===');
    lines.push('');
    lines.push(`回合 ${G.turn} | 玩家 ${playerIndex === 0 ? 'A' : 'B'} | 階段：${phaseMap[G.phase] || G.phase}`);
    lines.push('');

    lines.push('--- 你的手牌 ---');
    if (player.hand.length === 0) {
      lines.push('  （無手牌）');
    } else {
      for (let i = 0; i < player.hand.length; i++) {
        const c = player.hand[i];
        const cd = c.cardData;
        let info = `  [${i}] ${cd.name}`;
        if (cd.supertype === 'Pokémon') {
          info += ` | 寶可夢 ${cd.types?.join('/') || ''} HP:${cd.hp || '?'}`;
          if (cd.weaknesses && cd.weaknesses.length > 0) {
            info += ` 弱點:${cd.weaknesses.map(w => `${this.energyLabel(w.type)}${w.value}`).join(',')}`;
          }
          if (cd.resistances && cd.resistances.length > 0) {
            info += ` 抗性:${cd.resistances.map(r => `${this.energyLabel(r.type)}-${r.value}`).join(',')}`;
          }
          if (cd.retreatCost) info += ` 撤退:${this.formatEnergyCost(cd.retreatCost)}`;
          info += ` 子類型:${cd.subtypes?.join(',') || ''}`;
          if (cd.attacks && cd.attacks.length > 0) {
            for (const atk of cd.attacks) {
              info += ` | 招式:${atk.name} [${this.formatEnergyCost(atk.cost)}] ${atk.damage}傷害 "${atk.text}"`;
            }
          }
        } else if (cd.supertype === 'Energy') {
          info += ` | 能量 ${cd.types?.join('/') || ''}`;
        } else if (cd.supertype === 'Trainer') {
          info += ` | 訓練家 ${cd.subtypes?.join(',') || ''}`;
          if (cd.rules) info += ` ${cd.rules.join(' ')}`;
        }
        lines.push(info);
      }
    }
    lines.push('');

    lines.push('--- 你的場上狀態 ---');
    if (player.active) {
      const a = player.active;
      const ad = a.cardData;
      const hpMax = parseInt(ad.hp || '0');
      const hpCur = Math.max(0, hpMax - a.damage);
      let info = `  主動：${ad.name} HP:${hpCur}/${hpMax}`;
      info += ` 能量:[${this.formatEnergyAttached(a.attachedEnergy)}]`;
      if (a.statusConditions.length > 0) info += ` 狀態:${a.statusConditions.join(',')}`;
      if (ad.attacks) {
        for (const atk of ad.attacks) {
          const payable = this.canPayCost(a.attachedEnergy, atk.cost);
          info += ` | ${atk.name}[${this.formatEnergyCost(atk.cost)}]${atk.damage}傷害${payable ? '✓' : '✗'}`;
        }
      }
      lines.push(info);
    } else {
      lines.push('  主動：（無）');
    }

    const benchCards = player.bench.map((s, i) => ({ card: s, pos: i })).filter(x => x.card !== null);
    if (benchCards.length === 0) {
      lines.push('  備戰：（空）');
    } else {
      for (const { card, pos } of benchCards) {
        const c = card!;
        const cd = c.cardData;
        const hpMax = parseInt(cd.hp || '0');
        const hpCur = Math.max(0, hpMax - c.damage);
        let info = `  備戰[${pos}]：${cd.name} HP:${hpCur}/${hpMax}`;
        info += ` 能量:[${this.formatEnergyAttached(c.attachedEnergy)}]`;
        if (c.statusConditions.length > 0) info += ` 狀態:${c.statusConditions.join(',')}`;
        lines.push(info);
      }
    }
    lines.push('');

    lines.push(`  已附能量次數(本回合):${player.energyAttachedThisTurn}/1`);
    lines.push(`  已打支援者(本回合):${player.supporterPlayedThisTurn ? '是' : '否'}`);
    lines.push(`  已放基本寶可夢(本回合):${player.basicPokemonPlayedThisTurn}`);
    lines.push(`  已出牌數(本回合):${player.cardsPlayedThisTurn}`);

    lines.push('');
    lines.push('--- 獎賞卡 ---');
    lines.push(`  你：${player.prizes.length} 張剩餘（已獲得 ${player.takenPrizes} 張）`);
    lines.push(`  對手：${opponent.prizes.length} 張剩餘（已獲得 ${opponent.takenPrizes} 張）`);
    lines.push('');

    lines.push('--- 對手場上狀態 ---');
    if (opponent.active) {
      const a = opponent.active;
      const ad = a.cardData;
      const hpMax = parseInt(ad.hp || '0');
      const hpCur = Math.max(0, hpMax - a.damage);
      let info = `  主動：${ad.name} HP:${hpCur}/${hpMax}`;
      info += ` 能量:[${this.formatEnergyAttached(a.attachedEnergy)}]`;
      if (a.statusConditions.length > 0) info += ` 狀態:${a.statusConditions.join(',')}`;
      if (ad.attacks) {
        for (const atk of ad.attacks) {
          info += ` | ${atk.name}[${this.formatEnergyCost(atk.cost)}]${atk.damage}傷害`;
        }
      }
      lines.push(info);
    } else {
      lines.push('  主動：（無）');
    }

    const oppBenchCards = opponent.bench.map((s, i) => ({ card: s, pos: i })).filter(x => x.card !== null);
    if (oppBenchCards.length === 0) {
      lines.push('  備戰：（空）');
    } else {
      for (const { card, pos } of oppBenchCards) {
        const c = card!;
        const cd = c.cardData;
        const hpMax = parseInt(cd.hp || '0');
        const hpCur = Math.max(0, hpMax - c.damage);
        let info = `  備戰[${pos}]：${cd.name} HP:${hpCur}/${hpMax}`;
        info += ` 能量:[${this.formatEnergyAttached(c.attachedEnergy)}]`;
        lines.push(info);
      }
    }
    lines.push('');

    lines.push('--- 可行行動 ---');
    for (let i = 0; i < legalMoves.length; i++) {
      const m = legalMoves[i];
      const typeMap: Record<string, string> = {
        draw_card: '抽牌', play_pokemon: '出牌', evolve_pokemon: '進化',
        attach_energy: '能量', play_trainer: '訓練家', use_ability: '特性',
        retreat: '撤退', attack: '攻擊', end_turn: '結束回合', forfeit: '投降',
      };
      lines.push(`  [${i}] ${typeMap[m.type] || m.type} → ${m.description}`);
    }
    lines.push('');

    lines.push('--- 遊戲規則提醒 ---');
    lines.push('  - 每回合只能附著 1 張能量卡');
    lines.push('  - 每回合只能使用 1 張支援者卡');
    lines.push('  - 剛上場的寶可夢不能進化（同一回合）');
    lines.push('  - 攻擊或使用「結束回合」會結束你的回合');
    lines.push('  - 若對手的戰鬥寶可夢被擊倒（HP歸零），你獲得1張獎賞卡');
    lines.push('  - 先集滿6張獎賞卡者獲勝，或讓對手無戰鬥寶可夢上場');
    lines.push('');

    lines.push('請一步一步仔細分析當前局面，思考以下問題：');
    lines.push('  1. 當前局面中你的優勢和劣勢是什麼？');
    lines.push('  2. 你的對手可能採取的策略是什麼？');
    lines.push('  3. 你有哪些可行的選項？每個選項的優缺點？');
    lines.push('  4. 哪個行動在戰略上最有利？為什麼？');
    lines.push('');
    lines.push('然後使用 select_action 工具選擇一個行動。');

    return lines.join('\n');
  }

  private async callClaude(prompt: string): Promise<any> {
    const apiUrl = this.config.apiUrl || 'https://api.anthropic.com/v1/messages';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model || 'claude-sonnet-5',
        max_tokens: 1024,
        temperature: this.config.temperature ?? 0.3,
        messages: [{ role: 'user', content: prompt }],
        tools: [{
          name: 'select_action',
          description: '選擇一個行動來進行寶可夢卡牌遊戲',
          input_schema: {
            type: 'object',
            properties: {
              thought: {
                type: 'string',
                description: '你對當前局面的詳細思考過程（使用繁體中文）',
              },
              action_index: {
                type: 'integer',
                description: '所選行動的編號（從可行行動列表中的索引）',
              },
            },
            required: ['thought', 'action_index'],
          },
        }],
        tool_choice: { type: 'tool', name: 'select_action' },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Claude API error ${response.status}: ${text}`);
    }
    return response.json();
  }

  private parseResponse(response: any, legalMoves: LegalAction[]): { action: LegalAction; thought: string } {
    const content = response?.content || [];
    const toolUse = content.find((block: any) => block.type === 'tool_use' && block.name === 'select_action');
    if (toolUse?.input) {
      const { thought, action_index } = toolUse.input;
      const action = legalMoves[action_index];
      if (action) return { action, thought: thought || '' };
    }
    const textBlock = content.find((block: any) => block.type === 'text');
    if (textBlock?.text) {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*"action_index"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          const action = legalMoves[parsed.action_index];
          if (action) return { action, thought: parsed.thought || '' };
        } catch {}
      }
    }
    return { action: legalMoves[0], thought: '解析回應失敗，使用預設行動' };
  }
}
