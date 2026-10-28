import { randomUUID } from 'crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import {
  agentTasks,
  agentTaskAttempts,
  agentToolCalls,
  conversations,
  messages,
  AgentTask,
  AgentToolCall,
} from '../../../db/schema';
import { ConflictError, NotFoundError } from '../../../utils/errors';
import { TaskStatus } from './task-state';
import type { TranscriptMessage } from './transcript';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ClaimedTask {
  task: AgentTask;
  /** Attempt row ID. Fencing token for every write made by this execution. */
  executionId: string;
  attemptNumber: number;
}

export interface CreateTaskParams {
  userId: string;
  conversationId: string | null;
  taskType: string;
  input: Record<string, unknown>;
  idempotencyKey: string | null;
  maxAttempts: number;
  /** Persisted to the conversation in the same transaction as the task. */
  userMessage: string | null;
  /** 'whatsapp' tasks get their outcome pushed back to the user; 'api' callers poll. */
  channel?: 'api' | 'whatsapp';
  /** WhatsApp message id (wamid) of the user message; it is what opens the 24h customer-service window. */
  userMessageProviderId?: string | null;
}

export interface PendingConfirmation {
  callId: string;
  toolName: string;
  summary: string;
  arguments: unknown;
}

export type ToolCallStatus = 'awaiting_confirmation' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed';

/** All scheduling uses the database clock so several app instances (and the column defaults) agree. */
const dbNow = sql`now()`;
const dbNowPlus = (ms: number) => sql`now() + (${Math.max(0, Math.round(ms))} * interval '1 millisecond')`;

export class StaleExecutionError extends Error {
  constructor() {
    super('Execution lease was lost; another worker owns this task');
    this.name = 'StaleExecutionError';
  }
}

export class AgentTaskRepository {
  private get db(): Db {
    return getDb();
  }

  // ---------------------------------------------------------------- creation / reads

  async createTask(p: CreateTaskParams): Promise<{ task: AgentTask; created: boolean }> {
    return this.db.transaction(async (tx) => {
      if (p.conversationId) {
        const [conv] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, p.conversationId), eq(conversations.userId, p.userId)))
          .limit(1);
        // Same error for "missing" and "someone else's" so IDs cannot be probed.
        if (!conv) throw new NotFoundError('Conversation not found');
      }

      const [inserted] = await tx
        .insert(agentTasks)
        .values({
          userId: p.userId,
          conversationId: p.conversationId,
          taskType: p.taskType,
          input: p.input,
          idempotencyKey: p.idempotencyKey,
          maxAttempts: p.maxAttempts,
          channel: p.channel ?? 'api',
        })
        .onConflictDoNothing({ target: [agentTasks.userId, agentTasks.idempotencyKey] })
        .returning();

      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(agentTasks)
          .where(
            and(
              eq(agentTasks.userId, p.userId),
              eq(agentTasks.idempotencyKey, p.idempotencyKey ?? '')
            )
          )
          .limit(1);
        if (!existing) throw new ConflictError('Task could not be created; retry the request');
        return { task: existing, created: false };
      }

      if (p.conversationId && p.userMessage !== null) {
        await tx.insert(messages).values({
          conversationId: p.conversationId,
          userId: p.userId,
          role: 'user',
          content: p.userMessage,
          providerMessageId: p.userMessageProviderId ?? null,
          status: 'received',
          metadata: { taskId: inserted.id },
        });
      }
      return { task: inserted, created: true };
    });
  }

  async getTaskForUser(userId: string, taskId: string): Promise<AgentTask | null> {
    const [row] = await this.db
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /** The user's most recent task on a channel that is in one of `statuses`. Always scoped to the user. */
  async latestForUser(userId: string, channel: 'api' | 'whatsapp', statuses: TaskStatus[]): Promise<AgentTask | null> {
    const [row] = await this.db
      .select()
      .from(agentTasks)
      .where(
        and(eq(agentTasks.userId, userId), eq(agentTasks.channel, channel), inArray(agentTasks.status, statuses))
      )
      .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
      .limit(1);
    return row ?? null;
  }

  async listTasksForUser(
    userId: string,
    opts: { status?: TaskStatus; limit: number; offset: number }
  ): Promise<AgentTask[]> {
    return this.db
      .select()
      .from(agentTasks)
      .where(
        opts.status
          ? and(eq(agentTasks.userId, userId), eq(agentTasks.status, opts.status))
          : eq(agentTasks.userId, userId)
      )
      .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  /** Recent conversation turns, oldest first, for a conversation the caller owns. */
  async loadConversationHistory(
    userId: string,
    conversationId: string,
    before: Date,
    excludeTaskId: string,
    limit: number
  ): Promise<Array<{ role: string; content: string }>> {
    if (limit === 0) return [];
    const rows = await this.db
      .select({ role: messages.role, content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.userId, userId),
          lte(messages.createdAt, before)
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);
    return rows
      .filter((r) => (r.metadata as { taskId?: string } | null)?.taskId !== excludeTaskId)
      .slice(0, limit)
      .reverse()
      .map(({ role, content }) => ({ role, content }));
  }

  // ---------------------------------------------------------------- claiming / leases

  /**
   * Atomically claims the next runnable task. FOR UPDATE SKIP LOCKED makes concurrent workers
   * (in-process or across instances) pick distinct rows.
   */
  async claimNext(leaseMs: number): Promise<ClaimedTask | null> {
    for (;;) {
      const step = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(agentTasks)
          .where(and(eq(agentTasks.status, 'pending'), lte(agentTasks.runAfter, dbNow)))
          .orderBy(asc(agentTasks.runAfter), asc(agentTasks.createdAt))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return { kind: 'none' as const };

        if (row.cancelRequestedAt) {
          await tx
            .update(agentTasks)
            .set({ status: 'cancelled', completedAt: dbNow, updatedAt: dbNow })
            .where(eq(agentTasks.id, row.id));
          return { kind: 'skipped' as const };
        }

        const executionId = randomUUID();
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(agentTaskAttempts)
          .where(eq(agentTaskAttempts.taskId, row.id));
        const attemptNumber = n + 1;

        const [task] = await tx
          .update(agentTasks)
          .set({
            status: 'running',
            attempts: row.attempts + 1,
            lockedBy: executionId,
            leaseExpiresAt: dbNowPlus(leaseMs),
            startedAt: row.startedAt ?? dbNow,
            updatedAt: dbNow,
          })
          .where(eq(agentTasks.id, row.id))
          .returning();
        await tx.insert(agentTaskAttempts).values({
          id: executionId,
          taskId: row.id,
          attemptNumber,
          status: 'running',
        });
        return { kind: 'claimed' as const, claimed: { task: task as AgentTask, executionId, attemptNumber } };
      });

      if (step.kind === 'none') return null;
      if (step.kind === 'claimed') return step.claimed;
    }
  }

  private fence(taskId: string, executionId: string) {
    return and(
      eq(agentTasks.id, taskId),
      eq(agentTasks.lockedBy, executionId),
      eq(agentTasks.status, 'running')
    );
  }

  /** Extends the lease. Returns null when this execution no longer owns the task. */
  async heartbeat(
    taskId: string,
    executionId: string,
    leaseMs: number
  ): Promise<{ cancelRequested: boolean } | null> {
    const [row] = await this.db
      .update(agentTasks)
      .set({ leaseExpiresAt: dbNowPlus(leaseMs), updatedAt: dbNow })
      .where(this.fence(taskId, executionId))
      .returning({ cancelRequestedAt: agentTasks.cancelRequestedAt });
    return row ? { cancelRequested: row.cancelRequestedAt !== null } : null;
  }

  async checkpoint(taskId: string, executionId: string, transcript: TranscriptMessage[]): Promise<void> {
    const rows = await this.db
      .update(agentTasks)
      .set({ transcript, updatedAt: new Date() })
      .where(this.fence(taskId, executionId))
      .returning({ id: agentTasks.id });
    if (rows.length === 0) throw new StaleExecutionError();
  }

  // ---------------------------------------------------------------- fenced transitions out of `running`

  private async finishAttempt(
    tx: Tx,
    executionId: string,
    status: string,
    errorCode: string | null,
    errorMessage: string | null,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await tx
      .update(agentTaskAttempts)
      .set({
        status,
        errorCode,
        errorMessage,
        finishedAt: dbNow,
        ...(metadata ? { metadata } : {}),
      })
      .where(eq(agentTaskAttempts.id, executionId));
  }

  async succeed(
    taskId: string,
    executionId: string,
    result: Record<string, unknown>,
    reply: { conversationId: string; userId: string; content: string; metadata: Record<string, unknown> } | null,
    attemptMetadata: Record<string, unknown>
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(agentTasks)
        .set({
          status: 'succeeded',
          result,
          errorCode: null,
          errorMessage: null,
          completedAt: dbNow,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: dbNow,
        })
        .where(this.fence(taskId, executionId))
        .returning({ id: agentTasks.id });
      if (rows.length === 0) throw new StaleExecutionError();

      if (reply) {
        await tx.insert(messages).values({
          conversationId: reply.conversationId,
          userId: reply.userId,
          role: 'assistant',
          content: reply.content,
          status: 'completed',
          metadata: { ...reply.metadata, taskId },
        });
      }
      await this.finishAttempt(tx, executionId, 'succeeded', null, null, attemptMetadata);
    });
  }

  async fail(
    taskId: string,
    executionId: string,
    code: string,
    message: string,
    attemptMetadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(agentTasks)
        .set({
          status: 'failed',
          errorCode: code,
          errorMessage: message,
          completedAt: dbNow,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: dbNow,
        })
        .where(this.fence(taskId, executionId))
        .returning({ id: agentTasks.id });
      if (rows.length === 0) throw new StaleExecutionError();
      await this.finishAttempt(tx, executionId, 'failed', code, message, attemptMetadata);
    });
  }

  async markCancelled(taskId: string, executionId: string, attemptMetadata: Record<string, unknown> = {}): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(agentTasks)
        .set({ status: 'cancelled', completedAt: dbNow, lockedBy: null, leaseExpiresAt: null, updatedAt: dbNow })
        .where(this.fence(taskId, executionId))
        .returning({ id: agentTasks.id });
      if (rows.length === 0) throw new StaleExecutionError();
      await this.finishAttempt(tx, executionId, 'cancelled', null, null, attemptMetadata);
    });
  }

  /** running -> pending after a transient failure. Honors a cancel requested meanwhile. */
  async scheduleRetry(
    taskId: string,
    executionId: string,
    delayMs: number,
    code: string,
    message: string,
    attemptMetadata: Record<string, unknown> = {}
  ): Promise<'pending' | 'cancelled'> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ cancelRequestedAt: agentTasks.cancelRequestedAt })
        .from(agentTasks)
        .where(this.fence(taskId, executionId))
        .for('update');
      if (!current) throw new StaleExecutionError();

      if (current.cancelRequestedAt) {
        await tx
          .update(agentTasks)
          .set({ status: 'cancelled', completedAt: dbNow, lockedBy: null, leaseExpiresAt: null, updatedAt: dbNow })
          .where(eq(agentTasks.id, taskId));
        await this.finishAttempt(tx, executionId, 'cancelled', null, null, attemptMetadata);
        return 'cancelled' as const;
      }
      await tx
        .update(agentTasks)
        .set({
          status: 'pending',
          runAfter: dbNowPlus(delayMs),
          errorCode: code,
          errorMessage: message,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: dbNow,
        })
        .where(eq(agentTasks.id, taskId));
      await this.finishAttempt(tx, executionId, 'retry_scheduled', code, message, attemptMetadata);
      return 'pending' as const;
    });
  }

  /**
   * running -> awaiting_confirmation. Does not consume retry budget: waiting on a human is not a failed attempt.
   */
  async pauseForConfirmation(
    taskId: string,
    executionId: string,
    transcript: TranscriptMessage[],
    confirmationTtlMs: number,
    pending: PendingConfirmation,
    attemptMetadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(agentTasks)
        .set({
          status: 'awaiting_confirmation',
          transcript,
          result: { pendingConfirmation: pending },
          confirmationExpiresAt: dbNowPlus(confirmationTtlMs),
          attempts: sql`GREATEST(${agentTasks.attempts} - 1, 0)`,
          lockedBy: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(this.fence(taskId, executionId))
        .returning({ id: agentTasks.id });
      if (rows.length === 0) throw new StaleExecutionError();
      await this.finishAttempt(tx, executionId, 'awaiting_confirmation', null, null, attemptMetadata);
    });
  }

  // ---------------------------------------------------------------- user-driven transitions

  /**
   * pending/awaiting_confirmation -> cancelled immediately; running -> cooperative cancel flag.
   */
  async requestCancel(userId: string, taskId: string): Promise<AgentTask> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)))
        .for('update');
      if (!row) throw new NotFoundError('Task not found');

      if (row.status === 'pending' || row.status === 'awaiting_confirmation') {
        if (row.status === 'awaiting_confirmation') {
          await this.rejectAwaitingToolCalls(tx, taskId);
        }
        const [updated] = await tx
          .update(agentTasks)
          .set({ status: 'cancelled', completedAt: dbNow, cancelRequestedAt: dbNow, updatedAt: dbNow })
          .where(eq(agentTasks.id, taskId))
          .returning();
        return updated as AgentTask;
      }
      if (row.status === 'running') {
        const [updated] = await tx
          .update(agentTasks)
          .set({ cancelRequestedAt: row.cancelRequestedAt ?? dbNow, updatedAt: dbNow })
          .where(eq(agentTasks.id, taskId))
          .returning();
        return updated as AgentTask;
      }
      throw new ConflictError(`Task is already ${row.status} and cannot be cancelled`);
    });
  }

  private async rejectAwaitingToolCalls(tx: Tx, taskId: string): Promise<void> {
    await tx
      .update(agentToolCalls)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(and(eq(agentToolCalls.taskId, taskId), eq(agentToolCalls.status, 'awaiting_confirmation')));
  }

  /** awaiting_confirmation -> pending, recording the user's decision on exactly one tool call. */
  async resolveConfirmation(
    userId: string,
    taskId: string,
    callId: string,
    decision: 'approve' | 'reject'
  ): Promise<AgentTask> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.userId, userId)))
        .for('update');
      if (!row) throw new NotFoundError('Task not found');
      if (row.status !== 'awaiting_confirmation') {
        throw new ConflictError(`Task is ${row.status}; there is nothing to confirm`);
      }
      const [{ expired } = { expired: false }] = await tx
        .select({ expired: sql<boolean>`coalesce(${agentTasks.confirmationExpiresAt} <= now(), false)` })
        .from(agentTasks)
        .where(eq(agentTasks.id, taskId));
      if (expired) throw new ConflictError('The confirmation request has expired');

      const updatedCalls = await tx
        .update(agentToolCalls)
        .set({ status: decision === 'approve' ? 'approved' : 'rejected', updatedAt: dbNow })
        .where(
          and(
            eq(agentToolCalls.taskId, taskId),
            eq(agentToolCalls.callId, callId),
            eq(agentToolCalls.status, 'awaiting_confirmation')
          )
        )
        .returning({ id: agentToolCalls.id });
      if (updatedCalls.length === 0) {
        throw new NotFoundError('No pending confirmation with that callId');
      }

      const [updated] = await tx
        .update(agentTasks)
        .set({ status: 'pending', runAfter: dbNow, result: null, confirmationExpiresAt: null, updatedAt: dbNow })
        .where(eq(agentTasks.id, taskId))
        .returning();
      return updated as AgentTask;
    });
  }

  // ---------------------------------------------------------------- recovery

  /**
   * Re-queues tasks whose worker vanished (lease expired) and expires stale confirmation requests.
   * Safe to run concurrently from several instances.
   */
  async recoverStale(): Promise<{ requeued: number; failed: number; cancelled: number; expired: number }> {
    return this.db.transaction(async (tx) => {
      const stats = { requeued: 0, failed: 0, cancelled: 0, expired: 0 };

      const stale = await tx
        .select()
        .from(agentTasks)
        .where(and(eq(agentTasks.status, 'running'), lt(agentTasks.leaseExpiresAt, dbNow)))
        .for('update', { skipLocked: true });

      for (const row of stale) {
        if (row.lockedBy) {
          await this.finishAttempt(tx, row.lockedBy, 'interrupted', 'LEASE_EXPIRED', 'Worker stopped responding');
        }
        const base = { lockedBy: null, leaseExpiresAt: null, updatedAt: dbNow };
        if (row.cancelRequestedAt) {
          await tx.update(agentTasks).set({ ...base, status: 'cancelled', completedAt: dbNow }).where(eq(agentTasks.id, row.id));
          stats.cancelled++;
        } else if (row.attempts >= row.maxAttempts) {
          await tx
            .update(agentTasks)
            .set({
              ...base,
              status: 'failed',
              errorCode: 'LEASE_EXPIRED',
              errorMessage: 'The task was interrupted too many times.',
              completedAt: dbNow,
            })
            .where(eq(agentTasks.id, row.id));
          stats.failed++;
        } else {
          await tx
            .update(agentTasks)
            .set({ ...base, status: 'pending', runAfter: dbNow })
            .where(eq(agentTasks.id, row.id));
          stats.requeued++;
        }
      }

      const expired = await tx
        .select({ id: agentTasks.id })
        .from(agentTasks)
        .where(
          and(
            eq(agentTasks.status, 'awaiting_confirmation'),
            isNotNull(agentTasks.confirmationExpiresAt),
            lt(agentTasks.confirmationExpiresAt, dbNow)
          )
        )
        .for('update', { skipLocked: true });
      for (const { id } of expired) {
        await this.rejectAwaitingToolCalls(tx, id);
        await tx
          .update(agentTasks)
          .set({
            status: 'cancelled',
            errorCode: 'CONFIRMATION_EXPIRED',
            errorMessage: 'No confirmation was received in time.',
            result: null,
            completedAt: dbNow,
            updatedAt: dbNow,
          })
          .where(eq(agentTasks.id, id));
        stats.expired++;
      }
      return stats;
    });
  }

  // ---------------------------------------------------------------- tool call ledger

  async getToolCall(taskId: string, callId: string): Promise<AgentToolCall | null> {
    const [row] = await this.db
      .select()
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.taskId, taskId), eq(agentToolCalls.callId, callId)))
      .limit(1);
    return row ?? null;
  }

  /** Inserts a ledger row. Returns false when the call ID already exists. */
  async insertToolCall(p: {
    taskId: string;
    callId: string;
    toolName: string;
    args: unknown;
    status: ToolCallStatus;
    result?: string | null;
    errorCode?: string | null;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(agentToolCalls)
      .values({
        taskId: p.taskId,
        callId: p.callId,
        toolName: p.toolName,
        args: p.args ?? {},
        status: p.status,
        result: p.result ?? null,
        errorCode: p.errorCode ?? null,
      })
      .onConflictDoNothing({ target: [agentToolCalls.taskId, agentToolCalls.callId] })
      .returning({ id: agentToolCalls.id });
    return rows.length > 0;
  }

  /** Compare-and-set on ledger status; the only way a call enters `running`. */
  async transitionToolCall(
    taskId: string,
    callId: string,
    from: ToolCallStatus[],
    to: ToolCallStatus,
    patch: { result?: string | null; errorCode?: string | null } = {}
  ): Promise<boolean> {
    const rows = await this.db
      .update(agentToolCalls)
      .set({
        status: to,
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentToolCalls.taskId, taskId),
          eq(agentToolCalls.callId, callId),
          inArray(agentToolCalls.status, from)
        )
      )
      .returning({ id: agentToolCalls.id });
    return rows.length > 0;
  }
}
