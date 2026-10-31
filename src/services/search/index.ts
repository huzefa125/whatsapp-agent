import { getConfig } from '../../config/env';
import type { ToolDefinition } from '../agent/engine/types';
import { BraveProvider, SearxngProvider, TavilyProvider, type SearchProvider } from './providers';
import { createWebSearchTool } from './web-search-tool';

export * from './providers';
export * from './web-search-tool';

/** The configured provider, or null when web search is off. Config validation guarantees the needed key or URL. */
export function getSearchProvider(): SearchProvider | null {
  const c = getConfig();
  switch (c.WEB_SEARCH_PROVIDER) {
    case 'tavily':
      return new TavilyProvider(c.WEB_SEARCH_API_KEY);
    case 'brave':
      return new BraveProvider(c.WEB_SEARCH_API_KEY);
    case 'searxng':
      return new SearxngProvider(c.WEB_SEARCH_URL);
    default:
      return null;
  }
}

/** The web_search tool when a provider is configured; an empty list otherwise (the bot then says it cannot look things up). */
export function createSearchTools(): Array<ToolDefinition<any, any>> {
  const provider = getSearchProvider();
  if (!provider) return [];
  const c = getConfig();
  return [createWebSearchTool(provider, { maxResults: c.WEB_SEARCH_MAX_RESULTS, dailyLimitPerUser: c.WEB_SEARCH_DAILY_LIMIT_PER_USER })];
}
