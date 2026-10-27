import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAiCompatibleProvider } from '../../src/services/ai/openai';
import { StubAiProvider } from '../../src/services/ai/stub';
import { RateLimitError } from '../../src/utils/errors';

function providerWith(create: ReturnType<typeof vi.fn>) {
  const provider = new OpenAiCompatibleProvider({ apiKey: 'test-key', defaultModel: 'gemini-test' });
  (provider as unknown as { client: unknown }).client = { chat: { completions: { create } } };
  return provider;
}

const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  model: 'gemini-test',
  choices: [{ message, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  ...extra,
});

const tools = [{ name: 'calculator', description: 'math', parameters: { type: 'object', properties: {} } }];

describe('OpenAiCompatibleProvider.generateWithTools (mocked client; no network)', () => {
  it('sends tools and the full tool-call transcript in OpenAI wire format', async () => {
    const create = vi.fn().mockResolvedValue(completion({ content: 'ok' }));
    await providerWith(create).generateWithTools(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_1_1', name: 'calculator', rawArguments: '{"expression":"1+1"}' }] },
        { role: 'tool', toolCallId: 'call_1_1', name: 'calculator', content: '{"ok":true}' },
      ],
      tools
    );

    const body = create.mock.calls[0]![0];
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'calculator', description: 'math', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1_1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' } }],
    });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1_1', content: '{"ok":true}' });
  });

  it('captures Gemini extra_content from tool calls and sends it back verbatim on the next request', async () => {
    const extra = { google: { thought_signature: 'sig-xyz' } };
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        completion({
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{}' }, extra_content: extra }],
        })
      )
      .mockResolvedValueOnce(completion({ content: 'done' }));
    const provider = providerWith(create);
    const first = await provider.generateWithTools([{ role: 'user', content: 'q' }], tools);
    expect(first).toMatchObject({ kind: 'tool_calls', toolCalls: [{ providerMetadata: extra }] });
    if (first.kind !== 'tool_calls') throw new Error('unreachable');

    await provider.generateWithTools(
      [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'c1', name: 'calculator', content: '{"ok":true}' },
      ],
      tools
    );
    const sent = create.mock.calls[1]![0].messages[1].tool_calls[0];
    expect(sent.extra_content).toEqual(extra);
  });

  it('omits the tools parameter entirely when none are available', async () => {
    const create = vi.fn().mockResolvedValue(completion({ content: 'ok' }));
    await providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], []);
    expect(create.mock.calls[0]![0]).not.toHaveProperty('tools');
  });

  it('returns text completions with usage', async () => {
    const create = vi.fn().mockResolvedValue(completion({ content: '  hello  ' }));
    const res = await providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], tools);
    expect(res).toMatchObject({ kind: 'text', content: 'hello', model: 'gemini-test', usage: { totalTokens: 7 } });
  });

  it('returns tool calls with RAW argument strings (never parsed by the provider)', async () => {
    const create = vi.fn().mockResolvedValue(
      completion({
        content: null,
        tool_calls: [
          { id: 'abc', type: 'function', function: { name: 'calculator', arguments: '{"expression": ' } },
          { id: '', type: 'function', function: { name: 'other', arguments: '' } },
        ],
      })
    );
    const res = await providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], tools);
    expect(res).toMatchObject({
      kind: 'tool_calls',
      toolCalls: [
        { id: 'abc', name: 'calculator', rawArguments: '{"expression": ' },
        { id: '', name: 'other', rawArguments: '' },
      ],
    });
  });

  it('rejects a completion with neither text nor tool calls', async () => {
    const create = vi.fn().mockResolvedValue(completion({ content: null }));
    await expect(providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], tools)).rejects.toThrow(
      /neither text nor tool calls/
    );
    const empty = vi.fn().mockResolvedValue({ model: 'm', choices: [] });
    await expect(providerWith(empty).generateWithTools([{ role: 'user', content: 'q' }], tools)).rejects.toThrow(
      /empty or malformed/
    );
  });

  it('maps provider auth failures to a non-retryable configuration error', async () => {
    const create = vi.fn().mockRejectedValue(new OpenAI.AuthenticationError(401, {}, 'bad key', {}));
    await expect(providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], tools)).rejects.toMatchObject({
      code: 'AI_AUTH_FAILED',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps 429s to RateLimitError after bounded internal retries', async () => {
    const create = vi.fn().mockRejectedValue(new OpenAI.RateLimitError(429, {}, 'slow down', {}));
    await expect(providerWith(create).generateWithTools([{ role: 'user', content: 'q' }], tools)).rejects.toBeInstanceOf(
      RateLimitError
    );
    expect(create).toHaveBeenCalledTimes(3); // 1 + maxRetries(2)
  });

  it('rejects an empty message list', async () => {
    await expect(providerWith(vi.fn()).generateWithTools([], tools)).rejects.toThrow(/empty message list/);
  });
});

describe('StubAiProvider.generateWithTools', () => {
  it('answers in text and never requests tools', async () => {
    const res = await new StubAiProvider('stubbed').generateWithTools([{ role: 'user', content: 'hi' }], tools);
    expect(res).toMatchObject({ kind: 'text', content: 'stubbed' });
  });
});
