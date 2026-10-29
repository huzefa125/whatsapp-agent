import { createBrowserTools } from '../browser/browser-tools';
import type { BrowserService } from '../browser/browser-service';
import { getHandoffService } from '../browser/handoff';
import type { IntegrationProvider, IntegrationStatus } from './types';

/** The generic fallback: any website the user authorizes, driven through the browser engine. */
export class BrowserIntegrationProvider implements IntegrationProvider {
  readonly id = 'browser.web';
  readonly kind = 'browser' as const;
  readonly displayName = 'Websites (browser)';
  readonly capabilities = ['web', 'forms', 'booking', 'travel', 'crm'] as const;

  constructor(private readonly service: BrowserService) {}

  async status(userId: string): Promise<IntegrationStatus> {
    const connections = await this.service.connections.list(userId);
    const usable = connections.filter((c) => c.status === 'connected');
    const expired = connections.some((c) => c.status === 'expired');
    return {
      state: usable.length > 0 ? 'connected' : expired ? 'expired' : 'not_connected',
      accounts: connections.map((c) => c.origin),
    };
  }

  async disconnect(userId: string): Promise<void> {
    for (const c of await this.service.connections.list(userId)) await this.service.disconnect(userId, c.id);
  }

  tools() {
    return createBrowserTools(this.service, { handoffs: getHandoffService() });
  }
}
