import { describe, it, expect } from 'vitest';
import { IntegrationRegistry } from '../../src/services/integrations/registry';
import type { IntegrationProvider } from '../../src/services/integrations/types';

const provider = (over: Partial<IntegrationProvider> & { id: string; kind: IntegrationProvider['kind'] }): IntegrationProvider => ({
  displayName: over.id,
  capabilities: ['web'],
  status: async () => ({ state: 'not_connected', accounts: [] }),
  disconnect: async () => undefined,
  tools: () => [],
  ...over,
});

describe('IntegrationRegistry', () => {
  const browser = provider({ id: 'browser.web', kind: 'browser', capabilities: ['web', 'forms', 'booking'] });
  const gmail = provider({ id: 'gmail', kind: 'api', capabilities: ['email'], handlesHost: (h) => h === 'mail.google.com' });
  const calendar = provider({ id: 'gcal', kind: 'api', capabilities: ['calendar', 'booking'], handlesHost: (h) => h === 'calendar.google.com' });

  const registry = () => new IntegrationRegistry().register(browser).register(gmail).register(calendar);

  it('prefers official API providers over the browser for a capability', () => {
    expect(registry().forCapability('booking').map((p) => p.id)).toEqual(['gcal', 'browser.web']);
    expect(registry().forCapability('email').map((p) => p.id)).toEqual(['gmail']);
  });

  it('routes a host to the API provider that claims it, and everything else to the browser fallback', () => {
    expect(registry().resolveForHost('mail.google.com')?.id).toBe('gmail');
    expect(registry().resolveForHost('shop.example.com')?.id).toBe('browser.web');
  });

  it('has no fallback when the browser provider is not registered', () => {
    expect(new IntegrationRegistry().register(gmail).resolveForHost('shop.example.com')).toBeUndefined();
  });

  it('rejects duplicate ids and providers without capabilities', () => {
    expect(() => registry().register(provider({ id: 'gmail', kind: 'api' }))).toThrow('already registered');
    expect(() => new IntegrationRegistry().register(provider({ id: 'x', kind: 'api', capabilities: [] }))).toThrow('capabilities');
  });

  it('collects the tools of every provider', () => {
    const tool = { name: 'send_mail' } as never;
    expect(new IntegrationRegistry().register(provider({ id: 'a', kind: 'api', tools: () => [tool] })).allTools()).toEqual([tool]);
  });
});
