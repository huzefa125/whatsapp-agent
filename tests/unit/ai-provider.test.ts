import { describe, it, expect } from 'vitest';
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
});
