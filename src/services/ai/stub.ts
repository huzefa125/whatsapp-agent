import {
  AiProvider,
  ChatMessage,
  AiCompletionOptions,
  AiResponse,
  ToolChatMessage,
  ToolSpec,
  ToolCompletion,
} from './types';
import { logger } from '../../utils/logger';

export class StubAiProvider implements AiProvider {
  public readonly name = 'stub';
  private customResponse?: string;
  private shouldFailWith?: Error;

  constructor(customResponse?: string) {
    this.customResponse = customResponse;
  }

  setCustomResponse(response: string | undefined): void {
    this.customResponse = response;
  }

  setFailure(error: Error | undefined): void {
    this.shouldFailWith = error;
  }

  async generateResponse(
    messages: ChatMessage[],
    options?: AiCompletionOptions
  ): Promise<AiResponse> {
    if (this.shouldFailWith) {
      throw this.shouldFailWith;
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const userText = lastUserMessage?.content || 'Hello';

    logger.debug({ userText }, '[StubAiProvider] Generating stub AI response');

    const reply =
      this.customResponse ??
      `Hello! I received your message: "${userText}". (Note: This is an automated stub response for testing/development).`;

    return {
      content: reply,
      model: options?.model || 'stub-agent-model',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
      finishReason: 'stop',
    };
  }

  /** Offline tool-calling stand-in: never requests tools, answers in plain text. */
  async generateWithTools(
    messages: ToolChatMessage[],
    _tools: ToolSpec[],
    options?: AiCompletionOptions
  ): Promise<ToolCompletion> {
    const plain: ChatMessage[] = messages.flatMap((m): ChatMessage[] =>
      m.role === 'user' || m.role === 'system' || (m.role === 'assistant' && m.content)
        ? [{ role: m.role, content: m.content ?? '' }]
        : []
    );
    const res = await this.generateResponse(plain, options);
    return { kind: 'text', content: res.content, model: res.model, usage: res.usage, finishReason: 'stop' };
  }
}
