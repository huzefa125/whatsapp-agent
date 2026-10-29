import { getConfig } from '../../config/env';
import type { BrowserRun } from '../../db/schema';
import { logger } from '../../utils/logger';
import { BrowserConnectionService, type ConnectionView } from './connection-service';
import { parseCsv, scopeHostFor, UrlPolicy, type UrlPolicyConfig } from './policy';
import { describeError, redactUrl } from './redact';
import { BrowserRunRepository } from './run-repository';
import type { BrowserSession, SessionConfig } from './session';
import { BrowserSessionManager, type ManagerConfig } from './session-manager';
import type { PageSnapshot, PageState, RunCheckpoint, RunStatus, WaitReason } from './types';

export type BrowserServiceErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_ENDED'
  | 'STEP_LIMIT_EXCEEDED'
  | 'NAVIGATION_LIMIT_EXCEEDED'
  | 'RUN_DEADLINE_EXCEEDED'
  | 'OUTCOME_UNCERTAIN'
  | 'RESUME_FAILED'
  | 'CONNECTION_EXPIRED'
  | 'HANDOFF_IN_PROGRESS';

/** Expected failure of a browser workflow. The message is safe to show the model and the user. */
export class BrowserServiceError extends Error {
  constructor(
    public readonly code: BrowserServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BrowserServiceError';
  }
}

export interface BrowserSettings {
  maxSteps: number;
  maxNavigations: number;
  maxRunMs: number;
  idleMs: number;
  session: SessionConfig;
  manager: ManagerConfig;
  policy: UrlPolicyConfig;
}

export function browserSettingsFromEnv(): BrowserSettings {
  const c = getConfig();
  return {
    maxSteps: c.BROWSER_MAX_STEPS,
    maxNavigations: c.BROWSER_MAX_NAVIGATIONS,
    maxRunMs: c.BROWSER_MAX_RUN_SECONDS * 1000,
    idleMs: c.BROWSER_IDLE_TIMEOUT_SECONDS * 1000,
    session: {
      navTimeoutMs: c.BROWSER_NAV_TIMEOUT_MS,
      actionTimeoutMs: c.BROWSER_ACTION_TIMEOUT_MS,
      maxText: c.BROWSER_MAX_TEXT_CHARS,
      maxElements: c.BROWSER_MAX_ELEMENTS,
      blockUnconfirmedMutations: c.BROWSER_BLOCK_UNCONFIRMED_MUTATIONS,
      maxRequests: 1500,
    },
    manager: {
      headless: c.BROWSER_HEADLESS,
      maxSessions: c.BROWSER_MAX_SESSIONS,
      maxSessionsPerUser: c.BROWSER_MAX_SESSIONS_PER_USER,
    },
    policy: {
      allowedDomains: parseCsv(c.BROWSER_ALLOWED_DOMAINS),
      blockedDomains: parseCsv(c.BROWSER_BLOCKED_DOMAINS),
      allowPrivateNetwork: c.BROWSER_ALLOW_PRIVATE_NETWORK,
    },
  };
}

export type StepResult<T> =
  | { replayed: false; value: T; notices: string[] }
  | { replayed: true; notices: string[] };

export interface StepOptions<T> {
  /** Short action name kept in the checkpoint (e.g. "click"). Never contains page data. */
  kind: string;
  /** A state-changing action. Needs `key`; protects against running the same action twice. */
  write?: boolean;
  /** Stable per tool call (the engine's idempotency key). */
  key?: string;
  /** Extracts the page state from the result, so login/CAPTCHA/blocked pages move the run to waiting_for_user. */
  stateOf?: (value: T) => PageState | undefined;
}

/** Lets the service ask whether the user is signing in for a run (without depending on the handoff module). */
export interface HandoffGate {
  hasOpenForRun(userId: string, runId: string): Promise<boolean>;
  /** A website was disconnected: its open sign-in links and live sign-in sessions must be revoked. */
  revokeForOrigin(userId: string, origin: string): Promise<number>;
}

export interface StartResult {
  run: BrowserRun;
  snapshot: PageSnapshot;
  connection: ConnectionView | null;
  notices: string[];
}

const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];
const ACTIVE: readonly RunStatus[] = ['queued', 'running', 'waiting_for_user'];

export class BrowserService {
  readonly policy: UrlPolicy;
  private readonly navSeen = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private sweeper: NodeJS.Timeout | null = null;
  private gate: HandoffGate | null = null;

  constructor(
    readonly settings: BrowserSettings,
    readonly runs: BrowserRunRepository = new BrowserRunRepository(),
    readonly connections: BrowserConnectionService = new BrowserConnectionService(),
    readonly manager: BrowserSessionManager = new BrowserSessionManager(settings.manager),
    policy?: UrlPolicy
  ) {
    this.policy = policy ?? new UrlPolicy(settings.policy);
  }

  /** While a user is signing in for a run, the agent must not act on that run. */
  setHandoffGate(gate: HandoffGate | null): void {
    this.gate = gate;
  }

  /**
   * Called after the server verified a completed sign-in. The run is attached to the new connection, its old
   * browser is dropped, and the next step rebuilds the session from the checkpoint WITH the signed-in state.
   */
  async resumeAfterHandoff(userId: string, runId: string, connectionId: string, landingUrl?: string): Promise<void> {
    await this.withLock(runId, async () => {
      const run = await this.runs.get(userId, runId);
      if (!run || TERMINAL.includes(run.status as RunStatus)) return;
      await this.manager.close(runId);
      this.navSeen.delete(runId);
      await this.runs.setConnection(userId, runId, connectionId);
      // Resume from the page the user landed on after signing in (still inside the run's scope: it is checked on use).
      if (landingUrl) await this.runs.recordStep(userId, runId, { steps: 0, navigations: 0 }, { url: landingUrl });
      await this.runs.transition(userId, runId, ACTIVE, 'running', { waitReason: null });
    });
  }

  /** Records that the user was asked to sign in (or solve a challenge) for this run. */
  async markWaitingForUser(userId: string, runId: string, reason: WaitReason): Promise<void> {
    await this.runs.transition(userId, runId, ACTIVE, 'waiting_for_user', { waitReason: reason });
  }

  // ------------------------------------------------------------------------------------- starting a run

  async startRun(
    userId: string,
    input: { url: string; idempotencyKey: string; taskId?: string | null }
  ): Promise<StartResult> {
    // Throws UrlPolicyError for unsafe targets before anything is created.
    const url = await this.policy.validate(input.url);
    const scopeHost = scopeHostFor(url);

    // A site the user already authorized is used automatically; the model never chooses or sees credentials.
    let connection: ConnectionView | null = null;
    try {
      connection = await this.connections.findUsable(userId, url.hostname);
    } catch {
      connection = null; // connections are optional (no encryption key configured)
    }

    const { run, created } = await this.runs.create({
      userId,
      taskId: input.taskId ?? null,
      connectionId: connection?.id ?? null,
      scopeHost,
      startUrl: redactUrl(url.toString()),
      idempotencyKey: input.idempotencyKey,
      deadlineAt: new Date(Date.now() + this.settings.maxRunMs),
    });

    return this.withLock(run.id, async () => {
      const notices: string[] = [];
      if (!created) {
        // Duplicate request: continue the original run instead of opening a second browser.
        if (TERMINAL.includes(run.status as RunStatus)) {
          throw new BrowserServiceError('RUN_ENDED', 'This browser task has already ended.');
        }
        notices.push('This browser task was already started; continuing it.');
      }

      const live = await this.ensureSession(run);
      // A run that was resumed from a checkpoint already returned to its last page; only a fresh run navigates.
      if (created || run.stepCount === 0) {
        try {
          await live.session.goto(url.toString());
        } catch (err) {
          await this.endRunInternal(run, 'failed', 'START_FAILED', 'The page could not be opened.');
          throw err;
        }
        this.navSeen.set(run.id, live.session.navigationCount);
        await this.runs.recordStep(userId, run.id, { steps: 1, navigations: 1 }, { url: live.session.currentUrl, actions: [{ kind: 'open', at: new Date().toISOString() }] });
      }
      const snapshot = await live.session.snapshot();
      await this.applyPageState(run, snapshot.state);
      const fresh = (await this.runs.get(userId, run.id)) ?? run;
      return { run: fresh, snapshot, connection, notices };
    });
  }

  // ----------------------------------------------------------------------------------------- stepping

  /**
   * Runs one browser operation for a run, under that run's limits. Serialized per run. Persists a checkpoint and
   * counters, applies login/CAPTCHA/blocked detection, and makes state-changing actions safe against replays.
   */
  async step<T>(
    userId: string,
    runId: string,
    opts: StepOptions<T>,
    fn: (session: BrowserSession, run: BrowserRun) => Promise<T>
  ): Promise<StepResult<T>> {
    return this.withLock(runId, async () => {
      const run = await this.runs.get(userId, runId);
      if (!run) throw new BrowserServiceError('RUN_NOT_FOUND', 'No such browser session. Open a page first.');
      if (TERMINAL.includes(run.status as RunStatus)) {
        throw new BrowserServiceError('RUN_ENDED', `This browser session has ended (${run.status}). Open the page again to start a new one.`);
      }
      if (await this.gate?.hasOpenForRun(userId, runId)) {
        throw new BrowserServiceError(
          'HANDOFF_IN_PROGRESS',
          'The user is signing in right now. Do not act on this browser session. End your turn; you will be told when it is ready again.'
        );
      }
      await this.enforceLimits(run);

      const cp = (run.checkpoint ?? {}) as RunCheckpoint;
      if (opts.write && opts.key) {
        if (cp.last?.key === opts.key) return { replayed: true as const, notices: [] };
        if (cp.inflight?.key === opts.key) {
          throw new BrowserServiceError(
            'OUTCOME_UNCERTAIN',
            'This action was started earlier but its result was never recorded, so it was not repeated. Take a snapshot to check the page before trying again.'
          );
        }
      }

      const live = await this.ensureSession(run);
      const notices: string[] = [];
      if (live.resumed && cp.inflight) {
        notices.push('The browser was restarted. An earlier action may or may not have completed; check the page before repeating it.');
      }

      if (opts.write && opts.key) {
        await this.runs.recordStep(userId, runId, { steps: 0, navigations: 0 }, { inflight: { key: opts.key, kind: opts.kind, at: new Date().toISOString() } });
      }

      let value: T;
      try {
        value = await fn(live.session, run);
      } catch (err) {
        // Expected failures leave nothing half-done that we know of; the model is told and may try something else.
        await this.settleAfterFailure(userId, runId, live.session, opts, cp);
        throw err;
      }

      const state = opts.stateOf?.(value);
      if (state) await this.applyPageState(run, state);

      const navDelta = live.session.navigationCount - (this.navSeen.get(runId) ?? 0);
      this.navSeen.set(runId, live.session.navigationCount);
      const actions = [...(cp.actions ?? []), { kind: opts.kind, at: new Date().toISOString() }].slice(-10);
      await this.runs.recordStep(
        userId,
        runId,
        { steps: 1, navigations: Math.max(0, navDelta) },
        {
          url: live.session.currentUrl,
          actions,
          inflight: null,
          ...(opts.write && opts.key ? { last: { key: opts.key, kind: opts.kind, summary: { alreadyPerformed: true } } } : {}),
        }
      );
      return { replayed: false as const, value, notices };
    });
  }

  private async settleAfterFailure<T>(
    userId: string,
    runId: string,
    session: BrowserSession,
    opts: StepOptions<T>,
    cp: RunCheckpoint
  ): Promise<void> {
    try {
      const navDelta = session.navigationCount - (this.navSeen.get(runId) ?? 0);
      this.navSeen.set(runId, session.navigationCount);
      await this.runs.recordStep(
        userId,
        runId,
        { steps: 1, navigations: Math.max(0, navDelta) },
        { url: session.currentUrl, inflight: opts.write ? null : (cp.inflight ?? null) }
      );
    } catch (err) {
      logger.warn({ err: describeError(err), runId }, 'Could not record a failed browser step');
    }
  }

  private async enforceLimits(run: BrowserRun): Promise<void> {
    if (run.deadlineAt.getTime() < Date.now()) {
      await this.endRunInternal(run, 'failed', 'RUN_DEADLINE_EXCEEDED', 'The browser task ran out of time.');
      throw new BrowserServiceError('RUN_DEADLINE_EXCEEDED', 'The browser task ran out of time and was stopped.');
    }
    if (run.stepCount >= this.settings.maxSteps) {
      await this.endRunInternal(run, 'failed', 'STEP_LIMIT_EXCEEDED', 'The browser task needed too many steps.');
      throw new BrowserServiceError('STEP_LIMIT_EXCEEDED', 'The browser task used its maximum number of steps and was stopped.');
    }
    if (run.navigationCount >= this.settings.maxNavigations) {
      await this.endRunInternal(run, 'failed', 'NAVIGATION_LIMIT_EXCEEDED', 'The browser task visited too many pages.');
      throw new BrowserServiceError('NAVIGATION_LIMIT_EXCEEDED', 'The browser task visited too many pages and was stopped.');
    }
  }

  // ---------------------------------------------------------------- sessions, resume and page state

  /** Returns the live session, or rebuilds it from the checkpoint (GET only; actions are never replayed). */
  private async ensureSession(run: BrowserRun): Promise<{ session: BrowserSession; resumed: boolean }> {
    const existing = this.manager.get(run.id, run.userId);
    if (existing) {
      if (run.status === 'queued') await this.runs.transition(run.userId, run.id, ['queued'], 'running');
      return { session: existing, resumed: false };
    }

    const isRecovery = run.status !== 'queued' || (run.stepCount > 0 && !this.navSeen.has(run.id));
    let storageState = null;
    if (run.connectionId) {
      storageState = await this.connections.loadState(run.userId, run.connectionId).catch(() => null);
      if (!storageState) {
        await this.runs.transition(run.userId, run.id, ACTIVE, 'waiting_for_user', { waitReason: 'login_required' });
        throw new BrowserServiceError('CONNECTION_EXPIRED', 'The saved sign-in for this website is no longer valid. Ask the user to reconnect it.');
      }
    }

    const session = await this.manager.open(run.id, run.userId, run.connectionId, {
      policy: this.policy,
      scopeHost: run.scopeHost,
      config: this.settings.session,
      storageState: storageState ?? undefined,
    });

    const cp = (run.checkpoint ?? {}) as RunCheckpoint;
    if (isRecovery && cp.url) {
      try {
        await session.goto(cp.url);
        await this.runs.recordStep(run.userId, run.id, { steps: 0, navigations: 0, recoveries: 1 }, {});
      } catch (err) {
        await this.manager.close(run.id);
        await this.endRunInternal(run, 'failed', 'RESUME_FAILED', 'The browser task could not be resumed.');
        throw new BrowserServiceError('RESUME_FAILED', 'The browser task could not be resumed after a restart. Start it again.');
      }
    }
    this.navSeen.set(run.id, session.navigationCount);
    await this.runs.transition(run.userId, run.id, ['queued', 'running', 'waiting_for_user'], run.status === 'waiting_for_user' ? 'waiting_for_user' : 'running', {
      waitReason: (run.waitReason as WaitReason | null) ?? null,
    });
    return { session, resumed: isRecovery };
  }

  /** Login, CAPTCHA and blocked pages stop the run and hand control to the user; they are never bypassed. */
  private async applyPageState(run: BrowserRun, state: PageState): Promise<void> {
    const reason: WaitReason | null = state.loginRequired ? 'login_required' : state.captcha ? 'captcha' : state.blocked ? 'blocked' : null;
    if (reason) {
      await this.runs.transition(run.userId, run.id, ACTIVE, 'waiting_for_user', { waitReason: reason });
      if (reason === 'login_required' && run.connectionId) {
        // The site signed us out: the stored session is dead. Drop it and make the user reconnect.
        await this.connections.markExpired(run.userId, run.connectionId).catch(() => undefined);
      }
    } else if (run.status === 'waiting_for_user') {
      await this.runs.transition(run.userId, run.id, ['waiting_for_user'], 'running');
    }
  }

  // -------------------------------------------------------------------------------------------- ending

  async endRun(userId: string, runId: string, status: 'completed' | 'cancelled'): Promise<BrowserRun | undefined> {
    return this.withLock(runId, async () => {
      const run = await this.runs.get(userId, runId);
      if (!run) return undefined;
      if (TERMINAL.includes(run.status as RunStatus)) return run;
      await this.endRunInternal(run, status, null, null);
      return this.runs.get(userId, runId);
    });
  }

  private async endRunInternal(run: BrowserRun, status: 'completed' | 'failed' | 'cancelled', code: string | null, message: string | null): Promise<void> {
    const session = this.manager.get(run.id, run.userId);
    if (session && status === 'completed' && run.connectionId && run.status !== 'waiting_for_user') {
      // Keep the login alive: store cookies the site refreshed during the session (encrypted, owner-bound).
      try {
        await this.connections.saveState(run.userId, run.connectionId, await session.storageState());
      } catch (err) {
        logger.warn({ err: describeError(err), runId: run.id }, 'Could not refresh the stored website session');
      }
    }
    await this.manager.close(run.id);
    this.navSeen.delete(run.id);
    await this.runs.transition(run.userId, run.id, ACTIVE, status, { errorCode: code, errorMessage: message });
  }

  async getRun(userId: string, runId: string): Promise<BrowserRun | undefined> {
    return this.runs.get(userId, runId);
  }

  /** Disconnects a website: erases the stored session and shuts down any live browser using it. */
  async disconnect(userId: string, connectionId: string): Promise<void> {
    const origin = (await this.connections.list(userId)).find((c) => c.id === connectionId)?.origin;
    await this.connections.disconnect(userId, connectionId);
    await this.manager.closeByConnection(userId, connectionId);
    if (origin) await this.gate?.revokeForOrigin(userId, origin);
  }

  // ------------------------------------------------------------------------------- housekeeping

  /** After a restart no browser is alive: running runs become resumable (they continue from their checkpoint). */
  async recover(): Promise<number> {
    const n = await this.runs.requeueOrphans();
    if (n > 0) logger.warn({ count: n }, 'Re-queued browser runs that were interrupted by a restart');
    return n;
  }

  async sweep(): Promise<void> {
    try {
      const expired = await this.runs.failExpired();
      const idle = await this.runs.cancelIdle(new Date(Date.now() - this.settings.idleMs));
      for (const run of [...expired, ...idle]) {
        await this.manager.close(run.id);
        this.navSeen.delete(run.id);
      }
      await this.manager.closeIdle(this.settings.idleMs * 2);
    } catch (err) {
      logger.error({ err: describeError(err) }, 'Browser sweep failed');
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await this.manager.shutdown();
  }

  /** One operation at a time per run. */
  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(runId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(runId) === next) this.locks.delete(runId);
    }
  }
}
