import type {
  AiProvider,
  AiResponse,
  ChatMessage,
  ModelToolCall,
  ToolChatMessage,
  ToolCompletion,
  ToolSpec,
} from '../../src/services/ai/types';

export type ScriptStep = ToolCompletion | Error | ((messages: ToolChatMessage[], tools: ToolSpec[]) => Promise<ToolCompletion>);

export const text = (content: string): ToolCompletion => ({ kind: 'text', content, model: 'mock-model' });

export const toolCalls = (...calls: Array<Partial<ModelToolCall> & { name: string }>): ToolCompletion => ({
  kind: 'tool_calls',
  content: null,
  model: 'mock-model',
  toolCalls: calls.map((c, i) => ({
    id: c.id ?? `provider-id-${i}`,
    name: c.name,
    rawArguments: c.rawArguments ?? '{}',
    ...(c.providerMetadata !== undefined ? { providerMetadata: c.providerMetadata } : {}),
  })),
});

/** Deterministic stand-in for Gemini: replays a script and records exactly what it was sent. */
export class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  readonly calls: Array<{ messages: ToolChatMessage[]; tools: ToolSpec[] }> = [];
  private readonly steps: ScriptStep[];

  constructor(...steps: ScriptStep[]) {
    this.steps = [...steps];
  }

  async generateResponse(_messages: ChatMessage[]): Promise<AiResponse> {
    throw new Error('generateResponse is not scripted');
  }

  async generateWithTools(messages: ToolChatMessage[], tools: ToolSpec[]): Promise<ToolCompletion> {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedProvider ran out of scripted steps');
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(messages, tools);
    return step;
  }
}
