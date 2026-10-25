import { AiProvider } from './types';
import { OpenAiCompatibleProvider } from './openai';
import { StubAiProvider } from './stub';
import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';

export * from './types';
export * from './openai';
export * from './stub';

let currentAiProvider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (!currentAiProvider) {
    const config = getConfig();

    if (config.AI_PROVIDER === 'stub') {
      logger.info('Using StubAiProvider for AI completions');
      currentAiProvider = new StubAiProvider();
    } else if (config.AI_PROVIDER === 'groq') {
      logger.info({ model: config.AI_MODEL }, 'Using Groq OpenAI-compatible provider');
      currentAiProvider = new OpenAiCompatibleProvider({
        apiKey: config.AI_API_KEY,
        baseUrl: config.AI_BASE_URL || 'https://api.groq.com/openai/v1',
        defaultModel: config.AI_MODEL || 'llama-3.3-70b-versatile',
        defaultMaxTokens: config.AI_MAX_TOKENS,
        defaultTemperature: config.AI_TEMPERATURE,
      });
    } else if (config.AI_PROVIDER === 'gemini') {
      const model = config.AI_MODEL || 'gemini-3.5-flash';
      logger.info({ model }, 'Using Google Gemini OpenAI-compatible provider');
      currentAiProvider = new OpenAiCompatibleProvider({
        apiKey: config.AI_API_KEY,
        baseUrl: config.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: model,
        defaultMaxTokens: config.AI_MAX_TOKENS,
        defaultTemperature: config.AI_TEMPERATURE,
      });
    } else {
      // Default: OpenAI or compatible endpoint
      logger.info({ model: config.AI_MODEL }, 'Using OpenAI provider');
      currentAiProvider = new OpenAiCompatibleProvider({
        apiKey: config.AI_API_KEY,
        baseUrl: config.AI_BASE_URL,
        defaultModel: config.AI_MODEL,
        defaultMaxTokens: config.AI_MAX_TOKENS,
        defaultTemperature: config.AI_TEMPERATURE,
      });
    }
  }

  return currentAiProvider;
}

export function setAiProviderForTesting(provider: AiProvider | null): void {
  currentAiProvider = provider;
}
