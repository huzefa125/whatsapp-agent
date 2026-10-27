import OpenAI from 'openai';
import {
  AiProvider,
  ChatMessage,
  AiCompletionOptions,
  AiResponse,
  ToolChatMessage,
  ToolSpec,
  ToolCompletion,
} from './types';
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
      throw this.mapError(err);
    }
  }

  /**
   * Tool-calling completion using the OpenAI-compatible `tools` (function calling) API.
   * Arguments are returned as raw strings; validation is the caller's responsibility.
   */
  async generateWithTools(
    messages: ToolChatMessage[],
    tools: ToolSpec[],
    options?: AiCompletionOptions
  ): Promise<ToolCompletion> {
    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || this.defaultMaxTokens;
    const temperature = options?.temperature ?? this.defaultTemperature;

    if (messages.length === 0) {
      throw new AppError('Cannot generate response for empty message list', 400, 'AI_EMPTY_MESSAGES');
    }

    const wireMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => {
      switch (m.role) {
        case 'tool':
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        case 'assistant':
          return {
            role: 'assistant',
            content: m.content,
            ...(m.toolCalls && m.toolCalls.length > 0
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function' as const,
                    function: { name: c.name, arguments: c.rawArguments },
                  })),
                }
              : {}),
          };
        default:
          return { role: m.role, content: m.content };
      }
    });

    try {
      const response = await withRetry(
        async () =>
          await this.client.chat.completions.create({
            model,
            messages: wireMessages,
            max_tokens: maxTokens,
            temperature,
            ...(tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: 'function' as const,
                    function: { name: t.name, description: t.description, parameters: t.parameters },
                  })),
                }
              : {}),
          }),
        {
          maxRetries: 2,
          initialDelayMs: 500,
          retryableErrors: (err: unknown) =>
            err instanceof OpenAI.APIError &&
            (err.status === 429 || (err.status !== undefined && err.status >= 500)),
        }
      );

      const choice = response.choices[0];
      if (!choice || !choice.message) {
        throw new ExternalServiceError('AI Provider', 'Provider returned an empty or malformed completion choice');
      }

      const base = {
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

      const calls = (choice.message.tool_calls ?? []).flatMap((c) =>
        c.type === 'function'
          ? [{ id: c.id ?? '', name: c.function.name, rawArguments: c.function.arguments ?? '' }]
          : []
      );

      if (calls.length > 0) {
        return { ...base, kind: 'tool_calls', content: choice.message.content?.trim() ?? null, toolCalls: calls };
      }
      if (choice.message.content === null || choice.message.content === undefined) {
        throw new ExternalServiceError('AI Provider', 'Provider returned neither text nor tool calls');
      }
      return { ...base, kind: 'text', content: choice.message.content.trim() };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  private mapError(err: unknown): Error {
    if (err instanceof OpenAI.RateLimitError) {
      logger.warn({ error: err.message }, 'AI provider rate limit reached');
      return new RateLimitError('AI provider capacity limit exceeded. Please try again shortly.');
    }

    if (err instanceof OpenAI.AuthenticationError) {
      logger.error({ error: err.message }, 'AI provider authentication failed');
      return new AppError('AI provider authentication failed. Check AI_API_KEY.', 500, 'AI_AUTH_FAILED');
    }

    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      logger.error({ timeoutMs: this.timeoutMs }, 'AI provider request timed out');
      return new ExternalServiceError('AI Provider', 'Request to AI model timed out');
    }

    if (err instanceof AppError) {
      return err;
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error({ error: message }, 'Unhandled AI provider error');
    return new ExternalServiceError('AI Provider', message);
  }
}
