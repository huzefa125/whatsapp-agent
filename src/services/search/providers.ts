import { ToolError, TransientToolError } from '../agent/engine/types';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchHit[]>;
}

const REQUEST_TIMEOUT_MS = 12_000;

const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Only http(s) links reach the model, so a result can never smuggle in another scheme. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function toHits(rows: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const url = safeUrl(r.url);
    if (!url) continue;
    hits.push({ title: clean(r.title, 150), url, snippet: clean(r.snippet, 400) });
    if (hits.length >= max) break;
  }
  return hits;
}

async function getJson(url: string, init: RequestInit, signal: AbortSignal, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  } catch {
    throw new TransientToolError('SEARCH_UNAVAILABLE', 'The search service could not be reached.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ToolError('SEARCH_NOT_CONFIGURED', 'Web search is not configured correctly.');
  }
  if (res.status === 429) {
    throw new ToolError('SEARCH_QUOTA', 'The search quota has been used up for now. Try again later.');
  }
  if (res.status >= 500) throw new TransientToolError('SEARCH_UNAVAILABLE', `${provider} is temporarily unavailable.`);
  if (!res.ok) throw new ToolError('SEARCH_FAILED', `The search failed (HTTP ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new ToolError('SEARCH_FAILED', 'The search service returned an unreadable response.');
  }
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchHit[]> {
    const data = (await getJson(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic' }),
      },
      signal,
      this.name
    )) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
    return toHits((data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), maxResults);
  }
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchHit[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(maxResults) })}`;
    const data = (await getJson(
      url,
      { headers: { 'X-Subscription-Token': this.apiKey, Accept: 'application/json' } },
      signal,
      this.name
    )) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
    return toHits((data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })), maxResults);
  }
}

/** Self-hosted, no key and no quota. The instance must allow `format=json` (search.formats in settings.yml). */
export class SearxngProvider implements SearchProvider {
  readonly name = 'searxng';
  private readonly base: string;
  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchHit[]> {
    const url = `${this.base}/search?${new URLSearchParams({ q: query, format: 'json' })}`;
    const data = (await getJson(url, { headers: { Accept: 'application/json' } }, signal, this.name)) as {
      results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
    };
    return toHits((data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), maxResults);
  }
}
