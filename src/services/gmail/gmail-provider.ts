import type { IntegrationProvider, IntegrationStatus } from '../integrations/types';
import type { GmailOAuthService } from './gmail-oauth';
import type { GmailApiService } from './gmail-api';
import { createGmailTools } from './tools/gmail-tools';

/**
 * Gmail integration provider: registers Gmail as an official API integration
 * so it takes precedence over the browser fallback for mail.google.com.
 */
export class GmailIntegrationProvider implements IntegrationProvider {
  readonly id = 'gmail';
  readonly kind = 'api' as const;
  readonly displayName = 'Gmail';
  readonly capabilities = ['email'] as const;

  constructor(
    private readonly oauth: GmailOAuthService,
    private readonly api: GmailApiService,
  ) {}

  handlesHost(host: string): boolean {
    return host === 'mail.google.com' || host === 'gmail.com';
  }

  async status(userId: string): Promise<IntegrationStatus> {
    const gmailStatus = await this.oauth.getStatus(userId);
    return {
      state: gmailStatus.status === 'connected' ? 'connected'
        : gmailStatus.status === 'expired' ? 'expired'
        : 'not_connected',
      accounts: gmailStatus.email ? [gmailStatus.email] : [],
    };
  }

  async disconnect(userId: string): Promise<void> {
    await this.oauth.disconnect(userId);
  }

  tools() {
    return createGmailTools(this.api, this.oauth);
  }
}
