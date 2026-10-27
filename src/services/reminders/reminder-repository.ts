import { randomUUID } from 'crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, max, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { messages, reminders, users, Reminder, User } from '../../db/schema';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { ReminderError } from './time';

export type ReminderStatus = 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'completed';

export class StaleReminderLeaseError extends Error {
  constructor() {
    super('Reminder lease was lost; another worker owns this reminder');
    this.name = 'StaleReminderLeaseError';
  }
}

export interface CreateReminderParams {
  userId: string;
  title: string;
  remindAt: Date;
  timezone: string;
  idempotencyKey: string | null;
  maxAttempts: number;
  maxActive: number;
  maxCreatesPerHour: number;
}

export interface ListReminderParams {
  status?: ReminderStatus | undefined;
  /** Only still-scheduled reminders at or after this instant, soonest first. */
  upcomingFrom?: Date | undefined;
  limit: number;
  offset: number;
}

export interface ClaimedReminder {
  reminder: Reminder;
  executionId: string;
}

export class ReminderRepository {
  private get db() {
    return getDb();
  }

  // ------------------------------------------------------------------ users

  async getUser(userId: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ?? null;
  }

  async setUserTimezone(userId: string, timezone: string): Promise<void> {
    const rows = await this.db
      .update(users)
      .set({ timezone, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (rows.length === 0) throw new NotFoundError('User not found');
  }

  /** Time of the user's most recent REAL WhatsApp message (API-created messages have no provider ID). */
  async lastInboundAt(userId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: max(messages.createdAt) })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.role, 'user'), sql`${messages.providerMessageId} is not null`));
    return row?.at ?? null;
  }

  // ------------------------------------------------------------------ user-facing operations

  async create(p: CreateReminderParams): Promise<{ reminder: Reminder; created: boolean }> {
    return this.db.transaction(async (tx) => {
      // Serialize creates per user so the quota checks below cannot be raced past.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${p.userId}))`);

      if (p.idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(reminders)
          .where(and(eq(reminders.userId, p.userId), eq(reminders.idempotencyKey, p.idempotencyKey)))
          .limit(1);
        if (existing) return { reminder: existing, created: false };
      }

      const [{ active = 0, recent = 0 } = {}] = await tx
        .select({
          active: sql<number>`count(*) filter (where ${reminders.status} in ('scheduled','processing'))::int`,
          recent: sql<number>`count(*) filter (where ${reminders.createdAt} > now() - interval '1 hour')::int`,
        })
        .from(reminders)
        .where(eq(reminders.userId, p.userId));
      if (active >= p.maxActive) {
        throw new ReminderError('TOO_MANY_REMINDERS', `You already have ${p.maxActive} active reminders. Cancel or complete some first.`, 429);
      }
      if (recent >= p.maxCreatesPerHour) {
        throw new ReminderError('RATE_LIMITED', 'Too many reminders created recently. Please try again later.', 429);
      }

      const [row] = await tx
        .insert(reminders)
        .values({
          userId: p.userId,
          title: p.title,
          remindAt: p.remindAt,
          timezone: p.timezone,
          nextAttemptAt: p.remindAt,
          maxAttempts: p.maxAttempts,
          idempotencyKey: p.idempotencyKey,
        })
        .returning();
      return { reminder: row as Reminder, created: true };
    });
  }

  async get(userId: string, id: string): Promise<Reminder | null> {
    const [row] = await this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  async list(userId: string, p: ListReminderParams): Promise<Reminder[]> {
    const conditions = [eq(reminders.userId, userId)];
    if (p.status) conditions.push(eq(reminders.status, p.status));
    if (p.upcomingFrom) {
      conditions.push(eq(reminders.status, 'scheduled'), gte(reminders.remindAt, p.upcomingFrom));
    }
    return this.db
      .select()
      .from(reminders)
      .where(and(...conditions))
      .orderBy(p.upcomingFrom ? asc(reminders.remindAt) : desc(reminders.remindAt), asc(reminders.id))
      .limit(p.limit)
      .offset(p.offset);
  }

  /** Moves a scheduled (or failed) reminder to a new instant and resets delivery state. */
  async reschedule(
    userId: string,
    id: string,
    p: { remindAt: Date; timezone: string; title?: string | undefined }
  ): Promise<Reminder> {
    const rows = await this.db
      .update(reminders)
      .set({
        remindAt: p.remindAt,
        nextAttemptAt: p.remindAt,
        timezone: p.timezone,
        ...(p.title !== undefined ? { title: p.title } : {}),
        status: 'scheduled',
        attempts: 0,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), inArray(reminders.status, ['scheduled', 'failed']))
      )
      .returning();
    return this.single(rows, userId, id, 'rescheduled');
  }

  async updateTitle(userId: string, id: string, title: string): Promise<Reminder> {
    const rows = await this.db
      .update(reminders)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'scheduled')))
      .returning();
    return this.single(rows, userId, id, 'edited');
  }

  /** Only a reminder that no worker is delivering can be cancelled. */
  async cancel(userId: string, id: string, now: Date): Promise<Reminder> {
    const rows = await this.db
      .update(reminders)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), inArray(reminders.status, ['scheduled', 'failed']))
      )
      .returning();
    return this.single(rows, userId, id, 'cancelled');
  }

  async complete(userId: string, id: string, now: Date): Promise<Reminder> {
    const rows = await this.db
      .update(reminders)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), inArray(reminders.status, ['scheduled', 'sent', 'failed']))
      )
      .returning();
    return this.single(rows, userId, id, 'completed');
  }

  private async single(rows: Reminder[], userId: string, id: string, verb: string): Promise<Reminder> {
    if (rows[0]) return rows[0];
    const current = await this.get(userId, id);
    if (!current) throw new NotFoundError('Reminder not found');
    if (current.status === 'processing') {
      throw new ConflictError('This reminder is being delivered right now and cannot be changed.');
    }
    throw new ConflictError(`A reminder that is ${current.status} cannot be ${verb}.`);
  }

  // ------------------------------------------------------------------ scheduler

  /**
   * Atomically claims the next due reminder. FOR UPDATE SKIP LOCKED lets any number of workers
   * (processes or instances) run this concurrently and receive distinct rows.
   * The `remind_at <= now` predicate (plus the DB CHECK next_attempt_at >= remind_at) makes
   * sending early structurally impossible.
   */
  async claimDue(now: Date, leaseMs: number): Promise<ClaimedReminder | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reminders)
        .where(
          and(eq(reminders.status, 'scheduled'), lte(reminders.nextAttemptAt, now), lte(reminders.remindAt, now))
        )
        .orderBy(asc(reminders.nextAttemptAt), asc(reminders.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;

      const executionId = randomUUID();
      const [claimed] = await tx
        .update(reminders)
        .set({
          status: 'processing',
          attempts: row.attempts + 1,
          lockedBy: executionId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          updatedAt: now,
        })
        // Compare-and-set: even without the row lock, only one claimer can flip scheduled -> processing.
        .where(and(eq(reminders.id, row.id), eq(reminders.status, 'scheduled')))
        .returning();
      if (!claimed) return null;
      return { reminder: claimed, executionId };
    });
  }

  private fence(id: string, executionId: string) {
    return and(eq(reminders.id, id), eq(reminders.lockedBy, executionId), eq(reminders.status, 'processing'));
  }

  async markAccepted(
    id: string,
    executionId: string,
    receipt: { provider: 'whatsapp' | 'mock'; providerMessageId: string; acceptedAt: Date }
  ): Promise<void> {
    const rows = await this.db
      .update(reminders)
      .set({
        status: 'sent',
        deliveryProvider: receipt.provider,
        providerMessageId: receipt.providerMessageId,
        acceptedAt: receipt.acceptedAt,
        lastErrorCode: null,
        lastErrorMessage: null,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(this.fence(id, executionId))
      .returning({ id: reminders.id });
    if (rows.length === 0) throw new StaleReminderLeaseError();
  }

  /** processing -> scheduled for another attempt. `nextAttemptAt` is clamped to never precede remind_at. */
  async scheduleRetry(id: string, executionId: string, nextAttemptAt: Date, code: string, message: string): Promise<void> {
    const rows = await this.db
      .update(reminders)
      .set({
        status: 'scheduled',
        nextAttemptAt: sql`greatest(${nextAttemptAt.toISOString()}::timestamptz, ${reminders.remindAt})`,
        lastErrorCode: code,
        lastErrorMessage: message,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(this.fence(id, executionId))
      .returning({ id: reminders.id });
    if (rows.length === 0) throw new StaleReminderLeaseError();
  }

  async markFailed(id: string, executionId: string, code: string, message: string): Promise<void> {
    const rows = await this.db
      .update(reminders)
      .set({
        status: 'failed',
        lastErrorCode: code,
        lastErrorMessage: message,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(this.fence(id, executionId))
      .returning({ id: reminders.id });
    if (rows.length === 0) throw new StaleReminderLeaseError();
  }

  /**
   * Re-queues reminders whose worker disappeared mid-delivery. Delivery is at-least-once: if the
   * worker died after WhatsApp accepted the message but before we recorded it, the retry can duplicate it.
   */
  async recoverStale(now: Date): Promise<{ requeued: number; failed: number }> {
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select()
        .from(reminders)
        .where(and(eq(reminders.status, 'processing'), lt(reminders.leaseExpiresAt, now)))
        .for('update', { skipLocked: true });

      let requeued = 0;
      let failed = 0;
      for (const row of stale) {
        const base = { lockedBy: null, leaseExpiresAt: null, updatedAt: now };
        if (row.attempts >= row.maxAttempts) {
          await tx
            .update(reminders)
            .set({ ...base, status: 'failed', lastErrorCode: 'WORKER_LOST', lastErrorMessage: 'Delivery was interrupted too many times.' })
            .where(eq(reminders.id, row.id));
          failed++;
        } else {
          await tx
            .update(reminders)
            .set({ ...base, status: 'scheduled', lastErrorCode: 'WORKER_LOST', lastErrorMessage: 'Delivery was interrupted; retrying.' })
            .where(eq(reminders.id, row.id));
          requeued++;
        }
      }
      return { requeued, failed };
    });
  }

  // ------------------------------------------------------------------ provider status webhooks

  /** Confirmed delivery (or provider-reported failure) for a message we previously got accepted. */
  async recordProviderStatus(
    providerMessageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    at: Date,
    errorCode?: number
  ): Promise<number> {
    if (status === 'delivered' || status === 'read') {
      const rows = await this.db
        .update(reminders)
        .set({ deliveredAt: sql`coalesce(${reminders.deliveredAt}, ${at.toISOString()}::timestamptz)`, updatedAt: new Date() })
        .where(and(eq(reminders.providerMessageId, providerMessageId), eq(reminders.deliveryProvider, 'whatsapp')))
        .returning({ id: reminders.id });
      return rows.length;
    }
    if (status === 'failed') {
      const rows = await this.db
        .update(reminders)
        .set({
          status: 'failed',
          lastErrorCode: 'PROVIDER_DELIVERY_FAILED',
          lastErrorMessage: `WhatsApp reported that delivery failed${errorCode ? ` (code ${errorCode})` : ''}.`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(reminders.providerMessageId, providerMessageId),
            eq(reminders.deliveryProvider, 'whatsapp'),
            eq(reminders.status, 'sent'),
            isNull(reminders.deliveredAt)
          )
        )
        .returning({ id: reminders.id });
      return rows.length;
    }
    return 0;
  }
}
