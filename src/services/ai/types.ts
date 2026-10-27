export type MessageRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface AiCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  stop?: string[];
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiResponse {
  content: string;
  model: string;
  usage?: AiUsage;
  finishReason?: string;
}

export interface AiProvider {
  readonly name: string;
  generateResponse(messages: ChatMessage[], options?: AiCompletionOptions): Promise<AiResponse>;
  /** Optional tool-calling completion. Providers without function-calling support omit this. */
  generateWithTools?(
    messages: ToolChatMessage[],
    tools: ToolSpec[],
    options?: AiCompletionOptions
  ): Promise<ToolCompletion>;
}

/** Provider-facing declaration of a callable function (JSON Schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call as returned by the model. `rawArguments` is UNTRUSTED, unparsed model output. */
export interface ModelToolCall {
  id: string;
  name: string;
  rawArguments: string;
  /**
   * Opaque provider data that must be sent back with this call on the next request
   * (e.g. Gemini 3 `extra_content.google.thought_signature`, without which the follow-up request is
   * rejected). Never interpreted or trusted by the engine; size-capped before it is stored.
   */
  providerMetadata?: unknown;
}

export type ToolChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ModelToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type ToolCompletion = {
  model: string;
  usage?: AiUsage;
  finishReason?: string;
} & (
  | { kind: 'text'; content: string }
  | { kind: 'tool_calls'; content: string | null; toolCalls: ModelToolCall[] }
);
