import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { browserRuns, type BrowserRun } from '../../db/schema';
import { ACTIVE_RUN_STATUSES, type RunCheckpoint, type RunStatus, type WaitReason } from './types';

/**
 * Persistence for browser runs. Every read and write is scoped by user_id, so one user's run can never be read or
 * changed through another user's identity. Transitions are compare-and-set on the current status.
 */
export class BrowserRunRepository {
  async create(input: {
    userId: string;
    taskId: string | null;
    connectionId: string | null;
    scopeHost: string;
    startUrl: string;
    idempotencyKey: string | null;
    deadlineAt: Date;
  }): Promise<{ run: BrowserRun; created: boolean }> {
    const db = getDb();
    const [inserted] = await db
      .insert(browserRuns)
      .values({ ...input, status: 'queued', checkpoint: { url: input.startUrl } })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { run: inserted, created: true };

    // Duplicate request (same idempotency key): return the original run, never a second one.
    const [existing] = await db
      .select()
      .from(browserRuns)
      .where(and(eq(browserRuns.userId, input.userId), eq(browserRuns.idempotencyKey, input.idempotencyKey ?? '')))
      .limit(1);
    if (!existing) throw new Error('browser run insert conflicted but no existing run was found');
    return { run: existing, created: false };
  }

  async get(userId: string, runId: string): Promise<BrowserRun | undefined> {
    const [row] = await getDb()
      .select()
      .from(browserRuns)
      .where(and(eq(browserRuns.id, runId), eq(browserRuns.userId, userId)))
      .limit(1);
    return row;
  }

  async listActive(userId: string): Promise<BrowserRun[]> {
    return getDb()
      .select()
      .from(browserRuns)
      .where(and(eq(browserRuns.userId, userId), inArray(browserRuns.status, [...ACTIVE_RUN_STATUSES])))
      .orderBy(desc(browserRuns.createdAt));
  }

  /** Compare-and-set status change. Returns false if the run was not in one of the `from` states. */
  async transition(
    userId: string,
    runId: string,
    from: readonly RunStatus[],
    to: RunStatus,
    patch: { waitReason?: WaitReason | null; errorCode?: string | null; errorMessage?: string | null } = {}
  ): Promise<boolean> {
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    const rows = await getDb()
      .update(browserRuns)
      .set({
        status: to,
        waitReason: patch.waitReason ?? null,
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(browserRuns.id, runId), eq(browserRuns.userId, userId), inArray(browserRuns.status, [...from])))
      .returning({ id: browserRuns.id });
    return rows.length > 0;
  }

  /** Persists progress after a step. The checkpoint is merged, so concurrent fields are not lost. */
  async recordStep(
    userId: string,
    runId: string,
    delta: { steps: number; navigations: number; recoveries?: number },
    checkpoint: Partial<RunCheckpoint>
  ): Promise<BrowserRun | undefined> {
    const [row] = await getDb()
      .update(browserRuns)
      .set({
        stepCount: sql`${browserRuns.stepCount} + ${delta.steps}`,
        navigationCount: sql`${browserRuns.navigationCount} + ${delta.navigations}`,
        recoveryCount: sql`${browserRuns.recoveryCount} + ${delta.recoveries ?? 0}`,
        checkpoint: sql`${browserRuns.checkpoint} || ${JSON.stringify(checkpoint)}::jsonb`,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(browserRuns.id, runId), eq(browserRuns.userId, userId)))
      .returning();
    return row;
  }

  async setConnection(userId: string, runId: string, connectionId: string | null): Promise<void> {
    await getDb()
      .update(browserRuns)
      .set({ connectionId, updatedAt: new Date() })
      .where(and(eq(browserRuns.id, runId), eq(browserRuns.userId, userId)));
  }

  /** After a restart no live browser exists: runs that were running become resumable (queued). */
  async requeueOrphans(): Promise<number> {
    const rows = await getDb()
      .update(browserRuns)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(browserRuns.status, 'running'))
      .returning({ id: browserRuns.id });
    return rows.length;
  }

  /** Runs past their hard deadline are failed. */
  async failExpired(now = new Date()): Promise<BrowserRun[]> {
    return getDb()
      .update(browserRuns)
      .set({
        status: 'failed',
        errorCode: 'RUN_DEADLINE_EXCEEDED',
        errorMessage: 'The browser task ran out of time.',
        completedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(browserRuns.status, [...ACTIVE_RUN_STATUSES]), lt(browserRuns.deadlineAt, now)))
      .returning();
  }

  /** Runs nobody touched for a while are cancelled so their browser can be released. */
  async cancelIdle(idleBefore: Date): Promise<BrowserRun[]> {
    const now = new Date();
    return getDb()
      .update(browserRuns)
      .set({
        status: 'cancelled',
        errorCode: 'IDLE_TIMEOUT',
        errorMessage: 'The browser session was closed after being idle.',
        completedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(browserRuns.status, [...ACTIVE_RUN_STATUSES]), lt(browserRuns.lastActivityAt, idleBefore)))
      .returning();
  }
}
