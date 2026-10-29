import { hasChromium } from '../helpers/chromium';
import { hasTestDb, createTestUser, createTestConversation, deleteTestUser, resetAgentTables, type TestUser } from '../helpers/test-db';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app';
import { getDb, closeDatabaseConnection } from '../../src/db/client';
import { agentTasks, browserConnections, browserHandoffs, browserRuns, type BrowserHandoff } from '../../src/db/schema';
import { AgentRunner, AgentTaskRepository, AgentTaskService, ToolRegistry, type PermissionResolver } from '../../src/services/agent/engine';
import { getAgentTaskService } from '../../src/services/agent/engine/task-service';
import { BrowserService, createBrowserTools, type BrowserSettings } from '../../src/services/browser';
import { BrowserConnectionService } from '../../src/services/browser/connection-service';
import { BrowserRunRepository } from '../../src/services/browser/run-repository';
import {
  AgentTaskResumer,
  HandoffService,
  setHandoffServiceForTesting,
  type HandoffNotifier,
  type HandoffSettings,
  type TaskResumer,
} from '../../src/services/browser/handoff';
import { resetHandoffLimitersForTesting } from '../../src/controllers/handoff.controller';
import { csrfTokenFor, hashToken } from '../../src/utils/handoff-token';
import { generateEncryptionKey } from '../../src/utils/secret-box';
import { logger } from '../../src/utils/logger';
import { ScriptedProvider, text, toolCalls, type ScriptStep } from '../helpers/scripted-provider';
import { startTestSite, type TestSite } from '../helpers/test-site';

const KEY = generateEncryptionKey();
const PASSWORD = 'correct-horse';
const EMAIL = 'demo@example.com';

class MockNotifier implements HandoffNotifier {
  messages: Array<{ userId: string; text: string; key: string }> = [];
  fail = false;
  async send(userId: string, text: string, key: string) {
    if (this.fail) throw new Error('provider down');
    this.messages.push({ userId, text, key });
  }
  get links(): string[] {
    return this.messages.map((m) => m.text.match(/https:\/\/handoff\.test\/handoff\/([A-Za-z0-9_-]{43})/)?.[1]).filter(Boolean) as string[];
  }
  get lastToken(): string {
    return this.links.at(-1)!;
  }
}

class MockResumer implements TaskResumer {
  calls: Array<{ handoff: BrowserHandoff; host: string }> = [];
  async resume(handoff: BrowserHandoff, host: string) {
    this.calls.push({ handoff, host });
    return crypto.randomUUID();
  }
}

class StaticPermissions implements PermissionResolver {
  async resolve(userId: string) {
    return { userId, permissions: new Set(['browser:read', 'browser:write']) };
  }
}

const browserSettings = (allowPrivateNetwork = true): BrowserSettings => ({
  maxSteps: 60,
  maxNavigations: 30,
  maxRunMs: 300_000,
  idleMs: 300_000,
  session: { navTimeoutMs: 6000, actionTimeoutMs: 3000, maxText: 4000, maxElements: 60, blockUnconfirmedMutations: true, maxRequests: 500 },
  manager: { headless: true, maxSessions: 8, maxSessionsPerUser: 1 },
  policy: { allowedDomains: [], blockedDomains: [], allowPrivateNetwork },
});

const handoffSettings = (over: Partial<HandoffSettings> = {}): HandoffSettings => ({
  baseUrl: 'https://handoff.test',
  linkTtlMs: 600_000,
  sessionMs: 600_000,
  idleMs: 120_000,
  maxPerHour: 20,
  extraHosts: [],
  allowHttp: true,
  ...over,
});

async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
}

const stripNonce = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce=""').replace(/'nonce-[^']*'/g, "'nonce-'");

describe.skipIf(!hasTestDb || !hasChromium)('Remote browser handoff (HTTP + PostgreSQL + Chromium)', () => {
  let site: TestSite;
  let alice: TestUser;
  let bob: TestUser;
  const toDelete: string[] = [];
  const browsers: BrowserService[] = [];
  let seq = 0;
  const key = () => `hk-${Date.now()}-${seq++}`;

  beforeAll(async () => {
    await resetAgentTables();
    site = await startTestSite();
    alice = await createTestUser();
    bob = await createTestUser();
    toDelete.push(alice.id, bob.id);
  }, 60000);

  beforeEach(() => resetHandoffLimitersForTesting());

  afterEach(async () => {
    vi.restoreAllMocks();
    setHandoffServiceForTesting(null);
    await Promise.all(browsers.splice(0).map((b) => b.shutdown()));
    await getDb().delete(browserHandoffs);
    await getDb().delete(browserRuns);
    await getDb().delete(browserConnections);
    await getDb().delete(agentTasks);
    site.posts.length = 0;
    site.hits.clear();
  }, 90000);

  afterAll(async () => {
    for (const id of toDelete) await deleteTestUser(id);
    await site.close();
    await closeDatabaseConnection();
  }, 60000);

  function build(opts: { settings?: Partial<HandoffSettings>; allowPrivate?: boolean; resumer?: TaskResumer; keyConfigured?: boolean } = {}) {
    const bs = browserSettings(opts.allowPrivate ?? true);
    const browser = new BrowserService(bs, new BrowserRunRepository(), new BrowserConnectionService(() => (opts.keyConfigured === false ? '' : KEY)));
    browsers.push(browser);
    const notifier = new MockNotifier();
    const resumer = new MockResumer();
    const service = new HandoffService({ settings: handoffSettings(opts.settings), browser, notifier, resumer: opts.resumer ?? resumer });
    setHandoffServiceForTesting(service);
    return { browser, service, notifier, resumer, app: createApp() };
  }

  /** A run that has hit the login page: the situation in which the agent asks the user to sign in. */
  async function loginRun(browser: BrowserService, userId = alice.id, path = '/account') {
    return (await browser.startRun(userId, { url: `${site.url}${path}`, idempotencyKey: key() })).run;
  }

  async function redeem(app: ReturnType<typeof createApp>, token: string) {
    const res = await request(app).post(`/handoff/${token}/start`);
    const secret = /hs=([A-Za-z0-9_-]+)/.exec(String(res.headers['set-cookie']))?.[1];
    return { res, secret: secret!, csrf: secret ? csrfTokenFor(secret) : '' };
  }

  const as = (app: ReturnType<typeof createApp>, secret: string) => ({
    get: (path: string) => request(app).get(path).set('Cookie', `hs=${secret}`),
    post: (path: string, body: unknown = {}, csrf = csrfTokenFor(secret)) =>
      request(app).post(path).set('Cookie', `hs=${secret}`).set('X-CSRF-Token', csrf).send(body as object),
  });

  async function row(id: string) {
    return (await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.id, id)))[0]!;
  }

  /** Starts a handoff to the login page and opens it as the user would. */
  async function openHandoff(ctx: ReturnType<typeof build>, userId = alice.id, path = '/account') {
    const run = await loginRun(ctx.browser, userId, path);
    const { handoff } = await ctx.service.createAndSend(userId, { runId: run.id, reason: 'login', idempotencyKey: key() });
    const token = ctx.notifier.lastToken;
    const { secret } = await redeem(ctx.app, token);
    return { run, handoff, token, secret, user: as(ctx.app, secret) };
  }

  // ===================================================================== link creation and token storage

  it('sends a single-use link on WhatsApp and stores only its hash', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff, alreadySent } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    expect(alreadySent).toBe(false);

    expect(ctx.notifier.messages).toHaveLength(1);
    expect(ctx.notifier.messages[0]!.userId).toBe(alice.id);
    const token = ctx.notifier.lastToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ctx.notifier.messages[0]!.text).toContain('expires in 10 minutes');

    const stored = await row(handoff.id);
    expect(stored.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token); // no plaintext token anywhere in the row
    expect(stored.linkSentAt).toBeTruthy();
    expect(stored.status).toBe('pending');
    expect(stored.origin).toBe(site.url);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(600_000);
  }, 60000);

  it('never puts user ids, run ids or internal identifiers in the public URL', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const message = ctx.notifier.messages[0]!.text;
    const url = message.match(/https:\/\/\S+/)![0];
    for (const secret of [alice.id, run.id, handoff.id, site.url, 'whatsapp']) expect(url).not.toContain(secret);
    expect(url).toMatch(/^https:\/\/handoff\.test\/handoff\/[A-Za-z0-9_-]{43}$/);
  }, 60000);

  it('does not resend for a duplicate request and replaces older links for the same site', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const k = key();
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: k });
    const again = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: k });
    expect(again.alreadySent).toBe(true);
    expect(ctx.notifier.messages).toHaveLength(1);

    const first = ctx.notifier.lastToken;
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    expect(ctx.notifier.messages).toHaveLength(2);
    expect((await request(ctx.app).get(`/handoff/${first}`)).status).toBe(404); // the older link was revoked
    expect((await request(ctx.app).get(`/handoff/${ctx.notifier.lastToken}`)).status).toBe(200);
  }, 60000);

  it('refuses to create a handoff when the link cannot be delivered, and leaves nothing usable', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    ctx.notifier.fail = true;
    await expect(ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() })).rejects.toMatchObject({ code: 'NOTIFY_FAILED' });
    const rows = await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.userId, alice.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', failureCode: 'NOTIFY_FAILED' });
  }, 60000);

  it('enforces creation rules: ownership, live run, configuration and an hourly limit', async () => {
    const ctx = build({ settings: { maxPerHour: 2 } });
    const run = await loginRun(ctx.browser);
    await expect(ctx.service.createAndSend(bob.id, { runId: run.id, idempotencyKey: key() })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' }); // someone else's run
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    await expect(ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const noKey = build({ keyConfigured: false });
    const run2 = await loginRun(noKey.browser, alice.id, '/login');
    await expect(noKey.service.createAndSend(alice.id, { runId: run2.id, idempotencyKey: key() })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });

    const ended = build();
    const run3 = await loginRun(ended.browser, alice.id, '/login');
    await ended.browser.endRun(alice.id, run3.id, 'cancelled');
    await expect(ended.service.createAndSend(alice.id, { runId: run3.id, idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  }, 90000);

  it('applies the same URL safety rules as the agent: no private targets, https only, within the run scope', async () => {
    const strict = build({ allowPrivate: false, settings: { allowHttp: false } });
    await expect(strict.service.createAndSend(alice.id, { url: 'http://127.0.0.1:3000/login', idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(strict.service.createAndSend(alice.id, { url: 'http://169.254.169.254/', idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(strict.service.createAndSend(alice.id, { url: 'file:///etc/passwd', idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(strict.service.createAndSend(alice.id, { idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });

    const noHttp = build({ settings: { allowHttp: false } });
    await expect(noHttp.service.createAndSend(alice.id, { url: `${site.url}/login`, idempotencyKey: key() })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(strict.notifier.messages).toHaveLength(0);
  }, 60000);

  // ====================================================================== redeeming: single use, expiry

  it('shows the link without using it up, then redeems it exactly once', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const token = ctx.notifier.lastToken;

    // Chat apps pre-fetch links: viewing must not spend the single use.
    for (let i = 0; i < 3; i++) {
      const view = await request(ctx.app).get(`/handoff/${token}`);
      expect(view.status).toBe(200);
      expect(view.text).toContain('Secure sign-in to');
    }
    expect((await row(handoff.id)).status).toBe('pending');

    const { res, secret } = await redeem(ctx.app, token);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/handoff/session');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const opened = await row(handoff.id);
    expect(opened.status).toBe('active');
    expect(opened.sessionHash).toBe(hashToken(secret));
    expect(JSON.stringify(opened)).not.toContain(secret);

    // REPLAY: the same link is dead now, and looks exactly like an unknown one.
    const replay = await request(ctx.app).post(`/handoff/${token}/start`);
    expect(replay.status).toBe(404);
    expect((await request(ctx.app).get(`/handoff/${token}`)).status).toBe(404);
    const unknown = await request(ctx.app).get(`/handoff/${crypto.randomBytes(32).toString('base64url')}`);
    const replayView = await request(ctx.app).get(`/handoff/${token}`);
    expect(stripNonce(replayView.text)).toBe(stripNonce(unknown.text)); // a used link is indistinguishable from an unknown one
  }, 60000);

  it('lets only one of two simultaneous redemptions win', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const token = ctx.notifier.lastToken;
    const results = await Promise.all([request(ctx.app).post(`/handoff/${token}/start`), request(ctx.app).post(`/handoff/${token}/start`), request(ctx.app).post(`/handoff/${token}/start`)]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 404, 404]);
    expect(ctx.browser.manager.size).toBe(1);
  }, 60000);

  it('sets a hardened session cookie and hardened headers on every page', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const token = ctx.notifier.lastToken;
    const preview = await request(ctx.app).get(`/handoff/${token}`);
    const { res, secret } = await redeem(ctx.app, token);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure'); // baseUrl is https
    expect(cookie).toContain('Path=/handoff');
    expect(cookie).toMatch(/Max-Age=\d+/);

    const viewer = await as(ctx.app, secret).get('/handoff/session');
    for (const r of [preview, viewer]) {
      expect(r.headers['cache-control']).toContain('no-store');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    }
    const nonce = /'nonce-([^']+)'/.exec(String(viewer.headers['content-security-policy']))![1];
    expect(viewer.text).toContain(`<script nonce="${nonce}">`);
    expect(viewer.text).not.toContain(secret); // only a derived CSRF value is embedded
    expect(viewer.text).toContain(csrfTokenFor(secret));
  }, 60000);

  it('rejects expired, unknown, malformed and wrongly-scoped links identically', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const token = ctx.notifier.lastToken;
    await getDb().update(browserHandoffs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(browserHandoffs.id, handoff.id));

    const expired = await request(ctx.app).get(`/handoff/${token}`);
    const expiredStart = await request(ctx.app).post(`/handoff/${token}/start`);
    const unknown = await request(ctx.app).get(`/handoff/${crypto.randomBytes(32).toString('base64url')}`);
    const malformed = await request(ctx.app).get('/handoff/not-a-token');
    for (const r of [expired, expiredStart, unknown, malformed]) expect(r.status).toBe(404);
    expect(stripNonce(expired.text)).toBe(stripNonce(unknown.text));
    expect(stripNonce(malformed.text)).toBe(stripNonce(unknown.text));
    expect(ctx.browser.manager.size).toBe(1); // only the agent's own browser: nothing was opened for the expired link
    expect((await row(handoff.id)).status).toBe('pending');
  }, 60000);

  it('rate limits guessing and hammering of link URLs per client', async () => {
    const ctx = build();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await request(ctx.app).get(`/handoff/${crypto.randomBytes(32).toString('base64url')}`)).status);
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  }, 60000);

  it('is invisible when the feature is switched off', async () => {
    setHandoffServiceForTesting(null);
    const app = createApp();
    for (const [method, path] of [['get', '/handoff/x'], ['post', '/handoff/x/start'], ['get', '/handoff/session'], ['get', '/handoff/session/frame'], ['post', '/handoff/session/input']] as const) {
      expect((await request(app)[method](path)).status).toBe(404);
    }
  });

  // ====================================================================== authorization and isolation

  it('requires the session cookie for everything after redemption and rejects forged ones', async () => {
    const ctx = build();
    const { secret } = await openHandoff(ctx);
    for (const path of ['/handoff/session/status', '/handoff/session/frame']) expect((await request(ctx.app).get(path)).status).toBe(401);
    expect((await request(ctx.app).get('/handoff/session')).status).toBe(404);
    expect((await request(ctx.app).post('/handoff/session/complete')).status).toBe(401);

    const forged = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
    expect((await as(ctx.app, forged).get('/handoff/session/status')).status).toBe(401);
    expect((await as(ctx.app, crypto.randomBytes(32).toString('base64url')).get('/handoff/session/frame')).status).toBe(401);
    expect((await as(ctx.app, secret).get('/handoff/session/status')).status).toBe(200);
  }, 60000);

  it("keeps users apart: one user's session cannot be used with another user's CSRF token, and API cancel is owner-only", async () => {
    const a = build();
    const aliceSide = await openHandoff(a, alice.id, '/login');
    // A second user, on the same server instance, opens their own sign-in.
    const bobRun = await a.browser.startRun(bob.id, { url: `${site.url}/captcha`, idempotencyKey: key() });
    await a.service.createAndSend(bob.id, { runId: bobRun.run.id, reason: 'captcha', idempotencyKey: key() });
    const bobSecret = (await redeem(a.app, a.notifier.lastToken)).secret;

    const aStatus = (await as(a.app, aliceSide.secret).get('/handoff/session/status')).body;
    const bStatus = (await as(a.app, bobSecret).get('/handoff/session/status')).body;
    expect(aStatus.reason).toBe('login');
    expect(bStatus.reason).toBe('captcha');

    // Alice's cookie with Bob's CSRF token (and vice versa) is refused.
    expect((await as(a.app, aliceSide.secret).post('/handoff/session/cancel', {}, csrfTokenFor(bobSecret))).status).toBe(403);
    expect((await row(aliceSide.handoff.id)).status).toBe('active');

    // The API is owner-scoped: Bob cannot cancel Alice's sign-in, nor can she cancel his.
    await expect(a.service.cancel(bob.id, aliceSide.handoff.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await row(aliceSide.handoff.id)).status).toBe('active');
    expect((await a.service.list(bob.id)).every((h) => h.id !== aliceSide.handoff.id)).toBe(true);
    expect(await a.service.repo.get(bob.id, aliceSide.handoff.id)).toBeUndefined();
  }, 120000);

  it('rejects cross-site and cross-origin state changes (CSRF)', async () => {
    const ctx = build();
    const { secret } = await openHandoff(ctx);
    const base = () => request(ctx.app).post('/handoff/session/input').set('Cookie', `hs=${secret}`).send({ type: 'scroll', dy: 10 });

    expect((await base()).status).toBe(403); // no CSRF header
    expect((await base().set('X-CSRF-Token', 'wrong')).status).toBe(403);
    expect((await base().set('X-CSRF-Token', csrfTokenFor(secret)).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await base().set('X-CSRF-Token', csrfTokenFor(secret)).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await base().set('X-CSRF-Token', csrfTokenFor(secret)).set('Origin', 'https://handoff.test').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect((await request(ctx.app).post('/handoff/session/cancel').set('Cookie', `hs=${secret}`).set('Origin', 'https://evil.example')).status).toBe(403);
  }, 60000);

  // ============================================================== the remote browser: allowed hosts only

  it('provides no way to type a URL or navigate to an arbitrary address', async () => {
    const ctx = build();
    const { user } = await openHandoff(ctx);
    for (const path of ['/handoff/session/navigate', '/handoff/session/goto', '/handoff/session/url', '/handoff/session/open']) {
      expect((await user.post(path, { url: 'http://169.254.169.254/' })).status).toBe(404);
    }
    for (const body of [{ type: 'navigate', url: 'http://169.254.169.254/' }, { type: 'goto', url: 'https://evil.example' }, { type: 'type', text: 'x', url: 'https://evil.example' }]) {
      expect((await user.post('/handoff/session/input', body)).status).toBe(400); // strict schema: unknown shapes are refused
    }
  }, 60000);

  it('keeps the remote browser on the approved site, and only extends to explicitly configured hosts', async () => {
    // Default: following the page's own link to another host is blocked.
    const blocked = build();
    const a = await openHandoff(blocked, alice.id, '/offsite');
    const liveA = blocked.browser.manager.get(`handoff:${a.handoff.id}`, alice.id)!;
    expect(liveA.currentHost).toBe('127.0.0.1');
    await a.user.post('/handoff/session/input', { type: 'click', x: 30 / 1280, y: 18 / 800 });
    await new Promise((r) => setTimeout(r, 2500));
    expect(liveA.currentHost).toBe('127.0.0.1'); // still on the approved site (the refused link did not strand the user)
    expect(liveA.currentUrl).toBe(`${site.url}/offsite`);
    expect(site.hits.get('/')).toBeUndefined(); // the other host's page was never even requested

    // With an explicit allowlist entry (e.g. an identity provider), that one host becomes reachable.
    await getDb().delete(browserHandoffs);
    const allowed = build({ settings: { extraHosts: ['localhost'] } });
    const b = await openHandoff(allowed, bob.id, '/offsite');
    const liveB = allowed.browser.manager.get(`handoff:${b.handoff.id}`, bob.id)!;
    await b.user.post('/handoff/session/input', { type: 'click', x: 30 / 1280, y: 18 / 800 });
    await until(() => liveB.currentHost === 'localhost', 8000);
  }, 120000);

  it('refuses unsafe input shapes and unknown keys without echoing them back', async () => {
    const ctx = build();
    const { user } = await openHandoff(ctx);
    const bad: Array<[unknown, number]> = [
      [{ type: 'click', x: 2, y: 0.5 }, 400],
      [{ type: 'click', x: -1, y: 0.5 }, 400],
      [{ type: 'type', text: '' }, 400],
      [{ type: 'type', text: 'x'.repeat(201) }, 400],
      [{ type: 'type', text: 'a\u0000b' }, 400],
      [{ type: 'key', key: 'Control+O' }, 400],
      [{ type: 'key', key: 'F12' }, 400],
      [{ type: 'scroll', dy: 99999 }, 400],
      [{ type: 'click', x: 0.5, y: 0.5, extra: 1 }, 400],
      ['not an object', 400],
    ];
    for (const [body, status] of bad) {
      const res = await user.post('/handoff/session/input', body);
      expect(res.status).toBe(status);
      expect(JSON.stringify(res.body)).not.toContain('Control');
    }
    expect((await user.post('/handoff/session/input', { type: 'key', key: 'Tab' })).status).toBe(200);
  }, 60000);

  it('rate limits input events and frame polling per sign-in', async () => {
    const ctx = build();
    const { user } = await openHandoff(ctx);
    const inputs: number[] = [];
    for (let i = 0; i < 90; i++) inputs.push((await user.post('/handoff/session/input', { type: 'scroll', dy: 1 })).status);
    expect(inputs.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(inputs.slice(0, 20).every((s) => s === 200)).toBe(true);

    const frames: number[] = [];
    for (let i = 0; i < 25; i++) frames.push((await user.get('/handoff/session/frame')).status);
    expect(frames).toContain(200);
    expect(frames).toContain(429);
  }, 120000);

  it('serves a real screenshot of the remote page to the signed-in user', async () => {
    const ctx = build();
    const { user } = await openHandoff(ctx, alice.id, '/login');
    const res = await user.get('/handoff/session/frame').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.body as Buffer;
    expect(body.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG magic
    expect(body.length).toBeGreaterThan(2000);
  }, 60000);

  // ======================================================= complete sign-in, verification and resuming

  it('pauses the agent during sign-in, verifies the login, saves it encrypted, and resumes the run authorized', async () => {
    const ctx = build();
    const logged: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { n: v.name, m: v.message } : v)))) as never);
    }

    const run = await loginRun(ctx.browser);
    expect(await ctx.browser.getRun(alice.id, run.id)).toMatchObject({ status: 'waiting_for_user', waitReason: 'login_required' });
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, taskId: null, reason: 'login', idempotencyKey: key() });
    const token = ctx.notifier.lastToken;

    // 1. The agent must not touch the session while the user is signing in.
    await expect(ctx.browser.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' });

    // 2. The user opens the link: the agent's own browser is released, a separate remote browser is started.
    const { secret } = await redeem(ctx.app, token);
    const user = as(ctx.app, secret);
    expect(ctx.browser.manager.get(run.id, alice.id)).toBeUndefined();
    const remote = ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)!;
    expect(remote).toBeDefined();
    await expect(ctx.browser.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' });

    // 3. "I'm done" before signing in is refused: the server checks, it does not take their word for it.
    const early = await user.post('/handoff/session/complete');
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ ok: false, code: 'NOT_SIGNED_IN' });
    expect((await row(handoff.id)).status).toBe('active');
    expect(await getDb().select().from(browserConnections)).toHaveLength(0);

    // 4. The user signs in through the remote browser (keyboard events over HTTP).
    for (const ev of [{ type: 'key', key: 'Tab' }, { type: 'type', text: EMAIL }, { type: 'key', key: 'Tab' }, { type: 'type', text: PASSWORD }, { type: 'key', key: 'Enter' }]) {
      expect((await user.post('/handoff/session/input', ev)).status).toBe(200);
    }
    await until(() => remote.currentUrl.endsWith('/account'));
    expect((await user.get('/handoff/session/status')).body).toMatchObject({ state: 'waiting_for_login', label: 'Waiting for sign-in', host: new URL(site.url).host });

    // 5. Done: the server reloads the page, sees it is signed in, saves the session and resumes.
    const done = await user.post('/handoff/session/complete');
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ ok: true });

    const finished = await row(handoff.id);
    expect(finished.status).toBe('completed');
    expect(finished.completedAt).toBeTruthy();
    expect(finished.connectionId).toBeTruthy();
    expect(ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)).toBeUndefined(); // the remote browser is gone

    // 6. Persisted authentication state is encrypted; nothing sensitive is stored anywhere.
    const [conn] = await getDb().select().from(browserConnections);
    expect(conn).toMatchObject({ userId: alice.id, origin: site.url, status: 'connected' });
    expect(conn!.encryptedState).toMatch(/^v1\./);
    const dump = JSON.stringify([await getDb().select().from(browserHandoffs), await getDb().select().from(browserConnections), await getDb().select().from(browserRuns)]);
    for (const secretValue of [PASSWORD, EMAIL, 'valid-session', secret, token]) expect(dump).not.toContain(secretValue);

    // 7. The paused run is attached to the new connection and the task is resumed exactly once.
    const resumed = await ctx.browser.getRun(alice.id, run.id);
    expect(resumed).toMatchObject({ status: 'running', waitReason: null, connectionId: conn!.id });
    expect(ctx.resumer.calls).toHaveLength(1);
    expect(ctx.resumer.calls[0]!.handoff.id).toBe(handoff.id);
    expect((await row(handoff.id)).resumedTaskId).toBeTruthy();
    expect(ctx.notifier.messages.filter((m) => /connected/i.test(m.text))).toHaveLength(0); // the resumed agent replies instead

    // 8. The server-verified session works: the agent's next step is signed in.
    const step = await ctx.browser.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot());
    expect(step.replayed === false && step.value.title).toBe('Account');
    expect(step.replayed === false && step.value.state.loginRequired).toBe(false);

    // 9. The link and the finished session are dead.
    expect((await request(ctx.app).get(`/handoff/${token}`)).status).toBe(404);
    expect((await user.post('/handoff/session/complete')).status).toBe(410);
    expect((await user.get('/handoff/session/frame')).status).toBe(410);
    expect((await user.get('/handoff/session/status')).body.state).toBe('connected');
    expect(ctx.resumer.calls).toHaveLength(1);

    // 10. Neither the password, the email, the cookie nor the link ever reached the logs.
    const logs = logged.join('\n');
    for (const secretValue of [PASSWORD, EMAIL, 'valid-session', secret, token]) expect(logs).not.toContain(secretValue);
  }, 180000);

  it('tells the user they are connected when there is no task to resume', async () => {
    const ctx = build({ resumer: { resume: async () => null } });
    const { user, handoff } = await openHandoff(ctx);
    for (const ev of [{ type: 'key', key: 'Tab' }, { type: 'type', text: EMAIL }, { type: 'key', key: 'Tab' }, { type: 'type', text: PASSWORD }, { type: 'key', key: 'Enter' }]) {
      await user.post('/handoff/session/input', ev);
    }
    const live = ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)!;
    await until(() => live.currentUrl.endsWith('/account'));
    expect((await user.post('/handoff/session/complete')).status).toBe(200);
    expect(ctx.notifier.messages.filter((m) => /You're connected to/.test(m.text))).toHaveLength(1);
  }, 120000);

  it('keeps waiting while a CAPTCHA is showing and never solves it', async () => {
    const ctx = build();
    const { user, handoff } = await openHandoff(ctx, alice.id, '/captcha');
    const res = await user.post('/handoff/session/complete');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CAPTCHA_PENDING');
    expect((await row(handoff.id)).status).toBe('active');
    expect(await getDb().select().from(browserConnections)).toHaveLength(0);
  }, 90000);

  it('resumes through the real task lifecycle: a new task in the same conversation, built only from trusted data', async () => {
    const ctx = build({ resumer: new AgentTaskResumer() });
    const conversationId = await createTestConversation(alice.id);
    const original = await getAgentTaskService().createTask(alice.id, { request: 'check my account page', conversationId, channel: 'whatsapp' });

    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, taskId: original.task.id, idempotencyKey: key() });
    const { secret } = await redeem(ctx.app, ctx.notifier.lastToken);
    const user = as(ctx.app, secret);
    for (const ev of [{ type: 'key', key: 'Tab' }, { type: 'type', text: EMAIL }, { type: 'key', key: 'Tab' }, { type: 'type', text: PASSWORD }, { type: 'key', key: 'Enter' }]) {
      await user.post('/handoff/session/input', ev);
    }
    const live = ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)!;
    await until(() => live.currentUrl.endsWith('/account'));
    expect((await user.post('/handoff/session/complete')).status).toBe(200);

    const [resumed] = await getDb().select().from(agentTasks).where(eq(agentTasks.idempotencyKey, `handoff-resume:${handoff.id}`));
    expect(resumed).toBeTruthy();
    expect(resumed).toMatchObject({ userId: alice.id, conversationId, channel: 'whatsapp', status: 'pending' });
    const request_ = (resumed!.input as { request: string }).request;
    expect(request_).toContain(new URL(site.url).host);
    expect(request_).toContain(run.id);
    expect(request_).toContain('Never ask for credentials');
    for (const secretValue of [PASSWORD, EMAIL, 'valid-session', secret]) expect(request_).not.toContain(secretValue);
    expect((await row(handoff.id)).resumedTaskId).toBe(resumed!.id);
  }, 150000);

  // ============================================================ cancellation, revocation, disconnect

  it('lets the user cancel from the page, which ends the remote browser and tells them once', async () => {
    const ctx = build();
    const { user, handoff } = await openHandoff(ctx);
    const res = await user.post('/handoff/session/cancel');
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await row(handoff.id)).toMatchObject({ status: 'cancelled', failureCode: 'USER_CANCELLED' });
    expect(ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)).toBeUndefined();
    expect((await user.get('/handoff/session/status')).body.state).toBe('cancelled');
    expect(ctx.notifier.messages.filter((m) => /cancelled/.test(m.text))).toHaveLength(1);
    expect((await ctx.browser.getRun(alice.id, (await row(handoff.id)).runId!))).toBeTruthy();
    // The agent may act on the run again (no sign-in is open any more).
    await expect(ctx.browser.step(alice.id, (await row(handoff.id)).runId!, { kind: 'snapshot' }, (s) => s.snapshot())).resolves.toBeTruthy();
  }, 90000);

  it('lets the owner cancel a pending link through the API, making the link unusable', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    const token = ctx.notifier.lastToken;
    await ctx.service.cancel(alice.id, handoff.id);
    expect((await row(handoff.id)).status).toBe('cancelled');
    expect((await request(ctx.app).post(`/handoff/${token}/start`)).status).toBe(404);
    await expect(ctx.browser.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).resolves.toBeTruthy(); // no longer paused
  }, 90000);

  it('revokes pending links and live sign-ins when the website is disconnected', async () => {
    const ctx = build();
    // Establish a connection first.
    const first = await openHandoff(ctx);
    for (const ev of [{ type: 'key', key: 'Tab' }, { type: 'type', text: EMAIL }, { type: 'key', key: 'Tab' }, { type: 'type', text: PASSWORD }, { type: 'key', key: 'Enter' }]) {
      await first.user.post('/handoff/session/input', ev);
    }
    await until(() => ctx.browser.manager.get(`handoff:${first.handoff.id}`, alice.id)!.currentUrl.endsWith('/account'));
    expect((await first.user.post('/handoff/session/complete')).status).toBe(200);
    const [conn] = await getDb().select().from(browserConnections);

    // A new pending link and a live sign-in for the same site...
    const run2 = await ctx.browser.startRun(alice.id, { url: `${site.url}/login`, idempotencyKey: key() });
    await ctx.service.createAndSend(alice.id, { runId: run2.run.id, idempotencyKey: key() });
    const pendingToken = ctx.notifier.lastToken;

    // ...die with the connection.
    await ctx.browser.disconnect(alice.id, conn!.id);
    expect(await getDb().select().from(browserConnections).where(eq(browserConnections.id, conn!.id))).toMatchObject([{ status: 'revoked', encryptedState: null }]);
    expect((await request(ctx.app).get(`/handoff/${pendingToken}`)).status).toBe(404);
  }, 180000);

  // ================================================================ expiry, crashes, restarts, cleanup

  it('expires unused links and abandoned sessions, releases the browser, and notifies exactly once', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    await getDb().update(browserHandoffs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(browserHandoffs.id, handoff.id));
    await ctx.service.sweep();
    await ctx.service.sweep();
    expect(await row(handoff.id)).toMatchObject({ status: 'expired', failureCode: 'EXPIRED' });
    expect(ctx.notifier.messages.filter((m) => /expired/.test(m.text))).toHaveLength(1);
    expect((await ctx.service.statusOf(await row(handoff.id))).state).toBe('expired');

    // An opened session that outlives its time limit. (One live browser per user: end the first run first.)
    await ctx.browser.endRun(alice.id, run.id, 'cancelled');
    const second = await openHandoff(ctx, alice.id, '/login');
    await getDb().update(browserHandoffs).set({ sessionExpiresAt: new Date(Date.now() - 1000) }).where(eq(browserHandoffs.id, second.handoff.id));
    expect((await second.user.get('/handoff/session/frame')).status).toBe(410);
    expect((await row(second.handoff.id)).status).toBe('expired');
    expect(ctx.browser.manager.get(`handoff:${second.handoff.id}`, alice.id)).toBeUndefined();
    expect((await second.user.get('/handoff/session/status')).body).toMatchObject({ state: 'expired', label: 'Expired' });
  }, 150000);

  it('expires an idle sign-in session via the sweeper', async () => {
    const ctx = build();
    const { handoff } = await openHandoff(ctx);
    await getDb().update(browserHandoffs).set({ lastActivityAt: new Date(Date.now() - 10 * 60_000) }).where(eq(browserHandoffs.id, handoff.id));
    await ctx.service.sweep();
    expect((await row(handoff.id)).status).toBe('expired');
    expect(ctx.browser.manager.get(`handoff:${handoff.id}`, alice.id)).toBeUndefined();
  }, 90000);

  it('handles a browser crash during sign-in: fails cleanly, tells the user once, and the agent can ask again', async () => {
    const ctx = build();
    const { user, handoff } = await openHandoff(ctx);
    await ctx.browser.manager.shutdown(); // the remote browser dies

    const frame = await user.get('/handoff/session/frame');
    expect(frame.status).toBe(410);
    expect(await row(handoff.id)).toMatchObject({ status: 'failed', failureCode: 'BROWSER_CRASHED' });
    expect((await user.post('/handoff/session/input', { type: 'key', key: 'Tab' })).status).toBe(410);
    expect((await user.get('/handoff/session/status')).body).toMatchObject({ state: 'failed', label: 'Failed' });
    expect(ctx.notifier.messages.filter((m) => /Something went wrong/.test(m.text))).toHaveLength(1);

    // A fresh link can be issued for the same run.
    const again = await ctx.service.createAndSend(alice.id, { runId: (await row(handoff.id)).runId!, idempotencyKey: key() });
    expect(again.alreadySent).toBe(false);
  }, 120000);

  it('detects a crashed sign-in browser without any user request (sweeper)', async () => {
    const ctx = build();
    const { handoff } = await openHandoff(ctx);
    await getDb().update(browserHandoffs).set({ redeemedAt: new Date(Date.now() - 60_000) }).where(eq(browserHandoffs.id, handoff.id));
    await ctx.browser.manager.shutdown();
    await ctx.service.sweep();
    expect(await row(handoff.id)).toMatchObject({ status: 'failed', failureCode: 'BROWSER_CRASHED' });
    expect(ctx.notifier.messages.filter((m) => /Something went wrong/.test(m.text))).toHaveLength(1);
  }, 90000);

  it('after a server restart fails active sign-ins (their browsers are gone) but keeps unopened links valid', async () => {
    const first = build();
    const active = await openHandoff(first);
    const run2 = await first.browser.startRun(bob.id, { url: `${site.url}/captcha`, idempotencyKey: key() });
    await first.service.createAndSend(bob.id, { runId: run2.run.id, reason: 'captcha', idempotencyKey: key() });
    const pendingToken = first.notifier.lastToken;

    // "Restart": a new process has a new browser manager and no live sessions.
    await first.browser.manager.shutdown();
    const second = build();
    expect(await second.service.recover()).toBe(1);
    expect(await row(active.handoff.id)).toMatchObject({ status: 'failed', failureCode: 'SERVER_RESTARTED' });
    expect(second.notifier.messages.filter((m) => /Something went wrong/.test(m.text))).toHaveLength(1);

    expect((await request(second.app).get(`/handoff/${pendingToken}`)).status).toBe(200); // never opened: still valid
    expect((await redeem(second.app, pendingToken)).res.status).toBe(303);
  }, 150000);

  it('purges old finished handoffs and keeps recent and open ones', async () => {
    const ctx = build();
    const run = await loginRun(ctx.browser);
    const { handoff: old } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    await ctx.service.cancel(alice.id, old.id);
    await getDb().update(browserHandoffs).set({ updatedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(browserHandoffs.id, old.id));
    const { handoff: open } = await ctx.service.createAndSend(alice.id, { runId: run.id, idempotencyKey: key() });
    await ctx.service.sweep();
    expect(await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.id, old.id))).toHaveLength(0);
    expect(await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.id, open.id))).toHaveLength(1);
  }, 90000);

  // ===================================================================== typed text stays private

  it('never logs or stores what the user types, even when it is rejected', async () => {
    const ctx = build();
    const logged: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => void logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { n: v.name, m: v.message } : v)))) as never);
    }
    const { user, handoff } = await openHandoff(ctx, alice.id, '/login');
    const typed = 'MyS3cretPassw0rd!';
    await user.post('/handoff/session/input', { type: 'type', text: typed });
    await user.post('/handoff/session/input', { type: 'type', text: `${typed}\u0000` }); // rejected
    await user.post('/handoff/session/input', { type: 'key', key: `${typed}` }); // rejected
    expect(logged.join('\n')).not.toContain(typed);
    expect(JSON.stringify(await row(handoff.id))).not.toContain(typed);
  }, 90000);

  // ================================================================= the agent tool (end to end)

  it('lets the agent request a sign-in without ever seeing the link, and keeps it paused until the user is done', async () => {
    const ctx = build();
    const repo = new AgentTaskRepository();
    const registry = new ToolRegistry();
    for (const tool of createBrowserTools(ctx.browser, { handoffs: ctx.service })) registry.register(tool);
    const runIdOf = (m: Array<{ role: string; content?: unknown }>) => {
      for (const msg of m) if (msg.role === 'tool') { const id = /"runId":"([0-9a-f-]{36})"/.exec(String(msg.content))?.[1]; if (id) return id; }
      throw new Error('no runId');
    };
    const steps: ScriptStep[] = [
      toolCalls({ name: 'browser_open', rawArguments: JSON.stringify({ url: `${site.url}/account` }) }),
      async (m) => toolCalls({ name: 'browser_request_user_signin', rawArguments: JSON.stringify({ runId: runIdOf(m as never), reason: 'login' }) }),
      async (m) => toolCalls({ name: 'browser_snapshot', rawArguments: JSON.stringify({ runId: runIdOf(m as never) }) }),
      text('I sent you a secure link. Please finish signing in; I will continue after that.'),
    ];
    const provider = new ScriptedProvider(...steps);
    const runner = new AgentRunner({ repo, registry, permissions: new StaticPermissions(), getProvider: () => provider, config: { retryBackoffBaseMs: 0, modelTimeoutMs: 5000 } });
    const service = new AgentTaskService({ repo, registry, runner });

    const { task } = await service.createTask(alice.id, { request: 'check my account page' });
    for (let i = 0; i < 5 && (await service.processNext()); i++);
    expect((await service.getTask(alice.id, task.id)).status).toBe('succeeded');

    // The link went to the user...
    expect(ctx.notifier.links).toHaveLength(1);
    const token = ctx.notifier.lastToken;
    // ...and nothing the model saw contains it, nor any handoff URL.
    const seen = JSON.stringify(provider.calls.map((c) => c.messages));
    expect(seen).not.toContain(token);
    expect(seen).not.toContain('/handoff/');
    expect(seen).not.toContain('handoff.test');
    const signinResult = provider.calls[2]!.messages.filter((m) => m.role === 'tool').at(-1)!.content as string;
    expect(signinResult).toContain('"sent":true');
    expect(signinResult).toContain('End your turn');

    // The login page told the model what to do, and the paused run rejected the follow-up action.
    expect(seen).toContain('browser_request_user_signin');
    const snapshotResult = provider.calls[3]!.messages.filter((m) => m.role === 'tool').at(-1)!.content as string;
    expect(snapshotResult).toContain('HANDOFF_IN_PROGRESS');

    const [handoff] = await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.userId, alice.id));
    expect(handoff).toMatchObject({ status: 'pending', taskId: task.id });
  }, 150000);
});
