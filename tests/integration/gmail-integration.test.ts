import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { setGmailServicesForTesting } from '../../src/services/gmail';
import type { GmailOAuthService } from '../../src/services/gmail/gmail-oauth';
import type { GmailApiService } from '../../src/services/gmail/gmail-api';
import { GmailIntegrationProvider } from '../../src/services/gmail/gmail-provider';
import { IntegrationRegistry } from '../../src/services/integrations/registry';

describe('Gmail Integration Tests', () => {
  const app = createApp();

  let mockOAuth: GmailOAuthService;
  let mockApi: GmailApiService;

  beforeEach(() => {
    vi.restoreAllMocks();

    mockOAuth = {
      startAuthorization: vi.fn().mockResolvedValue({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?test=1' }),
      handleCallback: vi.fn().mockResolvedValue({ email: 'user@example.com', userId: 'user-1' }),
      getStatus: vi.fn().mockResolvedValue({ status: 'connected', email: 'user@example.com', scopes: ['gmail.readonly'] }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getAuthenticatedClient: vi.fn().mockResolvedValue({ client: {} as any, connectionId: 'conn-1', scopes: [] }),
      hasSendScope: vi.fn().mockResolvedValue(true),
    };

    mockApi = {
      searchEmails: vi.fn().mockResolvedValue([
        { id: 'msg-1', threadId: 'th-1', from: 'alice@example.com', subject: 'Report', date: '2026-10-29', snippet: 'Q3 numbers' },
      ]),
      readEmail: vi.fn().mockResolvedValue({
        id: 'msg-1',
        threadId: 'th-1',
        from: 'alice@example.com',
        to: 'user@example.com',
        subject: 'Report',
        date: '2026-10-29',
        body: 'Here are the Q3 numbers',
        hasAttachments: false,
      }),
      listThreadMessages: vi.fn().mockResolvedValue([]),
      createDraft: vi.fn().mockResolvedValue({
        draftId: 'd-1',
        messageId: 'm-draft',
        to: 'alice@example.com',
        subject: 'Re: Report',
        bodyPreview: 'Thanks',
      }),
      sendDraft: vi.fn().mockResolvedValue({
        messageId: 'm-sent',
        threadId: 'th-1',
        duplicate: false,
      }),
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true,
        email: 'user@example.com',
      }),
    };

    setGmailServicesForTesting(mockOAuth, mockApi);
  });

  describe('GET /api/gmail/oauth/callback', () => {
    it('returns 400 when missing state or code query params', async () => {
      const res = await request(app).get('/api/gmail/oauth/callback');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('GMAIL_OAUTH_INVALID');
      expect(res.body.ok).toBe(false);
    });

    it('returns 400 when Google returns an error (e.g. access_denied)', async () => {
      const res = await request(app).get('/api/gmail/oauth/callback?error=access_denied');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('GMAIL_OAUTH_DENIED');
      expect(res.body.message).toContain('access_denied');
    });

    it('returns 400 with safe message when state is expired or invalid', async () => {
      (mockOAuth.handleCallback as any).mockRejectedValueOnce(new Error('Invalid or expired OAuth state'));
      const res = await request(app).get('/api/gmail/oauth/callback?state=bad-state&code=auth-code');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('GMAIL_OAUTH_FAILED');
      expect(res.body.message).toContain('expired');
    });

    it('returns 400 when state has already been used', async () => {
      (mockOAuth.handleCallback as any).mockRejectedValueOnce(new Error('OAuth state has already been used'));
      const res = await request(app).get('/api/gmail/oauth/callback?state=used-state&code=auth-code');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('GMAIL_OAUTH_FAILED');
      expect(res.body.message).toContain('already been used');
    });

    it('returns 200 on successful OAuth exchange', async () => {
      const res = await request(app).get('/api/gmail/oauth/callback?state=valid-state&code=valid-code');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.email).toBe('user@example.com');
      expect(res.body.message).toContain('Gmail connected successfully');
      expect(mockOAuth.handleCallback).toHaveBeenCalledWith('valid-state', 'valid-code');
    });
  });

  describe('GmailIntegrationProvider', () => {
    it('registers into registry and claims mail.google.com and gmail.com hosts', () => {
      const provider = new GmailIntegrationProvider(mockOAuth, mockApi);
      const registry = new IntegrationRegistry();
      registry.register(provider);

      expect(registry.resolveForHost('mail.google.com')?.id).toBe('gmail');
      expect(registry.resolveForHost('gmail.com')?.id).toBe('gmail');
      expect(registry.resolveForHost('other.com')).toBeUndefined();
      expect(provider.capabilities).toContain('email');
    });

    it('reports status correctly', async () => {
      const provider = new GmailIntegrationProvider(mockOAuth, mockApi);
      const status = await provider.status('user-1');
      expect(status.state).toBe('connected');
      expect(status.accounts).toEqual(['user@example.com']);
    });

    it('disconnects via oauth service', async () => {
      const provider = new GmailIntegrationProvider(mockOAuth, mockApi);
      await provider.disconnect('user-1');
      expect(mockOAuth.disconnect).toHaveBeenCalledWith('user-1');
    });

    it('exposes all tools to registry', () => {
      const provider = new GmailIntegrationProvider(mockOAuth, mockApi);
      const tools = provider.tools();
      expect(tools.length).toBe(8);
      expect(tools.map((t) => t.name)).toContain('gmail_search');
      expect(tools.map((t) => t.name)).toContain('gmail_send_draft');
    });
  });
});
