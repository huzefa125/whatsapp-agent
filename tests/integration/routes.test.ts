import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../../src/app';
import * as dbClient from '../../src/db/client';
import { setOutboxServiceForTesting } from '../../src/services/queue/outbox';
import { getConfig } from '../../src/config/env';

describe('HTTP API Integration Routes', () => {
  const app = createApp();
  const config = getConfig();
  const testSecret = config.WHATSAPP_APP_SECRET;
  const testVerifyToken = config.WHATSAPP_VERIFY_TOKEN;

  function createSignature(payload: string): string {
    const hmac = crypto.createHmac('sha256', testSecret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /health/live', () => {
    it('returns 200 with uptime and status ok', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptimeSeconds).toBe('number');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /docs and /docs.json (Swagger OpenAPI)', () => {
    it('returns 200 with OpenAPI 3.0 specification JSON', async () => {
      const res = await request(app).get('/docs.json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.openapi).toBe('3.0.3');
      expect(res.body.info.title).toContain('Instinct WhatsApp AI Agent');
      expect(res.body.paths['/health/live']).toBeDefined();
      expect(res.body.paths['/webhook']).toBeDefined();
    });

    it('returns Swagger UI HTML at /docs/', async () => {
      const res = await request(app).get('/docs/');
      expect([200, 301]).toContain(res.status);
      if (res.status === 200) {
        expect(res.text).toContain('swagger-ui');
      }
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 when database connection is healthy', async () => {
      vi.spyOn(dbClient, 'checkDatabaseConnection').mockResolvedValue({
        healthy: true,
        latencyMs: 12,
      });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks.database.status).toBe('connected');
      expect(res.body.checks.database.latencyMs).toBe(12);
    });

    it('returns 503 without leaking credentials when database fails', async () => {
      vi.spyOn(dbClient, 'checkDatabaseConnection').mockResolvedValue({
        healthy: false,
        error: 'connection timeout to 10.0.0.5:5432 with password [SECRET]',
      });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');
      expect(res.body.checks.database.status).toBe('disconnected');
      // Must not leak internal connection string details
      expect(JSON.stringify(res.body)).not.toContain('password');
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    });
  });

  describe('GET /webhook (Meta verification)', () => {
    it('returns challenge on valid token and subscribe mode', async () => {
      const res = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': testVerifyToken,
          'hub.challenge': 'CHALLENGE_STRING_123',
        });

      expect(res.status).toBe(200);
      expect(res.text).toBe('CHALLENGE_STRING_123');
    });

    it('returns 403 on invalid verify token', async () => {
      const res = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong_token',
          'hub.challenge': 'CHALLENGE_STRING_123',
        });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('returns 403 on invalid mode', async () => {
      const res = await request(app)
        .get('/webhook')
        .query({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': testVerifyToken,
          'hub.challenge': 'CHALLENGE_STRING_123',
        });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /webhook (Inbound events)', () => {
    const validPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15551234567',
                  phone_number_id: 'PN_1',
                },
                contacts: [{ profile: { name: 'Bob' }, wa_id: '15559876543' }],
                messages: [
                  {
                    from: '15559876543',
                    id: 'wamid.HBgLMTU1NTk4NzY1NDM=',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Hello agent!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    it('accepts valid incoming webhook with proper HMAC signature and enqueues event', async () => {
      const enqueueMock = vi.fn().mockResolvedValue(true);
      setOutboxServiceForTesting({
        enqueueInboundMessage: enqueueMock,
      } as any);

      const signature = createSignature(validPayload);

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('received');
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });

    it('rejects incoming webhook with invalid HMAC signature', async () => {
      const invalidSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', invalidSignature)
        .send(validPayload);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Error handling & Fallthrough', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(app).get('/non-existent-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 400 for malformed JSON payloads', async () => {
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send('{ invalid-json: ');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_JSON_PAYLOAD');
    });
  });
});
