import { getConfig } from '../../../config/env';
import type { BrowserHandoff } from '../../../db/schema';
import { generateToken, hashToken, isWellFormedToken, TokenBucket } from '../../../utils/handoff-token';
import { logger } from '../../../utils/logger';
import type { BrowserService } from '../browser-service';
import { BrowserConfigError } from '../connection-service';
import { hostInScope, parseCsv, scopeHostFor, UrlPolicyError } from '../policy';
import { describeError, redactUrl } from '../redact';
import { BrowserSessionError, type BrowserSession } from '../session';
import type { WaitReason } from '../types';
import { AgentTaskResumer, WhatsAppHandoffNotifier, type HandoffNotifier, type TaskResumer } from './handoff-notifier';
import {
  BrowserHandoffRepository,
  OPEN_STATUSES,
  type HandoffReason,
  type HandoffStatus,
} from './handoff-repository';

export type HandoffErrorCode =
  | 'NOT_ENABLED'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMITED'
  | 'RUN_NOT_FOUND'
  | 'INVALID_TARGET'
  | 'INVALID_LINK'
  | 'NOT_ACTIVE'
  | 'NOT_FOUND'
  | 'START_FAILED'
  | 'NOTIFY_FAILED'
  | 'INVALID_INPUT'
  | 'THROTTLED';

/** Expected handoff failure. Messages are safe to show to the user and the model. */
export class HandoffError extends Error {
  constructor(
    public readonly code: HandoffErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HandoffError';
  }
}

export interface HandoffSettings {
  /** Public origin used in links, e.g. https://assistant.example.com (no trailing slash). */
  baseUrl: string;
  linkTtlMs: number;
  sessionMs: number;
  idleMs: number;
  maxPerHour: number;
  /** Extra hosts the sign-in may pass through (identity providers). Never user- or page-controlled. */
  extraHosts: string[];
  /** Dev/test only: allow http origins (local test sites). */
  allowHttp: boolean;
}

export function handoffSettingsFromEnv(): HandoffSettings {
  const c = getConfig();
  return {
    baseUrl: c.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    linkTtlMs: c.BROWSER_HANDOFF_LINK_TTL_MINUTES * 60_000,
    sessionMs: c.BROWSER_HANDOFF_SESSION_MINUTES * 60_000,
    idleMs: c.BROWSER_HANDOFF_IDLE_SECONDS * 1000,
    maxPerHour: c.BROWSER_HANDOFF_MAX_PER_HOUR,
    extraHosts: parseCsv(c.BROWSER_HANDOFF_EXTRA_HOSTS),
    allowHttp: c.BROWSER_ALLOW_PRIVATE_NETWORK,
  };
}

/** What the user sees: one of five plain states. */
export type UserFacingState = 'waiting_for_login' | 'connected' | 'expired' | 'cancelled' | 'failed';

export function userFacingState(status: HandoffStatus): UserFacingState {
  switch (status) {
    case 'pending':
    case 'active':
      return 'waiting_for_login';
    case 'completed':
      return 'connected';
    default:
      return status;
  }
}

const STATE_LABEL: Record<UserFacingState, string> = {
  waiting_for_login: 'Waiting for sign-in',
  connected: 'Connected',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export interface HandoffStatusView {
  state: UserFacingState;
  label: string;
  host: string;
  reason: HandoffReason;
  secondsLeft: number;
}

export type HumanInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dy: number };

export type CompleteResult =
  | { ok: true; resumedTaskId: string | null }
  | { ok: false; code: 'CAPTCHA_PENDING' | 'NOT_SIGNED_IN' | 'BLOCKED' | 'WRONG_SITE' | 'NO_SESSION' | 'VERIFY_FAILED' | 'NOT_ACTIVE'; message: string };

export interface HandoffDeps {
  settings: HandoffSettings;
  browser: BrowserService;
  repo?: BrowserHandoffRepository;
  notifier?: HandoffNotifier;
  resumer?: TaskResumer;
  now?: () => number;
}

const hostOf = (origin: string) => new URL(origin).host;

export class HandoffService {
  readonly repo: BrowserHandoffRepository;
  private readonly notifier: HandoffNotifier;
  private readonly resumer: TaskResumer;
  private readonly now: () => number;
  private readonly frameBucket = new TokenBucket(8, 4);
  private readonly inputBucket = new TokenBucket(40, 20);
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HandoffDeps) {
    this.repo = deps.repo ?? new BrowserHandoffRepository();
    this.notifier = deps.notifier ?? new WhatsAppHandoffNotifier();
    this.resumer = deps.resumer ?? new AgentTaskResumer();
    this.now = deps.now ?? Date.now;
    deps.browser.setHandoffGate(this);
  }

  get settings(): HandoffSettings {
    return this.deps.settings;
  }

  private get browser(): BrowserService {
    return this.deps.browser;
  }

  private sessionKey(id: string): string {
    return `handoff:${id}`;
  }

  /** The remote browser for an active handoff, if it is still alive. */
  private live(row: BrowserHandoff): BrowserSession | undefined {
    return this.browser.manager.get(this.sessionKey(row.id), row.userId);
  }

  // ---------------------------------------------------------------------------------- agent pause gate

  hasOpenForRun(userId: string, runId: string): Promise<boolean> {
    return this.repo.hasOpenForRun(userId, runId);
  }

  // ------------------------------------------------------------------------------------- creating links

  private assertReady(): void {
    if (!this.settings.baseUrl) throw new HandoffError('NOT_ENABLED', 'Secure sign-in links are not set up on this server.');
    if (!this.browser.connections.isConfigured()) {
      throw new HandoffError('NOT_CONFIGURED', 'Website sign-in storage is not configured on this server.');
    }
  }

  /**
   * Creates a handoff and sends the link to the user on WhatsApp. The plaintext link exists only in that message;
   * the caller (and therefore the model) only learns that it was sent.
   */
  async createAndSend(
    userId: string,
    input: { runId?: string | undefined; taskId?: string | null | undefined; url?: string | undefined; reason?: HandoffReason | undefined; idempotencyKey: string }
  ): Promise<{ handoff: BrowserHandoff; alreadySent: boolean }> {
    this.assertReady();
    const existing = await this.repo.findByIdempotencyKey(userId, input.idempotencyKey);
    if (existing) {
      if (existing.linkSentAt || !OPEN_STATUSES.includes(existing.status as HandoffStatus)) {
        return { handoff: existing, alreadySent: true };
      }
      // The link never reached the user and only its hash is stored, so it cannot be re-sent: revoke it, issue a new one.
      await this.repo.transition(existing.id, OPEN_STATUSES, 'cancelled');
    }
    const { row, token } = await this.create(userId, { ...input, idempotencyKey: existing ? `${input.idempotencyKey}#${this.now()}` : input.idempotencyKey });
    await this.sendLink(row, token);
    return { handoff: row, alreadySent: false };
  }

  private async create(
    userId: string,
    input: { runId?: string | undefined; taskId?: string | null | undefined; url?: string | undefined; reason?: HandoffReason | undefined; idempotencyKey: string }
  ): Promise<{ row: BrowserHandoff; token: string }> {
    const hourAgo = new Date(this.now() - 3_600_000);
    if ((await this.repo.countCreatedSince(userId, hourAgo)) >= this.settings.maxPerHour) {
      throw new HandoffError('RATE_LIMITED', 'Too many sign-in links were requested. Please wait a while before asking again.');
    }

    let targetRaw = input.url;
    let run = null;
    if (input.runId) {
      run = await this.browser.runs.get(userId, input.runId); // ownership: scoped by user
      if (!run) throw new HandoffError('RUN_NOT_FOUND', 'No such browser session.');
      if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new HandoffError('INVALID_TARGET', 'That browser session has ended.');
      targetRaw = (run.checkpoint as { url?: string } | null)?.url ?? run.startUrl;
    }
    if (!targetRaw) throw new HandoffError('INVALID_TARGET', 'A website is required.');

    let target: URL;
    try {
      target = await this.browser.policy.validate(targetRaw); // same SSRF / allow / block rules as the agent
    } catch (err) {
      if (err instanceof UrlPolicyError) throw new HandoffError('INVALID_TARGET', err.message);
      throw err;
    }
    if (target.protocol !== 'https:' && !this.settings.allowHttp) {
      throw new HandoffError('INVALID_TARGET', 'Only https websites can be connected.');
    }
    if (run && !hostInScope(target.hostname, run.scopeHost)) {
      throw new HandoffError('INVALID_TARGET', 'That page is not part of the browser session.');
    }

    // A newer link replaces any older one for the same site: older links stop working immediately.
    const replaced = await this.repo.cancelOpen(userId, { origin: target.origin });
    await Promise.all(replaced.map((r) => this.browser.manager.close(this.sessionKey(r.id))));

    const token = generateToken();
    const row = await this.repo.create({
      userId,
      taskId: input.taskId ?? null,
      runId: run?.id ?? null,
      origin: target.origin,
      targetUrl: redactUrl(target.toString()),
      reason: input.reason ?? 'login',
      tokenHash: hashToken(token),
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(this.now() + this.settings.linkTtlMs),
    });

    if (run) {
      const reason: WaitReason = row.reason === 'captcha' ? 'captcha' : 'login_required';
      await this.browser.markWaitingForUser(userId, run.id, reason);
    }
    return { row, token };
  }

  private async sendLink(row: BrowserHandoff, token: string): Promise<void> {
    const minutes = Math.round(this.settings.linkTtlMs / 60_000);
    const what = row.reason === 'captcha' ? 'complete a security check' : row.reason === 'mfa' ? 'finish verification' : 'sign in';
    const text =
      `To ${what} on ${hostOf(row.origin)}, open this secure link on your phone or computer:\n` +
      `${this.settings.baseUrl}/handoff/${token}\n\n` +
      `It works once and expires in ${minutes} minutes. Don't share it. What you type goes only to the website: ` +
      `the AI never sees it. I'll continue as soon as you're done.`;
    try {
      await this.notifier.send(row.userId, text, `handoff-link:${row.id}`);
      await this.repo.markLinkSent(row.id);
    } catch (err) {
      logger.error({ error: describeError(err), handoffId: row.id }, 'Could not send the handoff link');
      await this.repo.transition(row.id, OPEN_STATUSES, 'failed', { failureCode: 'NOTIFY_FAILED' });
      throw new HandoffError('NOTIFY_FAILED', 'The sign-in link could not be sent to the user.');
    }
  }

  // ----------------------------------------------------------------------------------- opening the link

  /** Describes a link WITHOUT using it, so chat apps that pre-fetch URLs cannot burn the single use. */
  async preview(token: string): Promise<{ host: string; reason: HandoffReason; minutes: number } | null> {
    if (!isWellFormedToken(token)) return null;
    const row = await this.repo.findByTokenHash(hashToken(token));
    if (!row || row.status !== 'pending' || row.redeemedAt || row.expiresAt.getTime() <= this.now()) return null;
    return { host: hostOf(row.origin), reason: row.reason as HandoffReason, minutes: Math.max(1, Math.round(this.settings.sessionMs / 60_000)) };
  }

  /**
   * Redeems the link (single use) and starts the remote browser. Returns the secret for the user's cookie; only its
   * hash is stored. Every failure looks the same to the caller: INVALID_LINK.
   */
  async redeem(token: string): Promise<{ sessionSecret: string; sessionExpiresAt: Date }> {
    if (!isWellFormedToken(token)) throw new HandoffError('INVALID_LINK', 'This link is not valid.');
    const sessionSecret = generateToken();
    const now = new Date(this.now());
    const row = await this.repo.redeem(hashToken(token), hashToken(sessionSecret), new Date(now.getTime() + this.settings.sessionMs), now);
    if (!row) throw new HandoffError('INVALID_LINK', 'This link is not valid.');

    try {
      // The agent's browser for this run is paused: release it (and the user's session slot); it is rebuilt on resume.
      if (row.runId) await this.browser.manager.close(row.runId);
      const origin = new URL(row.origin);
      const session = await this.browser.manager.open(this.sessionKey(row.id), row.userId, null, {
        policy: this.browser.policy,
        scopeHost: scopeHostFor(origin),
        extraScopeHosts: this.settings.extraHosts,
        interactive: true,
        // The USER is the one acting here (their own login), so form posts are theirs to make. Everything else about
        // the network guard, URL scope, popups, downloads and private-address protection is unchanged.
        config: { ...this.browser.settings.session, blockUnconfirmedMutations: false },
      });
      await session.goto(row.targetUrl);
    } catch (err) {
      logger.warn({ error: describeError(err), handoffId: row.id }, 'Could not start the remote browser for a handoff');
      await this.finish(row, 'failed', 'START_FAILED');
      throw new HandoffError('START_FAILED', 'The sign-in page could not be opened.');
    }
    return { sessionSecret, sessionExpiresAt: row.sessionExpiresAt! };
  }

  // ------------------------------------------------------------------------------ the user's session

  /** Finds the handoff a cookie secret belongs to (any status), or null. */
  async lookup(sessionSecret: string | undefined): Promise<BrowserHandoff | null> {
    if (!isWellFormedToken(sessionSecret)) return null;
    return (await this.repo.findBySessionHash(hashToken(sessionSecret))) ?? null;
  }

  /** The handoff only if it can still be driven: active, inside its time limits, with a live remote browser. */
  async requireActive(row: BrowserHandoff): Promise<{ row: BrowserHandoff; session: BrowserSession }> {
    const fresh = (await this.repo.getById(row.id)) ?? row;
    if (fresh.status !== 'active') throw new HandoffError('NOT_ACTIVE', 'This sign-in is no longer active.');
    const now = this.now();
    if ((fresh.sessionExpiresAt?.getTime() ?? 0) <= now || fresh.lastActivityAt.getTime() < now - this.settings.idleMs) {
      await this.finish(fresh, 'expired', 'EXPIRED');
      throw new HandoffError('NOT_ACTIVE', 'This sign-in has expired.');
    }
    const session = this.live(fresh);
    if (!session) {
      // The browser died (crash or restart) while the user was signing in.
      await this.finish(fresh, 'failed', 'BROWSER_CRASHED');
      throw new HandoffError('NOT_ACTIVE', 'The sign-in browser was interrupted.');
    }
    return { row: fresh, session };
  }

  statusOf(row: BrowserHandoff): HandoffStatusView {
    const state = userFacingState(row.status as HandoffStatus);
    const endsAt = row.status === 'pending' ? row.expiresAt : (row.sessionExpiresAt ?? row.expiresAt);
    return {
      state,
      label: STATE_LABEL[state],
      host: hostOf(row.origin),
      reason: row.reason as HandoffReason,
      secondsLeft: state === 'waiting_for_login' ? Math.max(0, Math.round((endsAt.getTime() - this.now()) / 1000)) : 0,
    };
  }

  allowFrame(handoffId: string): boolean {
    return this.frameBucket.take(handoffId);
  }

  allowInput(handoffId: string): boolean {
    return this.inputBucket.take(handoffId);
  }

  async frame(row: BrowserHandoff): Promise<Buffer> {
    const { session } = await this.requireActive(row);
    return session.frame();
  }

  /** Applies one input event from the user. The text may be a password or a code: it is passed through, never kept. */
  async input(row: BrowserHandoff, event: HumanInput): Promise<void> {
    const { row: active, session } = await this.requireActive(row);
    try {
      switch (event.type) {
        case 'click':
          await session.humanClick(event.x, event.y);
          break;
        case 'type':
          await session.humanType(event.text);
          break;
        case 'key':
          await session.humanKey(event.key);
          break;
        case 'scroll':
          await session.humanScroll(event.dy);
          break;
      }
    } catch (err) {
      if (err instanceof BrowserSessionError && err.code === 'INVALID_INPUT') throw new HandoffError('INVALID_INPUT', err.message);
      if (err instanceof BrowserSessionError && err.code === 'SESSION_CLOSED') {
        await this.finish(active, 'failed', 'BROWSER_CRASHED');
        throw new HandoffError('NOT_ACTIVE', 'The sign-in browser was interrupted.');
      }
      logger.warn({ error: describeError(err), handoffId: active.id }, 'Remote browser input failed'); // never the input itself
      throw new HandoffError('INVALID_INPUT', 'That action could not be performed.');
    }
    await this.repo.touch(active.id);
  }

  // ---------------------------------------------------------------------- completing and resuming

  /**
   * The user says they are done. The server does not take their word for it: it reloads the original page in the
   * remote browser and checks that it is really signed in, that no CAPTCHA or block is showing, and that the browser
   * is back on the approved site. Only then is the session saved (encrypted) and the paused work resumed.
   */
  async complete(row: BrowserHandoff): Promise<CompleteResult> {
    let active: BrowserHandoff;
    let session: BrowserSession;
    try {
      ({ row: active, session } = await this.requireActive(row));
    } catch (err) {
      if (err instanceof HandoffError) return { ok: false, code: 'NOT_ACTIVE', message: err.message };
      throw err;
    }

    const origin = new URL(active.origin);
    let snapshot;
    try {
      // Verify the page the USER ended up on (many sites show their login form at the original URL even when signed
      // in), after a fresh reload so a sign-in that only exists in the page, not on the server, is caught.
      await session.reload();
      snapshot = await session.snapshot({ maxText: 600, maxElements: 15 });
    } catch (err) {
      logger.warn({ error: describeError(err), handoffId: active.id }, 'Handoff verification could not load the page');
      return { ok: false, code: 'VERIFY_FAILED', message: 'The page could not be checked. Try again in a moment.' };
    }
    if (snapshot.state.captcha) return { ok: false, code: 'CAPTCHA_PENDING', message: 'A security check is still showing. Finish it, then tap Done.' };
    if (snapshot.state.blocked) return { ok: false, code: 'BLOCKED', message: 'The website is refusing access right now.' };
    if (snapshot.state.loginRequired) return { ok: false, code: 'NOT_SIGNED_IN', message: "It doesn't look like you're signed in yet. Finish signing in, then tap Done." };
    if (!hostInScope(session.currentHost, scopeHostFor(origin))) {
      return { ok: false, code: 'WRONG_SITE', message: 'The browser is not on the website yet. Finish signing in, then tap Done.' };
    }

    const landingUrl = session.currentUrl;
    let connectionId: string;
    try {
      const state = await session.storageState();
      const view = await this.browser.connections.connect(
        active.userId,
        { origin: active.origin, storageState: state, label: hostOf(active.origin) },
        { allowHttp: this.settings.allowHttp }
      );
      connectionId = view.id;
    } catch (err) {
      if (err instanceof BrowserConfigError) {
        await this.finish(active, 'failed', 'NOT_CONFIGURED');
        return { ok: false, code: 'NO_SESSION', message: 'Sign-in storage is not configured on this server.' };
      }
      return { ok: false, code: 'NO_SESSION', message: "No sign-in was established on this website. Sign in, then tap Done." };
    }

    const done = await this.repo.transition(active.id, ['active'], 'completed', { connectionId });
    if (!done) return { ok: false, code: 'NOT_ACTIVE', message: 'This sign-in is no longer active.' };
    await this.browser.manager.close(this.sessionKey(active.id)); // the remote browser, and with it the user's page, is gone

    // The run continues from the signed-in page the user landed on, not from the login page it was stopped at.
    if (active.runId) await this.browser.resumeAfterHandoff(active.userId, active.runId, connectionId, landingUrl);

    let resumedTaskId: string | null = null;
    try {
      resumedTaskId = await this.resumer.resume(done, hostOf(done.origin));
      if (resumedTaskId) await this.repo.setResumedTask(done.id, resumedTaskId);
    } catch (err) {
      logger.error({ error: describeError(err), handoffId: done.id }, 'Could not create the task that resumes after a handoff');
    }
    // When a task resumes, the agent's own reply tells the user. Otherwise tell them here.
    if (await this.repo.claimResultNotice(done.id)) {
      if (!resumedTaskId) await this.notify(done, `You're connected to ${hostOf(done.origin)}. Ask me again and I'll use it.`);
    }
    return { ok: true, resumedTaskId };
  }

  // -------------------------------------------------------------------------- ending without success

  /** Ends the handoff: stops the remote browser and, once, tells the user why. */
  private async finish(row: BrowserHandoff, status: 'expired' | 'cancelled' | 'failed', code: string): Promise<BrowserHandoff | undefined> {
    const updated = await this.repo.transition(row.id, OPEN_STATUSES, status, { failureCode: code });
    await this.browser.manager.close(this.sessionKey(row.id));
    this.frameBucket.forget(row.id);
    this.inputBucket.forget(row.id);
    if (updated && (await this.repo.claimResultNotice(updated.id))) {
      const host = hostOf(updated.origin);
      const text =
        status === 'expired'
          ? `The sign-in link for ${host} expired before it was finished. Ask me again and I'll send a new one.`
          : status === 'cancelled'
            ? `The sign-in for ${host} was cancelled.`
            : `Something went wrong while connecting to ${host}. Ask me again and I'll send a new link.`;
      await this.notify(updated, text);
    }
    return updated;
  }

  private async notify(row: BrowserHandoff, text: string): Promise<void> {
    try {
      await this.notifier.send(row.userId, text, `handoff-result:${row.id}`);
    } catch (err) {
      logger.warn({ error: describeError(err), handoffId: row.id }, 'Could not send the handoff result message');
    }
  }

  /** The user cancels from the viewer page. */
  async cancelFromViewer(row: BrowserHandoff): Promise<void> {
    await this.finish(row, 'cancelled', 'USER_CANCELLED');
  }

  /** The owner cancels through the API (or the site is disconnected). Scoped to the owner. */
  async cancel(userId: string, handoffId: string): Promise<void> {
    const row = await this.repo.get(userId, handoffId);
    if (!row) throw new HandoffError('NOT_FOUND', 'Sign-in not found.');
    if (OPEN_STATUSES.includes(row.status as HandoffStatus)) await this.finish(row, 'cancelled', 'USER_CANCELLED');
  }

  /** A website was disconnected: its pending links and live sign-in sessions must die with it. */
  async revokeForOrigin(userId: string, origin: string): Promise<number> {
    const rows = await this.repo.cancelOpen(userId, { origin });
    await Promise.all(rows.map((r) => this.browser.manager.close(this.sessionKey(r.id))));
    return rows.length;
  }

  async list(userId: string): Promise<Array<HandoffStatusView & { id: string; createdAt: Date }>> {
    return (await this.repo.list(userId)).map((r) => ({ id: r.id, createdAt: r.createdAt, ...this.statusOf(r) }));
  }

  // ------------------------------------------------------------------------------------- housekeeping

  /** After a restart every remote browser is gone, so active sign-ins cannot continue. Pending links stay valid. */
  async recover(): Promise<number> {
    const active = await this.repo.listActive();
    for (const row of active) await this.finish(row, 'failed', 'SERVER_RESTARTED');
    return active.length;
  }

  async sweep(): Promise<void> {
    try {
      const now = new Date(this.now());
      const expired = await this.repo.expireStale(now, new Date(now.getTime() - this.settings.idleMs));
      for (const row of expired) {
        await this.browser.manager.close(this.sessionKey(row.id));
        if (await this.repo.claimResultNotice(row.id)) {
          await this.notify(row, `The sign-in link for ${hostOf(row.origin)} expired before it was finished. Ask me again and I'll send a new one.`);
        }
      }
      // An active sign-in whose remote browser vanished (crash) cannot be recovered.
      for (const row of await this.repo.listActive()) {
        const openedAgo = this.now() - (row.redeemedAt?.getTime() ?? this.now());
        if (openedAgo > 10_000 && !this.live(row)) await this.finish(row, 'failed', 'BROWSER_CRASHED');
      }
      await this.repo.purgeOlderThan(new Date(this.now() - 7 * 86_400_000));
    } catch (err) {
      logger.error({ error: describeError(err) }, 'Handoff sweep failed');
    }
  }

  startSweeper(intervalMs = 15_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}
