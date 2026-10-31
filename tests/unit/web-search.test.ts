import { describe, it, expect, vi, afterEach } from 'vitest';
import { BraveProvider, SearxngProvider, TavilyProvider } from '../../src/services/search/providers';
import { createWebSearchTool, DailySearchLimiter } from '../../src/services/search/web-search-tool';
import { validateEnv } from '../../src/config/env';
import { buildCapabilityContext } from '../../src/services/agent/prompts';
import { ToolError } from '../../src/services/agent/engine/types';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const signal = new AbortController().signal;
const ctx = { userId: 'u1', taskId: 't', executionId: 'e', toolCallId: 'c', idempotencyKey: 'k', signal, log: {} as never };

describe('search providers', () => {
  it('maps Tavily results and drops non-http links', async () => {
    global.fetch = vi.fn(async () =>
      json({
        results: [
          { title: 'A', url: 'https://a.example/x', content: 'alpha' },
          { title: 'Bad', url: 'javascript:alert(1)', content: 'nope' },
        ],
      })
    ) as typeof fetch;
    const hits = await new TavilyProvider('k').search('q', 5, signal);
    expect(hits).toEqual([{ title: 'A', url: 'https://a.example/x', snippet: 'alpha' }]);
  });

  it('maps Brave and SearXNG results', async () => {
    global.fetch = vi.fn(async () => json({ web: { results: [{ title: 'B', url: 'https://b.example', description: 'beta' }] } })) as typeof fetch;
    expect((await new BraveProvider('k').search('q', 5, signal))[0]?.snippet).toBe('beta');

    let url = '';
    global.fetch = vi.fn(async (u: string | URL | Request) => {
      url = String(u);
      return json({ results: [{ title: 'S', url: 'https://s.example', content: 'sigma' }] });
    }) as typeof fetch;
    const hits = await new SearxngProvider('http://localhost:8080/').search('flight', 5, signal);
    expect(url).toBe('http://localhost:8080/search?q=flight&format=json');
    expect(hits[0]?.title).toBe('S');
  });

  it('strips control characters and caps snippet length', async () => {
    global.fetch = vi.fn(async () =>
      json({ results: [{ title: 'T\u0000\n', url: 'https://a.example', content: 'x'.repeat(2000) }] })
    ) as typeof fetch;
    const [hit] = await new TavilyProvider('k').search('q', 5, signal);
    expect(hit?.title).toBe('T');
    expect(hit?.snippet.length).toBe(400);
  });

  it('turns quota and auth failures into clear tool errors', async () => {
    global.fetch = vi.fn(async () => json({}, 429)) as typeof fetch;
    await expect(new TavilyProvider('k').search('q', 5, signal)).rejects.toMatchObject({ code: 'SEARCH_QUOTA' });
    global.fetch = vi.fn(async () => json({}, 401)) as typeof fetch;
    await expect(new TavilyProvider('k').search('q', 5, signal)).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
  });
});

describe('web_search tool', () => {
  const provider = { name: 'fake', search: vi.fn(async () => [{ title: 'A', url: 'https://a.example', snippet: 's' }]) };

  it('labels results as untrusted and requires the web:search permission', async () => {
    const tool = createWebSearchTool(provider, { maxResults: 5, dailyLimitPerUser: 0 });
    expect(tool.permissions).toEqual(['web:search']);
    const out = (await tool.execute({ query: 'hello' }, ctx)) as { notice: string; results: unknown[] };
    expect(out.notice).toMatch(/UNTRUSTED/);
    expect(out.results).toHaveLength(1);
  });

  it('enforces the per-user daily limit and resets the next day', async () => {
    let now = new Date('2026-10-31T10:00:00Z');
    const limiter = new DailySearchLimiter(2, () => now);
    expect([limiter.tryConsume('a'), limiter.tryConsume('a'), limiter.tryConsume('a')]).toEqual([true, true, false]);
    expect(limiter.tryConsume('b')).toBe(true);
    now = new Date('2026-11-01T00:00:01Z');
    expect(limiter.tryConsume('a')).toBe(true);

    const tool = createWebSearchTool(provider, { maxResults: 5, dailyLimitPerUser: 1 });
    await tool.execute({ query: 'one' }, ctx);
    await expect(tool.execute({ query: 'two' }, ctx)).rejects.toBeInstanceOf(ToolError);
  });
});

describe('web search config and prompt', () => {
  const base = {
    NODE_ENV: 'test',
    WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_APP_SECRET: 's',
    WHATSAPP_ACCESS_TOKEN: 'a',
    WHATSAPP_PHONE_NUMBER_ID: '1',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTH_OTP_HMAC_SECRET: 'test_auth_otp_hmac_secret_32_characters_long!',
  };

  it('is off by default and rejects a provider with no key or url', () => {
    expect(validateEnv(base).WEB_SEARCH_PROVIDER).toBe('none');
    expect(() => validateEnv({ ...base, WEB_SEARCH_PROVIDER: 'tavily' })).toThrow(/WEB_SEARCH_API_KEY/);
    expect(() => validateEnv({ ...base, WEB_SEARCH_PROVIDER: 'searxng' })).toThrow(/WEB_SEARCH_URL/);
    expect(validateEnv({ ...base, WEB_SEARCH_PROVIDER: 'brave', WEB_SEARCH_API_KEY: 'k' }).WEB_SEARCH_PROVIDER).toBe('brave');
  });

  it('tells the model it can search only when the tool exists', () => {
    expect(buildCapabilityContext(['calculator', 'web_search'])).toContain('search the web');
    expect(buildCapabilityContext(['calculator', 'web_search'])).not.toContain('You cannot browse the web');
    expect(buildCapabilityContext(['calculator'])).toContain('You cannot browse the web');
  });
});
