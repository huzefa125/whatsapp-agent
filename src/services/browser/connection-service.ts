import { and, eq } from 'drizzle-orm';
import { getConfig } from '../../config/env';
import { getDb } from '../../db/client';
import { browserConnections, type BrowserConnection } from '../../db/schema';
import { BadRequestError, NotFoundError } from '../../utils/errors';
import { decryptSecret, encryptSecret, SecretBoxError } from '../../utils/secret-box';
import { hostMatches, normalizeHost } from './policy';
import type { StorageState } from './session';

const MAX_STATE_BYTES = 256 * 1024;

export class BrowserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserConfigError';
  }
}

/** What callers may see about a connection. The encrypted state never leaves this service. */
export interface ConnectionView {
  id: string;
  origin: string;
  label: string | null;
  status: 'connected' | 'expired' | 'revoked';
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const toView = (c: BrowserConnection): ConnectionView => ({
  id: c.id,
  origin: c.origin,
  label: c.label,
  status: c.status as ConnectionView['status'],
  lastUsedAt: c.lastUsedAt,
  expiresAt: c.expiresAt,
  createdAt: c.createdAt,
});

/**
 * Authorized websites. The browser state (cookies and local storage) is encrypted with AES-256-GCM, bound to the
 * owning user and origin, and only ever decrypted server-side to start that user's own browser session.
 * The model never sees cookies, tokens or credentials: it only ever learns that a site is "connected".
 */
export class BrowserConnectionService {
  constructor(private readonly keyProvider: () => string = () => getConfig().BROWSER_ENCRYPTION_KEY) {}

  /** Whether sessions can be stored (an encryption key is configured). */
  isConfigured(): boolean {
    return Boolean(this.keyProvider());
  }

  private key(): string {
    const key = this.keyProvider();
    if (!key) {
      throw new BrowserConfigError('BROWSER_ENCRYPTION_KEY is not set, so website sessions cannot be stored.');
    }
    return key;
  }

  private aad(userId: string, origin: string): string {
    return `${userId}|${origin}`;
  }

  static normalizeOrigin(raw: string, allowHttp: boolean): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestError('origin must be a valid URL');
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw new BadRequestError('Only https websites can be connected');
    }
    if (url.username || url.password) throw new BadRequestError('origin must not contain credentials');
    return url.origin;
  }

  /**
   * Keeps only what belongs to this site: cookies for the origin's host and storage for the origin itself.
   * Anything else in an imported state is dropped, so a connection can never smuggle in cookies for other sites.
   */
  static filterState(state: StorageState, origin: string): StorageState {
    const host = normalizeHost(new URL(origin).hostname);
    const cookies = (Array.isArray(state?.cookies) ? state.cookies : []).filter((c) => {
      const domain = typeof c['domain'] === 'string' ? normalizeHost((c['domain'] as string).replace(/^\./, '')) : '';
      return domain !== '' && hostMatches(host, domain);
    });
    const origins = (Array.isArray(state?.origins) ? state.origins : []).filter((o) => o['origin'] === origin);
    return { cookies, origins };
  }

  async connect(
    userId: string,
    input: { origin: string; storageState: StorageState; label?: string | undefined; expiresAt?: Date | undefined },
    opts: { allowHttp?: boolean } = {}
  ): Promise<ConnectionView> {
    const origin = BrowserConnectionService.normalizeOrigin(input.origin, opts.allowHttp ?? false);
    const filtered = BrowserConnectionService.filterState(input.storageState, origin);
    if (filtered.cookies.length === 0 && filtered.origins.length === 0) {
      throw new BadRequestError('The session contains nothing for this website. Sign in first, then try again.');
    }
    const serialized = JSON.stringify(filtered);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new BadRequestError('The session data is too large');

    const encryptedState = encryptSecret(serialized, this.key(), this.aad(userId, origin));
    const now = new Date();
    const [row] = await getDb()
      .insert(browserConnections)
      .values({
        userId,
        origin,
        label: input.label?.slice(0, 80) ?? null,
        status: 'connected',
        encryptedState,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: [browserConnections.userId, browserConnections.origin],
        set: { encryptedState, status: 'connected', label: input.label?.slice(0, 80) ?? null, expiresAt: input.expiresAt ?? null, updatedAt: now },
      })
      .returning();
    return toView(row!);
  }

  async list(userId: string): Promise<ConnectionView[]> {
    const rows = await getDb().select().from(browserConnections).where(eq(browserConnections.userId, userId));
    return rows.filter((r) => r.status !== 'revoked').map(toView);
  }

  /** A usable connection for a host, if the user has one. Scoped to the user; expired ones are skipped. */
  async findUsable(userId: string, host: string): Promise<ConnectionView | null> {
    const rows = await getDb()
      .select()
      .from(browserConnections)
      .where(and(eq(browserConnections.userId, userId), eq(browserConnections.status, 'connected')));
    const now = Date.now();
    const match = rows.find((r) => {
      if (r.expiresAt && r.expiresAt.getTime() < now) return false;
      return hostMatches(host, new URL(r.origin).hostname);
    });
    return match ? toView(match) : null;
  }

  /** Decrypts a connection's state for the OWNING user only. A wrong owner or origin fails authentication. */
  async loadState(userId: string, connectionId: string): Promise<StorageState | null> {
    const [row] = await getDb()
      .select()
      .from(browserConnections)
      .where(and(eq(browserConnections.id, connectionId), eq(browserConnections.userId, userId)))
      .limit(1);
    if (!row || row.status !== 'connected' || !row.encryptedState) return null;
    try {
      const state = JSON.parse(decryptSecret(row.encryptedState, this.key(), this.aad(userId, row.origin))) as StorageState;
      await getDb().update(browserConnections).set({ lastUsedAt: new Date() }).where(eq(browserConnections.id, row.id));
      return state;
    } catch (err) {
      if (err instanceof SecretBoxError) return null; // unreadable (e.g. key rotated): treat as needing reconnect
      throw err;
    }
  }

  /** Stores a refreshed state (rotated cookies) after a session, keeping the login alive. */
  async saveState(userId: string, connectionId: string, state: StorageState): Promise<void> {
    const [row] = await getDb()
      .select()
      .from(browserConnections)
      .where(and(eq(browserConnections.id, connectionId), eq(browserConnections.userId, userId)))
      .limit(1);
    if (!row || row.status !== 'connected') return;
    const filtered = BrowserConnectionService.filterState(state, row.origin);
    if (filtered.cookies.length === 0 && filtered.origins.length === 0) return;
    const serialized = JSON.stringify(filtered);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) return;
    await getDb()
      .update(browserConnections)
      .set({ encryptedState: encryptSecret(serialized, this.key(), this.aad(userId, row.origin)), updatedAt: new Date() })
      .where(eq(browserConnections.id, row.id));
  }

  /** The site signed the user out: keep the record, drop the dead state, and ask the user to reconnect. */
  async markExpired(userId: string, connectionId: string): Promise<void> {
    await getDb()
      .update(browserConnections)
      .set({ status: 'expired', encryptedState: null, updatedAt: new Date() })
      .where(and(eq(browserConnections.id, connectionId), eq(browserConnections.userId, userId)));
  }

  /** Disconnects a website: the stored session is erased and the connection can no longer be used. */
  async disconnect(userId: string, connectionId: string): Promise<void> {
    const rows = await getDb()
      .update(browserConnections)
      .set({ status: 'revoked', encryptedState: null, updatedAt: new Date() })
      .where(and(eq(browserConnections.id, connectionId), eq(browserConnections.userId, userId)))
      .returning({ id: browserConnections.id });
    if (rows.length === 0) throw new NotFoundError('Connection not found');
  }
}
