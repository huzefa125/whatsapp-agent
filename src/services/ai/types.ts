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
}
