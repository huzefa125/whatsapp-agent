import { describe, it, expect, vi } from 'vitest';
import { AppError, ExternalServiceError, RateLimitError } from '../../src/utils/errors';
import { WhatsAppNotificationProvider } from '../../src/services/notifications/whatsapp-provider';
import { MockNotificationProvider } from '../../src/services/notifications/mock-provider';
import { NotificationError } from '../../src/services/notifications/types';
import type { IWhatsAppClient } from '../../src/services/whatsapp/client';

const req = { to: '+919876543210', idempotencyKey: 'reminder:1', content: { kind: 'text', text: 'hello' } } as const;
const ok = { messagingProduct: 'whatsapp', providerMessageId: 'wamid.ABC', recipientId: '919876543210' };

function providerFailing(err: unknown) {
  const client: IWhatsAppClient = { sendTextMessage: vi.fn().mockRejectedValue(err) };
  return new WhatsAppNotificationProvider(client)
    .send(req)
    .then(
      (): NotificationError => {
        throw new Error('expected the send to fail');
      },
      (e: unknown) => e as NotificationError
    );
}

describe('WhatsAppNotificationProvider', () => {
  it('returns the provider message ID as an ACCEPTANCE receipt and disables internal HTTP retries', async () => {
    const client: IWhatsAppClient = { sendTextMessage: vi.fn().mockResolvedValue(ok) };
    const receipt = await new WhatsAppNotificationProvider(client).send(req);
    expect(receipt).toMatchObject({ provider: 'whatsapp', providerMessageId: 'wamid.ABC' });
    expect(client.sendTextMessage).toHaveBeenCalledWith({ to: '+919876543210', text: 'hello', maxRetries: 0 });
  });

  it('sends approved templates with the body parameters', async () => {
    const sendTemplateMessage = vi.fn().mockResolvedValue(ok);
    const client: IWhatsAppClient = { sendTextMessage: vi.fn(), sendTemplateMessage };
    await new WhatsAppNotificationProvider(client).send({
      ...req,
      content: { kind: 'template', name: 'reminder_v1', language: 'en', bodyParameters: ['call the client'] },
    });
    expect(sendTemplateMessage).toHaveBeenCalledWith({
      to: '+919876543210',
      templateName: 'reminder_v1',
      languageCode: 'en',
      bodyParameters: ['call the client'],
      maxRetries: 0,
    });
  });

  it('fails permanently when the client cannot send templates', async () => {
    const client: IWhatsAppClient = { sendTextMessage: vi.fn() };
    const err = await new WhatsAppNotificationProvider(client)
      .send({ ...req, content: { kind: 'template', name: 't', language: 'en', bodyParameters: [] } })
      .catch((e) => e);
    expect(err).toMatchObject({ kind: 'permanent', code: 'TEMPLATE_UNSUPPORTED' });
  });

  it.each([
    ['rate limit', new RateLimitError('429'), 'retryable', 'PROVIDER_RATE_LIMITED'],
    ['5xx', new ExternalServiceError('WhatsApp API', 'boom', { statusCode: 503 }), 'retryable', 'PROVIDER_UNAVAILABLE'],
    ['Meta throughput code', new ExternalServiceError('WhatsApp API', 'x', { statusCode: 400, errorCode: 130429 }), 'retryable', 'PROVIDER_RATE_LIMITED'],
    ['bad token', new AppError('nope', 401, 'WHATSAPP_UNAUTHORIZED'), 'retryable', 'PROVIDER_UNAUTHORIZED'],
    ['timeout/network', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'retryable', 'PROVIDER_NETWORK_ERROR'],
    ['outside 24h window', new ExternalServiceError('WhatsApp API', 'x', { statusCode: 400, errorCode: 131047 }), 'permanent', 'OUTSIDE_MESSAGING_WINDOW'],
    ['undeliverable', new ExternalServiceError('WhatsApp API', 'x', { statusCode: 400, errorCode: 131026 }), 'permanent', 'RECIPIENT_UNDELIVERABLE'],
    ['template rejected', new ExternalServiceError('WhatsApp API', 'x', { statusCode: 400, errorCode: 132001 }), 'permanent', 'TEMPLATE_REJECTED'],
    ['invalid number', new AppError('bad', 400, 'WHATSAPP_INVALID_RECIPIENT'), 'permanent', 'INVALID_RECIPIENT'],
    ['other 4xx', new ExternalServiceError('WhatsApp API', 'x', { statusCode: 400, errorCode: 100 }), 'permanent', 'PROVIDER_REJECTED'],
  ])('classifies %s', async (_n, err, kind, code) => {
    expect(await providerFailing(err)).toMatchObject({ kind, code });
  });

  it('never leaks provider messages, tokens or message text into the sanitized error', async () => {
    const e = await providerFailing(
      new ExternalServiceError('WhatsApp API', 'Bearer EAAGsecrettoken failed for +919876543210: "call the client"', {
        statusCode: 400,
        errorCode: 100,
      })
    );
    expect(e.message).not.toContain('EAAG');
    expect(e.message).not.toContain('call the client');
    expect(e.message).not.toContain('919876543210');
  });

  it('carries a retry-after hint for rate limits', async () => {
    expect((await providerFailing(new RateLimitError('429'))).retryAfterMs).toBe(60_000);
  });
});

describe('MockNotificationProvider', () => {
  it('tags receipts as mock so they can never pass for real WhatsApp delivery', async () => {
    const receipt = await new MockNotificationProvider().send(req);
    expect(receipt.provider).toBe('mock');
    expect(receipt.providerMessageId.startsWith('mock:')).toBe(true);
  });

  it('honours idempotency keys like a provider that supports them', async () => {
    const mock = new MockNotificationProvider();
    const a = await mock.send(req);
    const b = await mock.send(req);
    expect(b.providerMessageId).toBe(a.providerMessageId);
    expect(mock.sent).toHaveLength(1);
  });

  it('plays back scripted failures', async () => {
    const mock = new MockNotificationProvider().enqueue(new NotificationError('retryable', 'X', 'x'));
    await expect(mock.send(req)).rejects.toMatchObject({ code: 'X' });
    await expect(mock.send(req)).resolves.toBeDefined();
  });
});
