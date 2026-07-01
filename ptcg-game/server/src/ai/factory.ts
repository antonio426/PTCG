import { AIConfig } from './types';
import { IAIPlayer, RandomAI, MockAI, ClaudeAI } from './aiPlayer';

export function createAIPlayer(config: AIConfig): IAIPlayer {
  switch (config.model) {
    case 'claude':
      return new ClaudeAI({
        apiKey: config.apiKey!,
        apiUrl: config.apiUrl,
        showThought: config.showThought,
        temperature: config.temperature,
      });
    case 'mock':
      return new MockAI();
    default:
      return new RandomAI();
  }
}
