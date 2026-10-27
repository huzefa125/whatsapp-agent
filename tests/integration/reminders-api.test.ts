import { hasTestDb, createTestUser, deleteTestUser, resetReminderTables, setTestUserTimezone, type TestUser } from '../helpers/test-db';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app';
import { closeDatabaseConnection, getDb } from '../../src/db/client';
import { reminders, users } from '../../src/db/schema';
import { FakeClock } from '../../src/utils/clock';
import { ReminderService, setReminderServiceForTesting } from '../../src/services/reminders/reminder-service';

// Tue 27 Oct 2026, 12:00 UTC == 17:30 Asia/Kolkata
const NOW = new Date('2026-10-27T12:00:00Z');
const tomorrow10 = { kind: 'local', date: '2026-10-28', time: '10:00' };

describe.skipIf(!hasTestDb)('Reminders API', () => {
  const app = createApp();
  const clock = new FakeClock(NOW);
  const made: string[] = [];

  const as = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
  async function mk(tz: string | null = 'Asia/Kolkata') {
    const u = await createTestUser();
    made.push(u.id);
    await setTestUserTimezone(u.id, tz);
    return u;
  }
  const post = (u: TestUser, body: object, headers: Record<string, string> = {}) =>
    request(app).post('/api/reminders').set(as(u)).set(headers).send(body);

  beforeAll(async () => {
    setReminderServiceForTesting(new ReminderService({ clock }));
    await resetReminderTables();
  });
  afterEach(async () => {
    clock.set(NOW);
    await getDb().delete(reminders);
  });
  afterAll(async () => {
    setReminderServiceForTesting(null);
    for (const id of made) await deleteTestUser(id);
    await closeDatabaseConnection();
  });

  it('requires a valid session on every endpoint', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (const call of [
      request(app).post('/api/reminders').send({}),
      request(app).get('/api/reminders'),
      request(app).get(`/api/reminders/${id}`),
      request(app).patch(`/api/reminders/${id}`).send({}),
      request(app).delete(`/api/reminders/${id}`),
      request(app).patch('/api/users/me').send({ timezone: 'UTC' }),
    ]) {
      expect((await call).status).toBe(401);
    }
    expect((await request(app).get('/api/reminders').set('Authorization', 'Bearer bogus')).status).toBe(401);
  });

  describe('PATCH /api/users/me (timezone)', () => {
    it('saves a valid IANA timezone and rejects abbreviations, offsets and junk', async () => {
      const u = await mk(null);
      const ok = await request(app).patch('/api/users/me').set(as(u)).send({ timezone: 'Asia/Kolkata' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ timezone: 'Asia/Kolkata' });
      const [row] = await getDb().select().from(users).where(eq(users.id, u.id));
      expect(row!.timezone).toBe('Asia/Kolkata');

      for (const bad of ['IST', 'EST', '+05:30', 'Mars/Base', '', "Asia/Kolkata'; DROP TABLE users;--"]) {
        const res = await request(app).patch('/api/users/me').set(as(u)).send({ timezone: bad });
        expect(res.status, bad).toBe(400);
      }
      expect((await request(app).patch('/api/users/me').set(as(u)).send({ timezone: 'UTC', email: 'x@y.z' })).status).toBe(400);
      const [after] = await getDb().select().from(users).where(eq(users.id, u.id));
      expect(after!.timezone).toBe('Asia/Kolkata');
    });
  });

  describe('POST /api/reminders', () => {
    it('creates a reminder (201) and returns the interpreted local time, never internals', async () => {
      const u = await mk();
      const res = await post(u, { title: 'call the client', when: tomorrow10 });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toMatchObject({
        title: 'call the client',
        status: 'scheduled',
        remindAt: '2026-10-28T04:30:00.000Z',
        remindAtLocal: 'Wed, 28 Oct 2026, 10:00 (Asia/Kolkata, UTC+05:30)',
        timezone: 'Asia/Kolkata',
        delivery: { state: 'not_sent', simulated: false },
      });
      for (const internal of ['lockedBy', 'leaseExpiresAt', 'userId', 'idempotencyKey', 'providerMessageId', 'nextAttemptAt']) {
        expect(res.body.data).not.toHaveProperty(internal);
      }
    });

    it('takes identity only from the session', async () => {
      const alice = await mk();
      const bob = await mk();
      const res = await post(alice, { title: 'x', when: tomorrow10, userId: bob.id });
      expect(res.status).toBe(201);
      const [row] = await getDb().select().from(reminders);
      expect(row!.userId).toBe(alice.id);
    });

    it('returns 422 with a clear code when the time cannot be scheduled', async () => {
      const u = await mk();
      expect((await post(u, { title: 'x', when: { kind: 'local', date: '2026-10-27', time: '09:00' } })).body).toMatchObject({ status: 'error', code: 'TIME_IN_PAST' });
      expect((await post(u, { title: 'x', when: { kind: 'local', date: '2030-01-01', time: '09:00' } })).body.code).toBe('BEYOND_HORIZON');
      const res = await post(u, { title: 'x', when: { kind: 'local', date: '2026-10-27', time: '09:00' } });
      expect(res.status).toBe(422);
      expect(res.body.stack).toBeUndefined();

      const noTz = await mk(null);
      const missing = await post(noTz, { title: 'x', when: tomorrow10 });
      expect(missing.status).toBe(422);
      expect(missing.body.code).toBe('TIMEZONE_REQUIRED');
      expect(await getDb().select().from(reminders)).toHaveLength(0);
    });

    it('validates the body with 400s', async () => {
      const u = await mk();
      const bad: object[] = [
        {},
        { title: 'x' },
        { when: tomorrow10 },
        { title: '', when: tomorrow10 },
        { title: 'x', when: { kind: 'local', date: '2026-10-28' } }, // missing time is never invented
        { title: 'x', when: { kind: 'local', date: 'tomorrow', time: '10:00' } },
        { title: 'x', when: { kind: 'sometime' } },
        { title: 'x', when: { kind: 'relative', amount: -5, unit: 'minutes' } },
        { title: 'x', when: { kind: 'instant', at: '2026-10-28T10:00:00' } },
      ];
      // The write limiter counts invalid requests too, so spread the cases over a few users.
      let who = u;
      for (const [i, body] of bad.entries()) {
        if (i > 0 && i % 4 === 0) who = await mk();
        expect((await post(who, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('rejects oversized titles instead of truncating them', async () => {
      const u = await mk();
      const res = await post(u, { title: 'x'.repeat(501), when: tomorrow10 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TITLE_TOO_LONG');
    });

    it('replays an Idempotency-Key (200) and rejects reuse with different content (409)', async () => {
      const u = await mk();
      const h = { 'Idempotency-Key': 'wa-retry-1' };
      const first = await post(u, { title: 'call', when: tomorrow10 }, h);
      const replay = await post(u, { title: 'call', when: tomorrow10 }, h);
      const clash = await post(u, { title: 'different', when: tomorrow10 }, h);
      expect([first.status, replay.status, clash.status]).toEqual([201, 200, 409]);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(await getDb().select().from(reminders)).toHaveLength(1);
    });
  });

  describe('GET /api/reminders and /:id', () => {
    it('lists only my reminders, with filters, ordering and bounded pagination', async () => {
      const alice = await mk();
      const bob = await mk();
      const ids: string[] = [];
      for (const [title, minutes] of [['c', 90], ['a', 10], ['b', 60]] as const) {
        ids.push((await post(alice, { title, when: { kind: 'relative', amount: minutes, unit: 'minutes' } })).body.data.id);
      }
      await post(bob, { title: 'bobs', when: tomorrow10 });
      await request(app).delete(`/api/reminders/${ids[0]}`).set(as(alice));

      const upcoming = await request(app).get('/api/reminders?upcoming=true').set(as(alice));
      expect(upcoming.body.data.map((r: { title: string }) => r.title)).toEqual(['a', 'b']);
      const cancelled = await request(app).get('/api/reminders?status=cancelled').set(as(alice));
      expect(cancelled.body.data.map((r: { title: string }) => r.title)).toEqual(['c']);
      const page = await request(app).get('/api/reminders?upcoming=true&limit=1&offset=1').set(as(alice));
      expect(page.body.data.map((r: { title: string }) => r.title)).toEqual(['b']);
      expect((await request(app).get('/api/reminders').set(as(bob))).body.data).toHaveLength(1);

      for (const q of ['limit=0', 'limit=101', 'offset=-1', 'status=bogus', 'upcoming=maybe', 'limit=abc']) {
        expect((await request(app).get(`/api/reminders?${q}`).set(as(alice))).status, q).toBe(400);
      }
    });

    it('returns one reminder, 404 for unknown or foreign IDs, 400 for malformed IDs', async () => {
      const alice = await mk();
      const bob = await mk();
      const id = (await post(alice, { title: 'mine', when: tomorrow10 })).body.data.id;
      expect((await request(app).get(`/api/reminders/${id}`).set(as(alice))).body.data.title).toBe('mine');
      expect((await request(app).get(`/api/reminders/${id}`).set(as(bob))).status).toBe(404);
      expect((await request(app).get('/api/reminders/22222222-2222-4222-8222-222222222222').set(as(alice))).status).toBe(404);
      expect((await request(app).get('/api/reminders/not-a-uuid').set(as(alice))).status).toBe(400);
    });
  });

  describe('PATCH and DELETE', () => {
    it('reschedules, retitles and marks completed', async () => {
      const u = await mk();
      const id = (await post(u, { title: 'meeting', when: tomorrow10 })).body.data.id;

      const moved = await request(app).patch(`/api/reminders/${id}`).set(as(u)).send({ when: { kind: 'local', date: '2026-10-30', time: '15:00' } });
      expect(moved.status).toBe(200);
      expect(moved.body.data.remindAt).toBe('2026-10-30T09:30:00.000Z');
      expect((await request(app).patch(`/api/reminders/${id}`).set(as(u)).send({ title: 'standup' })).body.data.title).toBe('standup');
      const done = await request(app).patch(`/api/reminders/${id}`).set(as(u)).send({ status: 'completed' });
      expect(done.body.data.status).toBe('completed');
      expect((await request(app).patch(`/api/reminders/${id}`).set(as(u)).send({ title: 'too late' })).status).toBe(409);
    });

    it('rejects empty, conflicting and unknown patch fields', async () => {
      const u = await mk();
      const id = (await post(u, { title: 'x', when: tomorrow10 })).body.data.id;
      for (const body of [{}, { status: 'completed', title: 'x' }, { status: 'sent' }, { userId: u.id }, { remindAt: '2026-10-30T00:00:00Z' }]) {
        expect((await request(app).patch(`/api/reminders/${id}`).set(as(u)).send(body)).status, JSON.stringify(body)).toBe(400);
      }
      const past = await request(app).patch(`/api/reminders/${id}`).set(as(u)).send({ when: { kind: 'local', date: '2026-10-01', time: '10:00' } });
      expect(past.status).toBe(422);
      expect(past.body.code).toBe('TIME_IN_PAST');
    });

    it('DELETE cancels (keeping the record) and a second DELETE is a 409', async () => {
      const u = await mk();
      const id = (await post(u, { title: 'x', when: tomorrow10 })).body.data.id;
      const del = await request(app).delete(`/api/reminders/${id}`).set(as(u));
      expect(del.status).toBe(200);
      expect(del.body.data.status).toBe('cancelled');
      expect((await request(app).delete(`/api/reminders/${id}`).set(as(u))).status).toBe(409);
      expect((await request(app).get(`/api/reminders/${id}`).set(as(u))).body.data.status).toBe('cancelled');
    });

    it('lets nobody modify or cancel another user’s reminder', async () => {
      const alice = await mk();
      const bob = await mk();
      const id = (await post(alice, { title: 'private', when: tomorrow10 })).body.data.id;
      expect((await request(app).patch(`/api/reminders/${id}`).set(as(bob)).send({ title: 'hacked' })).status).toBe(404);
      expect((await request(app).patch(`/api/reminders/${id}`).set(as(bob)).send({ status: 'completed' })).status).toBe(404);
      expect((await request(app).delete(`/api/reminders/${id}`).set(as(bob))).status).toBe(404);
      const [row] = await getDb().select().from(reminders).where(eq(reminders.id, id));
      expect(row).toMatchObject({ title: 'private', status: 'scheduled' });
    });
  });

  it('rate-limits writes per user (not reads, not other users)', async () => {
    const heavy = await mk();
    const other = await mk();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await post(heavy, { title: `r${i}`, when: { kind: 'relative', amount: 10 + i, unit: 'minutes' } })).status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
    expect((await request(app).get('/api/reminders').set(as(heavy))).status).toBe(200);
    expect((await post(other, { title: 'fine', when: tomorrow10 })).status).toBe(201);
    const limited = await post(heavy, { title: 'again', when: tomorrow10 });
    expect(limited.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  describe('WhatsApp status webhook', () => {
    const statusPayload = (id: string, status: string, errors?: object[]) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000000', phone_number_id: '1234567890' },
                statuses: [{ id, status, timestamp: '1793103030', recipient_id: '919876543210', ...(errors ? { errors } : {}) }],
              },
            },
          ],
        },
      ],
    });
    async function sentViaWhatsApp(u: TestUser, wamid: string) {
      const id = (await post(u, { title: 'x', when: { kind: 'relative', amount: 5, unit: 'minutes' } })).body.data.id;
      await getDb()
        .update(reminders)
        .set({ status: 'sent', deliveryProvider: 'whatsapp', providerMessageId: wamid, acceptedAt: NOW })
        .where(eq(reminders.id, id));
      return id as string;
    }

    it('confirms delivery only when WhatsApp says so', async () => {
      const u = await mk();
      const id = await sentViaWhatsApp(u, 'wamid.API_DELIVER');
      expect((await request(app).get(`/api/reminders/${id}`).set(as(u))).body.data.delivery.state).toBe('accepted_by_provider');

      expect((await request(app).post('/webhook').send(statusPayload('wamid.API_DELIVER', 'delivered'))).status).toBe(200);
      const view = (await request(app).get(`/api/reminders/${id}`).set(as(u))).body.data;
      expect(view.delivery.state).toBe('delivered');
      expect(view.delivery.deliveredAt).toBeTruthy();
    });

    it('records a provider-reported failure', async () => {
      const u = await mk();
      const id = await sentViaWhatsApp(u, 'wamid.API_FAIL');
      await request(app).post('/webhook').send(statusPayload('wamid.API_FAIL', 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
      const view = (await request(app).get(`/api/reminders/${id}`).set(as(u))).body.data;
      expect(view).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_DELIVERY_FAILED' } });
    });

    it('acknowledges statuses for unknown messages without error', async () => {
      expect((await request(app).post('/webhook').send(statusPayload('wamid.NOBODY', 'delivered'))).status).toBe(200);
    });
  });
});
