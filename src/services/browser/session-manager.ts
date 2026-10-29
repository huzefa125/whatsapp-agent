import { chromium, type Browser } from 'playwright';
import { logger } from '../../utils/logger';
import { describeError } from './redact';
import { BrowserSession, type SessionOptions } from './session';

export class BrowserCapacityError extends Error {
  constructor(
    public readonly code: 'TOO_MANY_SESSIONS' | 'BROWSER_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'BrowserCapacityError';
  }
}

export interface ManagerConfig {
  headless: boolean;
  maxSessions: number;
  maxSessionsPerUser: number;
}

interface Entry {
  session: BrowserSession;
  userId: string;
  connectionId: string | null;
}

export type BrowserLauncher = (headless: boolean) => Promise<Browser>;

const defaultLauncher: BrowserLauncher = (headless) =>
  chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--mute-audio'],
  });

/**
 * Owns the Chromium process and every live session. One BrowserContext per run, never shared: cookies, storage and
 * cache of one user's session are invisible to every other session. Sessions are looked up by (runId, userId), so a
 * guessed run id is useless to anyone but its owner.
 */
export class BrowserSessionManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly cfg: ManagerConfig,
    private readonly launcher: BrowserLauncher = defaultLauncher
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  countForUser(userId: string): number {
    let n = 0;
    for (const e of this.sessions.values()) if (e.userId === userId) n++;
    return n;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = this.launcher(this.cfg.headless)
        .then((b) => {
          this.browser = b;
          b.on('disconnected', () => {
            logger.warn('Browser process disconnected; dropping live sessions');
            this.browser = null;
            this.sessions.clear();
          });
          return b;
        })
        .catch((err) => {
          logger.error({ err: describeError(err) }, 'Could not launch the browser');
          throw new BrowserCapacityError('BROWSER_UNAVAILABLE', 'The browser is not available right now.');
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  async open(
    runId: string,
    userId: string,
    connectionId: string | null,
    options: Omit<SessionOptions, 'browser'>
  ): Promise<BrowserSession> {
    if (this.sessions.size >= this.cfg.maxSessions) {
      throw new BrowserCapacityError('TOO_MANY_SESSIONS', 'The assistant is busy with other browser tasks. Try again shortly.');
    }
    if (this.countForUser(userId) >= this.cfg.maxSessionsPerUser) {
      throw new BrowserCapacityError('TOO_MANY_SESSIONS', 'You already have a browser session open. Close it before starting another.');
    }
    const browser = await this.getBrowser();
    const session = await BrowserSession.open({ ...options, browser });
    this.sessions.set(runId, { session, userId, connectionId });
    return session;
  }

  /** Returns the live session only if it belongs to `userId`. */
  get(runId: string, userId: string): BrowserSession | undefined {
    const entry = this.sessions.get(runId);
    if (!entry || entry.userId !== userId || entry.session.isClosed) return undefined;
    return entry.session;
  }

  async close(runId: string): Promise<void> {
    const entry = this.sessions.get(runId);
    if (!entry) return;
    this.sessions.delete(runId);
    await entry.session.close();
  }

  /** Disconnecting a website must end every live session that was using it. */
  async closeByConnection(userId: string, connectionId: string): Promise<number> {
    const ids = [...this.sessions.entries()]
      .filter(([, e]) => e.userId === userId && e.connectionId === connectionId)
      .map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
    return ids.length;
  }

  /** Safety net: releases sessions that stopped being used even if their run record was never closed. */
  async closeIdle(idleMs: number): Promise<number> {
    const cutoff = Date.now() - idleMs;
    const ids = [...this.sessions.entries()].filter(([, e]) => e.session.lastActivityAt < cutoff).map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
    return ids.length;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
