import OpenAI from 'openai';
import { AiProvider, ChatMessage, AiCompletionOptions, AiResponse } from './types';
import { AppError, ExternalServiceError, RateLimitError } from '../../utils/errors';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';

export interface OpenAiProviderConfig {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  defaultMaxTokens?: number;
  defaultTemperature?: number;
  timeoutMs?: number;
}

export class OpenAiCompatibleProvider implements AiProvider {
  public readonly name = 'openai-compatible';
  private client: OpenAI;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private defaultTemperature: number;
  private timeoutMs: number;

  constructor(config: OpenAiProviderConfig) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new AppError(
        'AI Provider configuration error: API key is missing. Set AI_API_KEY in environment or switch to AI_PROVIDER=stub.',
        500,
        'AI_CONFIG_ERROR'
      );
    }

    this.defaultModel = config.defaultModel || 'gpt-4o-mini';
    this.defaultMaxTokens = config.defaultMaxTokens || 1000;
    this.defaultTemperature = config.defaultTemperature ?? 0.7;
    this.timeoutMs = config.timeoutMs || 15000;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0, // We manage retries explicitly with custom backoff & jitter
    });
  }

  async generateResponse(
    messages: ChatMessage[],
    options?: AiCompletionOptions
  ): Promise<AiResponse> {
    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || this.defaultMaxTokens;
    const temperature = options?.temperature ?? this.defaultTemperature;

    if (messages.length === 0) {
      throw new AppError('Cannot generate response for empty message list', 400, 'AI_EMPTY_MESSAGES');
    }

    try {
      const response = await withRetry(
        async () => {
          return await this.client.chat.completions.create({
            model,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            max_tokens: maxTokens,
            temperature,
            stop: options?.stop,
          });
        },
        {
          maxRetries: 2,
          initialDelayMs: 500,
          retryableErrors: (err: unknown) => {
            if (err instanceof OpenAI.APIError) {
              // Retry on 429 (rate limit) and 5xx (server error)
              return err.status === 429 || (err.status !== undefined && err.status >= 500);
            }
            return false;
          },
        }
      );

      const choice = response.choices[0];
      if (!choice || !choice.message || choice.message.content === null) {
        throw new ExternalServiceError('AI Provider', 'Provider returned an empty or malformed completion choice');
      }

      return {
        content: choice.message.content.trim(),
        model: response.model || model,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
        finishReason: choice.finish_reason ?? undefined,
      };
    } catch (err) {
      if (err instanceof OpenAI.RateLimitError) {
        logger.warn({ error: err.message }, 'AI provider rate limit reached');
        throw new RateLimitError('AI provider capacity limit exceeded. Please try again shortly.');
      }

      if (err instanceof OpenAI.AuthenticationError) {
        logger.error({ error: err.message }, 'AI provider authentication failed');
        throw new AppError('AI provider authentication failed. Check AI_API_KEY.', 500, 'AI_AUTH_FAILED');
      }

      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        logger.error({ timeoutMs: this.timeoutMs }, 'AI provider request timed out');
        throw new ExternalServiceError('AI Provider', 'Request to AI model timed out');
      }

      if (err instanceof AppError) {
        throw err;
      }

      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, 'Unhandled AI provider error');
      throw new ExternalServiceError('AI Provider', message);
    }
  }
}
