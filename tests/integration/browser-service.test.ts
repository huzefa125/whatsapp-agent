import { hasChromium } from '../helpers/chromium';
import { hasTestDb, createTestUser, deleteTestUser, type TestUser } from '../helpers/test-db';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, closeDatabaseConnection } from '../../src/db/client';
import { browserConnections, browserRuns } from '../../src/db/schema';
import { BrowserService, BrowserServiceError, type BrowserSettings } from '../../src/services/browser/browser-service';
import { BrowserConnectionService } from '../../src/services/browser/connection-service';
import { BrowserRunRepository } from '../../src/services/browser/run-repository';
import { BrowserCapacityError } from '../../src/services/browser/session-manager';
import { generateEncryptionKey } from '../../src/utils/secret-box';
import { startTestSite, type TestSite } from '../helpers/test-site';
import type { PageSnapshot, RunCheckpoint } from '../../src/services/browser/types';

const KEY = generateEncryptionKey();

const settings = (over: Partial<BrowserSettings> = {}): BrowserSettings => ({
  maxSteps: 40,
  maxNavigations: 15,
  maxRunMs: 120_000,
  idleMs: 120_000,
  session: { navTimeoutMs: 6000, actionTimeoutMs: 3000, maxText: 4000, maxElements: 60, blockUnconfirmedMutations: true, maxRequests: 500 },
  manager: { headless: true, maxSessions: 6, maxSessionsPerUser: 1 },
  policy: { allowedDomains: [], blockedDomains: ['blocked.test'], allowPrivateNetwork: true },
  ...over,
});

const newService = (over: Partial<BrowserSettings> = {}) => {
  const s = settings(over);
  return new BrowserService(s, new BrowserRunRepository(), new BrowserConnectionService(() => KEY));
};

describe.skipIf(!hasTestDb || !hasChromium)('Browser service (PostgreSQL + Chromium)', () => {
  let site: TestSite;
  let alice: TestUser;
  let bob: TestUser;
  const services: BrowserService[] = [];
  const toDelete: string[] = [];
  let seq = 0;
  const key = () => `test-key-${Date.now()}-${seq++}`;

  const svc = (over: Partial<BrowserSettings> = {}) => {
    const s = newService(over);
    services.push(s);
    return s;
  };

  beforeAll(async () => {
    site = await startTestSite();
    alice = await createTestUser();
    bob = await createTestUser();
    toDelete.push(alice.id, bob.id);
  }, 60000);

  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.shutdown()));
    await getDb().delete(browserRuns);
    await getDb().delete(browserConnections);
  }, 60000);

  afterAll(async () => {
    for (const id of toDelete) await deleteTestUser(id);
    await site.close();
    await closeDatabaseConnection();
  }, 60000);

  // ------------------------------------------------------------------------------------ lifecycle

  it('starts a run, persists only metadata, and ends it', async () => {
    const service = svc();
    const { run, snapshot } = await service.startRun(alice.id, { url: `${site.url}/search?q=secret-term`, idempotencyKey: key() });
    expect(run.status).toBe('running');
    expect(run.scopeHost).toBe('127.0.0.1');
    expect(run.stepCount).toBe(1);
    expect(snapshot.text).toContain('secret-term'); // the model may see it...

    // ...but the database holds no query strings, page text or form values.
    const [row] = await getDb().select().from(browserRuns).where(eq(browserRuns.id, run.id));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain('secret-term');
    expect(stored).not.toContain('Results for');
    expect((row!.checkpoint as RunCheckpoint).url).toBe(`${site.url}/search`);

    const ended = await service.endRun(alice.id, run.id, 'completed');
    expect(ended?.status).toBe('completed');
    expect(ended?.completedAt).toBeTruthy();
    expect(service.manager.size).toBe(0);
    await expect(service.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'RUN_ENDED' });
  }, 60000);

  it('treats a duplicate start request as the same run (no second browser)', async () => {
    const service = svc();
    const k = key();
    const first = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: k });
    const second = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: k });
    expect(second.run.id).toBe(first.run.id);
    expect(second.notices.join(' ')).toContain('already started');
    expect(service.manager.size).toBe(1);
    const rows = await getDb().select().from(browserRuns).where(eq(browserRuns.userId, alice.id));
    expect(rows).toHaveLength(1);
  }, 60000);

  it('limits one live session per user and reports it clearly', async () => {
    const service = svc();
    await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await expect(service.startRun(alice.id, { url: `${site.url}/about`, idempotencyKey: key() })).rejects.toBeInstanceOf(BrowserCapacityError);
    // Another user is unaffected.
    await expect(service.startRun(bob.id, { url: `${site.url}/`, idempotencyKey: key() })).resolves.toBeTruthy();
  }, 60000);

  it('rejects unsafe start URLs before creating anything', async () => {
    const service = svc({ policy: { allowedDomains: [], blockedDomains: [], allowPrivateNetwork: false } });
    await expect(service.startRun(alice.id, { url: 'http://169.254.169.254/latest/meta-data', idempotencyKey: key() })).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
    await expect(service.startRun(alice.id, { url: 'file:///etc/passwd', idempotencyKey: key() })).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEME' });
    expect(await getDb().select().from(browserRuns)).toHaveLength(0);
  }, 30000);

  // ------------------------------------------------------------------------------------ isolation

  it("never lets one user read, drive or end another user's run", async () => {
    const service = svc({ manager: { headless: true, maxSessions: 6, maxSessionsPerUser: 2 } });
    const a = await service.startRun(alice.id, { url: `${site.url}/products`, idempotencyKey: key() });

    expect(await service.getRun(bob.id, a.run.id)).toBeUndefined();
    await expect(service.step(bob.id, a.run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    expect(await service.endRun(bob.id, a.run.id, 'cancelled')).toBeUndefined();
    expect(service.manager.get(a.run.id, bob.id)).toBeUndefined();
    expect(service.manager.get(a.run.id, alice.id)).toBeDefined();
    expect((await service.getRun(alice.id, a.run.id))?.status).toBe('running'); // Bob's attempts changed nothing
  }, 60000);

  it('gives every run its own browser context: cookies never cross users', async () => {
    const service = svc();
    const a = await service.startRun(alice.id, { url: `${site.url}/set-session`, idempotencyKey: key() }); // sets sid cookie for Alice
    const b = await service.startRun(bob.id, { url: `${site.url}/account`, idempotencyKey: key() });
    expect(b.snapshot.state.loginRequired).toBe(true); // Bob is bounced to the login page
    const aliceAccount = await service.step(alice.id, a.run.id, { kind: 'navigate' }, async (s) => {
      await s.goto(`${site.url}/account`);
      return s.snapshot();
    });
    expect(aliceAccount.replayed === false && aliceAccount.value.title).toBe('Account');
  }, 60000);

  // ------------------------------------------------------------------------------- limits and failures

  it('stops a run that exceeds its step limit and records the explicit failure', async () => {
    const service = svc({ maxSteps: 3 });
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() }); // step 1
    await service.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot()); // 2
    await service.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot()); // 3
    await expect(service.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'STEP_LIMIT_EXCEEDED' });
    const after = await service.getRun(alice.id, run.id);
    expect(after).toMatchObject({ status: 'failed', errorCode: 'STEP_LIMIT_EXCEEDED' });
    expect(service.manager.size).toBe(0);
  }, 60000);

  it('stops a run that visits too many pages', async () => {
    const service = svc({ maxNavigations: 2 });
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() }); // nav 1
    await service.step(alice.id, run.id, { kind: 'navigate' }, (s) => s.goto(`${site.url}/about`)); // nav 2
    await expect(service.step(alice.id, run.id, { kind: 'navigate' }, (s) => s.goto(`${site.url}/products`))).rejects.toMatchObject({ code: 'NAVIGATION_LIMIT_EXCEEDED' });
    expect((await service.getRun(alice.id, run.id))?.status).toBe('failed');
  }, 60000);

  it('fails a run whose deadline has passed, and the sweeper releases it', async () => {
    const service = svc();
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await getDb().update(browserRuns).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(browserRuns.id, run.id));
    await service.sweep();
    expect(await service.getRun(alice.id, run.id)).toMatchObject({ status: 'failed', errorCode: 'RUN_DEADLINE_EXCEEDED' });
    expect(service.manager.size).toBe(0);
  }, 60000);

  it('cancels an idle run and releases its browser', async () => {
    const service = svc({ idleMs: 1000 });
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await getDb().update(browserRuns).set({ lastActivityAt: new Date(Date.now() - 60_000) }).where(eq(browserRuns.id, run.id));
    await service.sweep();
    expect(await service.getRun(alice.id, run.id)).toMatchObject({ status: 'cancelled', errorCode: 'IDLE_TIMEOUT' });
    expect(service.manager.size).toBe(0);
  }, 60000);

  it('reports a failed navigation as an explicit failure and keeps the run usable', async () => {
    const service = svc();
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await expect(service.step(alice.id, run.id, { kind: 'navigate' }, (s) => s.goto(`${site.url}/redirect-out?token=SECRET`))).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    const after = await service.getRun(alice.id, run.id);
    expect(after?.status).toBe('running');
    expect(JSON.stringify(after)).not.toContain('SECRET');
  }, 60000);

  // ---------------------------------------------------------------- login, CAPTCHA, blocked

  it('moves a run to waiting_for_user when a login, CAPTCHA or block page appears', async () => {
    const service = svc();
    const { run, snapshot } = await service.startRun(alice.id, { url: `${site.url}/login`, idempotencyKey: key() });
    expect(snapshot.state.loginRequired).toBe(true);
    expect(await service.getRun(alice.id, run.id)).toMatchObject({ status: 'waiting_for_user', waitReason: 'login_required' });

    await service.step(alice.id, run.id, { kind: 'navigate', stateOf: (v: PageSnapshot) => v.state }, async (s) => {
      await s.goto(`${site.url}/captcha`);
      return s.snapshot();
    });
    expect((await service.getRun(alice.id, run.id))?.waitReason).toBe('captcha');

    await service.step(alice.id, run.id, { kind: 'navigate', stateOf: (v: PageSnapshot) => v.state }, async (s) => {
      await s.goto(`${site.url}/blocked`);
      return s.snapshot();
    });
    expect((await service.getRun(alice.id, run.id))?.waitReason).toBe('blocked');

    // Back on a normal page the run continues.
    await service.step(alice.id, run.id, { kind: 'navigate', stateOf: (v: PageSnapshot) => v.state }, async (s) => {
      await s.goto(`${site.url}/about`);
      return s.snapshot();
    });
    expect(await service.getRun(alice.id, run.id)).toMatchObject({ status: 'running', waitReason: null });
  }, 60000);

  // -------------------------------------------------------------------- authorized website sessions

  const sessionState = (value: string) => ({
    cookies: [{ name: 'sid', value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [],
  });

  it('uses a connected website automatically, stores it encrypted, and never exposes it', async () => {
    const service = svc();
    const view = await service.connections.connect(alice.id, { origin: site.url, storageState: sessionState('valid-session'), label: 'Demo' }, { allowHttp: true });
    expect(view).toMatchObject({ status: 'connected', origin: site.url });
    expect(JSON.stringify(view)).not.toContain('valid-session');

    // At rest: ciphertext only.
    const [row] = await getDb().select().from(browserConnections).where(eq(browserConnections.id, view.id));
    expect(row!.encryptedState).toBeTruthy();
    expect(row!.encryptedState).not.toContain('valid-session');
    expect(row!.encryptedState).not.toContain('sid');

    const started = await service.startRun(alice.id, { url: `${site.url}/account`, idempotencyKey: key() });
    expect(started.connection?.id).toBe(view.id);
    expect(started.snapshot.title).toBe('Account'); // signed in, no credentials ever typed
    expect(started.run.connectionId).toBe(view.id);
    expect(JSON.stringify(started.snapshot)).not.toContain('valid-session');
    await service.endRun(alice.id, started.run.id, 'completed');
  }, 60000);

  it("does not let another user use, list or read someone else's connection", async () => {
    const service = svc();
    const view = await service.connections.connect(alice.id, { origin: site.url, storageState: sessionState('valid-session') }, { allowHttp: true });
    expect(await service.connections.list(bob.id)).toEqual([]);
    expect(await service.connections.findUsable(bob.id, '127.0.0.1')).toBeNull();
    expect(await service.connections.loadState(bob.id, view.id)).toBeNull();

    const b = await service.startRun(bob.id, { url: `${site.url}/account`, idempotencyKey: key() });
    expect(b.connection).toBeNull();
    expect(b.snapshot.state.loginRequired).toBe(true);
  }, 60000);

  it('detects an expired website session, asks the user to reconnect and discards the dead state', async () => {
    const service = svc();
    const view = await service.connections.connect(alice.id, { origin: site.url, storageState: sessionState('stale-session') }, { allowHttp: true });
    const { run, snapshot } = await service.startRun(alice.id, { url: `${site.url}/account`, idempotencyKey: key() });
    expect(snapshot.state.loginRequired).toBe(true);
    expect(await service.getRun(alice.id, run.id)).toMatchObject({ status: 'waiting_for_user', waitReason: 'login_required' });

    const [row] = await getDb().select().from(browserConnections).where(eq(browserConnections.id, view.id));
    expect(row).toMatchObject({ status: 'expired', encryptedState: null });
    expect(await service.connections.findUsable(alice.id, '127.0.0.1')).toBeNull();
  }, 60000);

  it('disconnecting erases the stored session and ends live browsers that were using it', async () => {
    const service = svc();
    const view = await service.connections.connect(alice.id, { origin: site.url, storageState: sessionState('valid-session') }, { allowHttp: true });
    const { run } = await service.startRun(alice.id, { url: `${site.url}/account`, idempotencyKey: key() });
    expect(service.manager.size).toBe(1);

    await service.disconnect(alice.id, view.id);
    expect(service.manager.size).toBe(0);
    const [row] = await getDb().select().from(browserConnections).where(eq(browserConnections.id, view.id));
    expect(row).toMatchObject({ status: 'revoked', encryptedState: null });
    expect(await service.connections.list(alice.id)).toEqual([]);
    expect(await service.connections.loadState(alice.id, view.id)).toBeNull();
    // The run can no longer resume with the old session.
    await expect(service.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toBeInstanceOf(BrowserServiceError);
  }, 60000);

  it('only lets the owner disconnect a connection', async () => {
    const service = svc();
    const view = await service.connections.connect(alice.id, { origin: site.url, storageState: sessionState('valid-session') }, { allowHttp: true });
    await expect(service.disconnect(bob.id, view.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.connections.list(alice.id))[0]?.status).toBe('connected');
  }, 60000);

  it('refuses to import a session that holds nothing for the site, and drops other sites cookies', async () => {
    const service = svc();
    await expect(
      service.connections.connect(alice.id, { origin: site.url, storageState: { cookies: [{ name: 'x', value: '1', domain: 'evil.com', path: '/' }], origins: [] } }, { allowHttp: true })
    ).rejects.toMatchObject({ statusCode: 400 });
  }, 30000);

  // ------------------------------------------------------------------------ restart and recovery

  it('resumes an interrupted run from its checkpoint after a restart', async () => {
    const first = svc();
    const { run } = await first.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await first.step(alice.id, run.id, { kind: 'navigate' }, (s) => s.goto(`${site.url}/products`));

    // The process dies: the browser is gone, the database row says "running".
    await first.manager.shutdown();
    expect((await first.getRun(alice.id, run.id))?.status).toBe('running');

    const second = svc(); // a fresh process
    expect(await second.recover()).toBe(1);
    expect((await second.getRun(alice.id, run.id))?.status).toBe('queued');

    const resumed = await second.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot());
    expect(resumed.replayed).toBe(false);
    if (!resumed.replayed) expect(resumed.value.title).toBe('Products'); // back on the last page
    const after = await second.getRun(alice.id, run.id);
    expect(after).toMatchObject({ status: 'running', recoveryCount: 1 });
  }, 90000);

  it('resumes cancellation-safe: a cancelled run is never revived by recovery', async () => {
    const first = svc();
    const { run } = await first.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    await first.endRun(alice.id, run.id, 'cancelled');
    const second = svc();
    expect(await second.recover()).toBe(0);
    await expect(second.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot())).rejects.toMatchObject({ code: 'RUN_ENDED' });
  }, 60000);

  // ------------------------------------------------------------------------- duplicates and retries

  it('never performs the same write action twice for the same call key', async () => {
    const service = svc();
    const { run } = await service.startRun(alice.id, { url: `${site.url}/compose`, idempotencyKey: key() });
    let executions = 0;
    const act = async () => {
      executions++;
      return 'done';
    };
    const k = key();
    const first = await service.step(alice.id, run.id, { kind: 'fill', write: true, key: k }, act);
    const second = await service.step(alice.id, run.id, { kind: 'fill', write: true, key: k }, act); // replay (e.g. crash-recovery rerun)
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(executions).toBe(1);
  }, 60000);

  it('refuses to repeat an action whose outcome was never recorded, and says so', async () => {
    const service = svc();
    const { run } = await service.startRun(alice.id, { url: `${site.url}/compose`, idempotencyKey: key() });
    const k = key();
    // Simulate a crash between "action started" and "outcome recorded".
    await new BrowserRunRepository().recordStep(alice.id, run.id, { steps: 0, navigations: 0 }, { inflight: { key: k, kind: 'click', at: new Date().toISOString() } });

    let executions = 0;
    await expect(
      service.step(alice.id, run.id, { kind: 'click', write: true, key: k }, async () => {
        executions++;
        return 'x';
      })
    ).rejects.toMatchObject({ code: 'OUTCOME_UNCERTAIN' });
    expect(executions).toBe(0);
  }, 60000);

  it('warns the model when a restart interrupted an action', async () => {
    const first = svc();
    const { run } = await first.startRun(alice.id, { url: `${site.url}/compose`, idempotencyKey: key() });
    await new BrowserRunRepository().recordStep(alice.id, run.id, { steps: 0, navigations: 0 }, { inflight: { key: 'lost', kind: 'click', at: new Date().toISOString() } });
    await first.manager.shutdown();

    const second = svc();
    await second.recover();
    const r = await second.step(alice.id, run.id, { kind: 'snapshot' }, (s) => s.snapshot());
    expect(r.notices.join(' ')).toContain('may or may not have completed');
  }, 90000);

  it('serializes concurrent operations on one run', async () => {
    const service = svc();
    const { run } = await service.startRun(alice.id, { url: `${site.url}/`, idempotencyKey: key() });
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };
    await Promise.all([
      service.step(alice.id, run.id, { kind: 'a' }, slow('a', 150)),
      service.step(alice.id, run.id, { kind: 'b' }, slow('b', 10)),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  }, 60000);
});
