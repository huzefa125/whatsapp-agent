import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { browserHandoffs, type BrowserHandoff } from '../../../db/schema';

export type HandoffStatus = 'pending' | 'active' | 'completed' | 'expired' | 'cancelled' | 'failed';
export type HandoffReason = 'login' | 'mfa' | 'captcha';

export const OPEN_STATUSES: readonly HandoffStatus[] = ['pending', 'active'];
export const TERMINAL_STATUSES: readonly HandoffStatus[] = ['completed', 'expired', 'cancelled', 'failed'];

/**
 * Persistence for handoffs. Only hashes of the link token and the session secret are ever stored or queried.
 * Every owner-facing read is scoped by user_id; the secret-based lookups return the row the secret belongs to.
 * Transitions are compare-and-set on the current status, so two requests can never both win.
 */
export class BrowserHandoffRepository {
  async create(input: {
    userId: string;
    taskId: string | null;
    runId: string | null;
    origin: string;
    targetUrl: string;
    reason: HandoffReason;
    tokenHash: string;
    idempotencyKey: string | null;
    expiresAt: Date;
  }): Promise<BrowserHandoff> {
    const [row] = await getDb().insert(browserHandoffs).values({ ...input, status: 'pending' }).returning();
    return row!;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb()
      .select()
      .from(browserHandoffs)
      .where(and(eq(browserHandoffs.userId, userId), eq(browserHandoffs.idempotencyKey, key)))
      .limit(1);
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.tokenHash, tokenHash)).limit(1);
    return row;
  }

  async findBySessionHash(sessionHash: string): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.sessionHash, sessionHash)).limit(1);
    return row;
  }

  async get(userId: string, id: string): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb()
      .select()
      .from(browserHandoffs)
      .where(and(eq(browserHandoffs.id, id), eq(browserHandoffs.userId, userId)))
      .limit(1);
    return row;
  }

  async getById(id: string): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb().select().from(browserHandoffs).where(eq(browserHandoffs.id, id)).limit(1);
    return row;
  }

  async list(userId: string, limit = 20): Promise<BrowserHandoff[]> {
    return getDb()
      .select()
      .from(browserHandoffs)
      .where(eq(browserHandoffs.userId, userId))
      .orderBy(desc(browserHandoffs.createdAt))
      .limit(limit);
  }

  async countCreatedSince(userId: string, since: Date): Promise<number> {
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(browserHandoffs)
      .where(and(eq(browserHandoffs.userId, userId), gt(browserHandoffs.createdAt, since)));
    return row?.n ?? 0;
  }

  /**
   * Single-use redemption. Succeeds only for a link that is still pending, unexpired and never opened; the
   * winning request atomically turns it into an active session bound to the hash of the cookie secret.
   */
  async redeem(tokenHash: string, sessionHash: string, sessionExpiresAt: Date, now: Date): Promise<BrowserHandoff | undefined> {
    const [row] = await getDb()
      .update(browserHandoffs)
      .set({ status: 'active', sessionHash, sessionExpiresAt, redeemedAt: now, lastActivityAt: now, updatedAt: now })
      .where(
        and(
          eq(browserHandoffs.tokenHash, tokenHash),
          eq(browserHandoffs.status, 'pending'),
          isNull(browserHandoffs.redeemedAt),
          gt(browserHandoffs.expiresAt, now)
        )
      )
      .returning();
    return row;
  }

  async transition(
    id: string,
    from: readonly HandoffStatus[],
    to: HandoffStatus,
    patch: { failureCode?: string | null; connectionId?: string | null } = {}
  ): Promise<BrowserHandoff | undefined> {
    const now = new Date();
    const [row] = await getDb()
      .update(browserHandoffs)
      .set({
        status: to,
        ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
        ...(patch.connectionId !== undefined ? { connectionId: patch.connectionId } : {}),
        ...(to === 'completed' ? { completedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(browserHandoffs.id, id), inArray(browserHandoffs.status, [...from])))
      .returning();
    return row;
  }

  async touch(id: string): Promise<void> {
    await getDb().update(browserHandoffs).set({ lastActivityAt: new Date() }).where(eq(browserHandoffs.id, id));
  }

  /** Is there a sign-in in progress for this run? The agent must not act on the run while there is. */
  async hasOpenForRun(userId: string, runId: string): Promise<boolean> {
    const rows = await getDb()
      .select({ id: browserHandoffs.id })
      .from(browserHandoffs)
      .where(
        and(
          eq(browserHandoffs.userId, userId),
          eq(browserHandoffs.runId, runId),
          inArray(browserHandoffs.status, [...OPEN_STATUSES])
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Revokes still-open handoffs for a site, so an older link can never be used after a newer one was issued. */
  async cancelOpen(userId: string, filter: { origin?: string; runId?: string; exceptId?: string }): Promise<BrowserHandoff[]> {
    const conds = [eq(browserHandoffs.userId, userId), inArray(browserHandoffs.status, [...OPEN_STATUSES])];
    if (filter.origin) conds.push(eq(browserHandoffs.origin, filter.origin));
    if (filter.runId) conds.push(eq(browserHandoffs.runId, filter.runId));
    if (filter.exceptId) conds.push(sql`${browserHandoffs.id} <> ${filter.exceptId}`);
    return getDb()
      .update(browserHandoffs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(...conds))
      .returning();
  }

  async markLinkSent(id: string): Promise<void> {
    await getDb().update(browserHandoffs).set({ linkSentAt: new Date() }).where(eq(browserHandoffs.id, id));
  }

  /** Claims the right to tell the user the outcome. Exactly one caller gets `true`. */
  async claimResultNotice(id: string): Promise<boolean> {
    const rows = await getDb()
      .update(browserHandoffs)
      .set({ resultNotifiedAt: new Date() })
      .where(and(eq(browserHandoffs.id, id), isNull(browserHandoffs.resultNotifiedAt)))
      .returning({ id: browserHandoffs.id });
    return rows.length > 0;
  }

  async releaseResultNotice(id: string): Promise<void> {
    await getDb().update(browserHandoffs).set({ resultNotifiedAt: null }).where(eq(browserHandoffs.id, id));
  }

  async setResumedTask(id: string, taskId: string): Promise<void> {
    await getDb().update(browserHandoffs).set({ resumedTaskId: taskId }).where(eq(browserHandoffs.id, id));
  }

  /** Links never opened past their deadline, and sessions past their time limit or idle too long, expire. */
  async expireStale(now: Date, idleBefore: Date): Promise<BrowserHandoff[]> {
    return getDb()
      .update(browserHandoffs)
      .set({ status: 'expired', failureCode: 'EXPIRED', updatedAt: now })
      .where(
        or(
          and(eq(browserHandoffs.status, 'pending'), lt(browserHandoffs.expiresAt, now)),
          and(
            eq(browserHandoffs.status, 'active'),
            or(lt(browserHandoffs.sessionExpiresAt, now), lt(browserHandoffs.lastActivityAt, idleBefore))
          )
        )
      )
      .returning();
  }

  /** Active handoffs whose remote browser no longer exists (restart or crash). */
  async listActive(): Promise<BrowserHandoff[]> {
    return getDb().select().from(browserHandoffs).where(eq(browserHandoffs.status, 'active'));
  }

  /** Finished handoffs hold only hashes, but there is no reason to keep them forever. */
  async purgeOlderThan(before: Date): Promise<number> {
    const rows = await getDb()
      .delete(browserHandoffs)
      .where(and(inArray(browserHandoffs.status, [...TERMINAL_STATUSES]), lt(browserHandoffs.updatedAt, before)))
      .returning({ id: browserHandoffs.id });
    return rows.length;
  }
}
