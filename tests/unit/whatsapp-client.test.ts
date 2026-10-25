import { describe, it, expect, vi, afterEach } from 'vitest';
import { WhatsAppClient } from '../../src/services/whatsapp/client';
import { RateLimitError } from '../../src/utils/errors';

describe('WhatsApp Graph API Client', () => {
  const validConfig = {
    accessToken: 'test_access_token_123',
    phoneNumberId: '9876543210',
    apiVersion: 'v21.0',
    timeoutMs: 1000,
  };

  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws error if accessToken or phoneNumberId is missing', () => {
    expect(() => new WhatsAppClient({ accessToken: '', phoneNumberId: '123' })).toThrow(
      /Access token is missing/
    );
    expect(() => new WhatsAppClient({ accessToken: 'token', phoneNumberId: '' })).toThrow(
      /Phone Number ID is missing/
    );
  });

  it('rejects invalid recipient phone numbers', async () => {
    const client = new WhatsAppClient(validConfig);
    await expect(
      client.sendTextMessage({ to: '123', text: 'Hello' })
    ).rejects.toThrow(/Invalid recipient phone number/);
  });

  it('rejects empty message body', async () => {
    const client = new WhatsAppClient(validConfig);
    await expect(
      client.sendTextMessage({ to: '+15551234567', text: '   ' })
    ).rejects.toThrow(/Message body cannot be empty/);
  });

  it('successfully dispatches text message and parses response', async () => {
    const client = new WhatsAppClient(validConfig);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messaging_product: 'whatsapp',
        contacts: [{ input: '15551234567', wa_id: '15551234567' }],
        messages: [{ id: 'wamid.HBgLMTU1NTEyMzQ1Njc=' }],
      }),
    } as unknown as Response);

    const result = await client.sendTextMessage({
      to: '+1 (555) 123-4567',
      text: 'Hello from Instinct!',
    });

    expect(result.messagingProduct).toBe('whatsapp');
    expect(result.providerMessageId).toBe('wamid.HBgLMTU1NTEyMzQ1Njc=');
    expect(result.recipientId).toBe('15551234567');
  });

  it('handles Meta 429 rate limit correctly', async () => {
    const client = new WhatsAppClient(validConfig);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: {
          message: 'Rate limit hit',
          type: 'OAuthException',
          code: 80007,
        },
      }),
    } as unknown as Response);

    await expect(
      client.sendTextMessage({ to: '15551234567', text: 'Hi' })
    ).rejects.toThrow(RateLimitError);
  });

  it('handles Meta 401 token authentication failure', async () => {
    const client = new WhatsAppClient(validConfig);

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Invalid OAuth access token',
          type: 'OAuthException',
          code: 190,
        },
      }),
    } as unknown as Response);

    await expect(
      client.sendTextMessage({ to: '15551234567', text: 'Hi' })
    ).rejects.toThrow(/WhatsApp token unauthorized/);
  });
});
