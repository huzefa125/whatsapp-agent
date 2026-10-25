import { eq, and, lte, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { outboxJobs, webhookEvents, NewOutboxJob, OutboxJob } from '../../db/schema';
import { getAgentOrchestrator } from '../agent/orchestrator';
import { getWhatsAppClient } from '../whatsapp/client';
import { ParsedTextMessageEvent } from '../whatsapp/types';
import { logger } from '../../utils/logger';

export interface ProcessMessageJobPayload {
  event: ParsedTextMessageEvent;
}

export class OutboxService {
  private isProcessing = false;
  private workerInterval: NodeJS.Timeout | null = null;

  /**
   * Enqueues an incoming WhatsApp message for durable, idempotent processing.
   * Returns true if newly enqueued, false if duplicate.
   */
  async enqueueInboundMessage(event: ParsedTextMessageEvent): Promise<boolean> {
    const db = getDb();
    const eventId = event.providerMessageId;

    try {
      // 1. Record event in webhook_events table for idempotency
      const inserted = await db
        .insert(webhookEvents)
        .values({
          providerEventId: eventId,
          eventType: 'text_message',
          payload: event as unknown as Record<string, unknown>,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        logger.info({ eventId }, 'Duplicate webhook event received; idempotency gate triggered');
        return false;
      }

      // 2. Enqueue job into outbox_jobs
      const job: NewOutboxJob = {
        jobType: 'process_inbound_message',
        payload: { event } as unknown as Record<string, unknown>,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        nextRunAt: new Date(),
      };
      await db.insert(outboxJobs).values(job);

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

      // 1. Pass to Agent Orchestrator
      const orchestrator = getAgentOrchestrator();
      const result = await orchestrator.processTextMessage(event);

      // If duplicate or empty reply, nothing to send
      if (result.isDuplicate || !result.replyText) {
        return;
      }

      // 2. Dispatch response via WhatsApp Client
      const whatsapp = getWhatsAppClient();
      await whatsapp.sendTextMessage({
        to: event.senderPhoneNumber,
        text: result.replyText,
      });

      // 3. Mark webhook event processed
      const db = getDb();
      await db
        .update(webhookEvents)
        .set({
          status: 'processed',
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.providerEventId, event.providerMessageId));
    } else {
      logger.warn({ jobType: job.jobType }, 'Unknown outbox job type');
    }
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
