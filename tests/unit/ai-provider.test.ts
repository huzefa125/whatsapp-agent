import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import { StubAiProvider } from '../../src/services/ai/stub';
import { OpenAiCompatibleProvider } from '../../src/services/ai/openai';

describe('AI Provider Abstraction', () => {
  describe('StubAiProvider', () => {
    it('generates expected default response referencing user query', async () => {
      const stub = new StubAiProvider();
      const res = await stub.generateResponse([
        { role: 'user', content: 'What time is it?' },
      ]);

      expect(res.content).toContain('What time is it?');
      expect(res.model).toBe('stub-agent-model');
      expect(res.finishReason).toBe('stop');
      expect(res.usage?.totalTokens).toBeGreaterThan(0);
    });

    it('returns custom response when configured', async () => {
      const stub = new StubAiProvider('Custom agent response');
      const res = await stub.generateResponse([
        { role: 'user', content: 'Hello' },
      ]);
      expect(res.content).toBe('Custom agent response');
    });

    it('simulates failure when configured', async () => {
      const stub = new StubAiProvider();
      stub.setFailure(new Error('AI provider connection timeout'));

      await expect(
        stub.generateResponse([{ role: 'user', content: 'Test' }])
      ).rejects.toThrow('AI provider connection timeout');
    });
  });

  describe('OpenAiCompatibleProvider', () => {
    it('throws configuration error if API key is empty', () => {
      expect(() => {
        new OpenAiCompatibleProvider({ apiKey: '' });
      }).toThrow(/AI Provider configuration error: API key is missing/);
    });

    it('throws error when message list is empty', async () => {
      const provider = new OpenAiCompatibleProvider({ apiKey: 'sk-test-key-mock' });
      await expect(provider.generateResponse([])).rejects.toThrow(
        /Cannot generate response for empty message list/
      );
    });
  });

  describe('model fallback', () => {
    const ok = (model: string) => ({
      model,
      choices: [{ message: { role: 'assistant', content: 'hi', tool_calls: undefined }, finish_reason: 'stop' }],
    });
    const apiError = (status: number) => new OpenAI.APIError(status, { message: `HTTP ${status}` }, `HTTP ${status}`, {});
    const build = (create: ReturnType<typeof vi.fn>, fallbackModels: string[]) => {
      const p = new OpenAiCompatibleProvider({ apiKey: 'sk-test', defaultModel: 'main', fallbackModels });
      (p as unknown as { client: unknown }).client = { chat: { completions: { create } } };
      return p;
    };
    const msgs = [{ role: 'user' as const, content: 'hello' }];

    it('moves to the next model when the first one is gone (404), instead of failing every message', async () => {
      const create = vi.fn(async (req: { model: string }) => {
        if (req.model === 'main') throw apiError(404);
        return ok(req.model);
      });
      const res = await build(create, ['backup']).generateWithTools(msgs, []);
      expect(res.model).toBe('backup');
      expect(create.mock.calls.map((c) => (c[0] as { model: string }).model)).toEqual(['main', 'backup']);
    });

    it('does not fall back on an authentication error', async () => {
      const create = vi.fn(async () => {
        throw apiError(401);
      });
      await expect(build(create, ['backup']).generateWithTools(msgs, [])).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('reports a removed model as a configuration error when no fallback works', async () => {
      const create = vi.fn(async () => {
        throw new OpenAI.NotFoundError(404, { message: 'model gone' }, 'model gone', {});
      });
      await expect(build(create, []).generateWithTools(msgs, [])).rejects.toMatchObject({ code: 'AI_CONFIG_ERROR' });
      expect(create).toHaveBeenCalledTimes(1); // a missing model is never retried
    });
  });
});
