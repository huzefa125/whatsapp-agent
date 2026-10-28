import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import * as env from '../../src/config/env';
import { setOutboxServiceForTesting } from '../../src/services/queue/outbox';

const SECRET = 'prod_app_secret_for_webhook_tests';
const payload = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '1', phone_number_id: 'PN' },
            messages: [{ from: '15551234567', id: 'wamid.SEC', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
          },
        },
      ],
    },
  ],
});
const sign = (body: string, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

describe('POST /webhook security by environment', () => {
  const enqueue = vi.fn().mockResolvedValue(true);
  const app = createApp();

  function runAs(nodeEnv: 'production' | 'development') {
    const real = env.getConfig();
    vi.spyOn(env, 'getConfig').mockReturnValue({ ...real, NODE_ENV: nodeEnv, WHATSAPP_APP_SECRET: SECRET });
  }
  const post = (headers: Record<string, string> = {}) =>
    request(app).post('/webhook').set('Content-Type', 'application/json').set(headers).send(payload);

  beforeEach(() => {
    vi.restoreAllMocks();
    enqueue.mockClear();
    setOutboxServiceForTesting({ enqueueInboundMessage: enqueue } as any);
  });

  it('production: rejects a request with no signature and processes nothing', async () => {
    runAs('production');
    const res = await post();
    expect(res.status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('production: rejects a signature made with the wrong secret, or for a different body', async () => {
    runAs('production');
    expect((await post({ 'X-Hub-Signature-256': sign(payload, 'attacker') })).status).toBe(403);
    expect((await post({ 'X-Hub-Signature-256': sign('{"tampered":true}') })).status).toBe(403);
    expect((await post({ 'X-Hub-Signature-256': 'sha256=zz' })).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('production: accepts the genuine signature', async () => {
    runAs('production');
    const res = await post({ 'X-Hub-Signature-256': sign(payload) });
    expect(res.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('development: a present-but-wrong signature is still rejected', async () => {
    runAs('development');
    expect((await post({ 'X-Hub-Signature-256': sign(payload, 'attacker') })).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
