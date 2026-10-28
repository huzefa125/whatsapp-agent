import { eq, and, lte, lt, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { outboxJobs, webhookEvents, NewOutboxJob, OutboxJob } from '../../db/schema';
import { getWhatsAppChannel } from '../agent/whatsapp/channel';
import { ParsedTextMessageEvent } from '../whatsapp/types';
import { logger } from '../../utils/logger';

/** Far longer than any job runs (it only enqueues work), so a live job is never mistaken for a dead one. */
const STALE_PROCESSING_MS = 5 * 60_000;

export interface ProcessMessageJobPayload {
  event: ParsedTextMessageEvent;
}

export class OutboxService {
  private isProcessing = false;
  private workerInterval: NodeJS.Timeout | null = null;
  private lastRecovery = 0;

  /**
   * Enqueues an incoming WhatsApp message for durable, idempotent processing.
   * Returns true if newly enqueued, false if duplicate.
   */
  async enqueueInboundMessage(event: ParsedTextMessageEvent): Promise<boolean> {
    const db = getDb();
    const eventId = event.providerMessageId;

    try {
      // One transaction: either the event is recorded AND queued, or neither. Otherwise a crash between the
      // two inserts would leave the event recorded, make Meta's retry look like a duplicate, and drop the message.
      const enqueued = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(webhookEvents)
          .values({
            providerEventId: eventId,
            eventType: 'text_message',
            payload: event as unknown as Record<string, unknown>,
            status: 'pending',
          })
          .onConflictDoNothing()
          .returning();

        if (inserted.length === 0) return false;

        const job: NewOutboxJob = {
          jobType: 'process_inbound_message',
          payload: { event } as unknown as Record<string, unknown>,
          status: 'pending',
          attempts: 0,
          maxAttempts: 3,
          nextRunAt: new Date(),
        };
        await tx.insert(outboxJobs).values(job);
        return true;
      });

      if (!enqueued) {
        logger.info({ eventId }, 'Duplicate webhook event received; idempotency gate triggered');
        return false;
      }

      logger.info({ eventId }, 'Durable outbox job enqueued for message processing');
      return true;
    } catch (err) {
      logger.error({ err, eventId }, 'Failed to enqueue inbound message');
      throw err;
    }
  }

  /**
   * Processes the next available pending job with locking/status update.
   */
  async processNextJob(): Promise<boolean> {
    const db = getDb();
    const now = new Date();

    // Find next eligible job
    const candidateJobs = await db
      .select()
      .from(outboxJobs)
      .where(and(eq(outboxJobs.status, 'pending'), lte(outboxJobs.nextRunAt, now)))
      .orderBy(asc(outboxJobs.createdAt))
      .limit(1);

    const job = candidateJobs[0];
    if (!job) {
      return false; // No pending jobs
    }

    // Mark job as processing
    await db
      .update(outboxJobs)
      .set({
        status: 'processing',
        attempts: job.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(outboxJobs.id, job.id));

    try {
      await this.executeJob(job);

      // Mark completed
      await db
        .update(outboxJobs)
        .set({
          status: 'completed',
          updatedAt: new Date(),
        })
        .where(eq(outboxJobs.id, job.id));

      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const nextAttempt = job.attempts + 1;
      const isDeadLetter = nextAttempt >= job.maxAttempts;

      // Exponential backoff: 2s, 8s, 32s...
      const backoffDelayMs = Math.min(60000, 2000 * Math.pow(4, job.attempts));
      const nextRunAt = new Date(Date.now() + backoffDelayMs);

      logger.error(
        {
          jobId: job.id,
          attempt: nextAttempt,
          maxAttempts: job.maxAttempts,
          isDeadLetter,
          error: errorMessage,
        },
        'Outbox job failed'
      );

      await db
        .update(outboxJobs)
        .set({
          status: isDeadLetter ? 'dead_letter' : 'pending',
          lastError: errorMessage,
          nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(outboxJobs.id, job.id));

      return true;
    }
  }

  private async executeJob(job: OutboxJob): Promise<void> {
    if (job.jobType === 'process_inbound_message') {
      const payload = job.payload as unknown as ProcessMessageJobPayload;
      const event = payload.event;
      // The stored payload is JSON, so the timestamp comes back as a string.
      event.timestamp = new Date(event.timestamp);

      // Idempotent per WhatsApp message id; the answer is delivered later by the reply dispatcher.
      await getWhatsAppChannel().handleInbound(event);

      await getDb()
        .update(webhookEvents)
        .set({ status: 'processed', processedAt: new Date() })
        .where(eq(webhookEvents.providerEventId, event.providerMessageId));
    } else {
      logger.warn({ jobType: job.jobType }, 'Unknown outbox job type');
    }
  }

  /**
   * A job left in `processing` means the process died mid-job. Jobs are idempotent, so put them back in the
   * queue (the attempt that was in flight already counted toward maxAttempts).
   */
  async recoverStaleJobs(staleAfterMs = STALE_PROCESSING_MS): Promise<number> {
    const db = getDb();
    const cutoff = new Date(Date.now() - staleAfterMs);
    const recovered = await db
      .update(outboxJobs)
      .set({ status: 'pending', nextRunAt: new Date(), updatedAt: new Date(), lastError: 'Recovered after worker stopped mid-job' })
      .where(and(eq(outboxJobs.status, 'processing'), lt(outboxJobs.updatedAt, cutoff)))
      .returning({ id: outboxJobs.id });
    if (recovered.length > 0) logger.warn({ count: recovered.length }, 'Recovered stale outbox jobs');
    return recovered.length;
  }

  /**
   * Starts background worker loop for polling pending outbox jobs.
   */
  startWorker(pollIntervalMs = 2000): void {
    if (this.workerInterval) return;

    logger.info({ pollIntervalMs }, 'Starting outbox queue worker');
    this.workerInterval = setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        if (Date.now() - this.lastRecovery > 60_000) {
          this.lastRecovery = Date.now();
          await this.recoverStaleJobs();
        }
        let hasMore = true;
        while (hasMore) {
          hasMore = await this.processNextJob();
        }
      } catch (err) {
        logger.error({ err }, 'Error in outbox queue worker iteration');
      } finally {
        this.isProcessing = false;
      }
    }, pollIntervalMs);
  }

  /**
   * Stops background worker cleanly.
   */
  stopWorker(): void {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
      logger.info('Outbox queue worker stopped');
    }
  }
}

let activeOutboxService: OutboxService | null = null;

export function getOutboxService(): OutboxService {
  if (!activeOutboxService) {
    activeOutboxService = new OutboxService();
  }
  return activeOutboxService;
}

export function setOutboxServiceForTesting(service: OutboxService | null): void {
  activeOutboxService = service;
}
