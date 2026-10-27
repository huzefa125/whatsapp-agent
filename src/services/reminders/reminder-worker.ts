import { getConfig } from '../../config/env';
import { Reminder } from '../../db/schema';
import { Clock, systemClock } from '../../utils/clock';
import { logger } from '../../utils/logger';
import {
  getNotificationProvider,
  NotificationContent,
  NotificationError,
  NotificationProvider,
  NotificationReceipt,
} from '../notifications';
import { ReminderRepository, StaleReminderLeaseError } from './reminder-repository';

/** WhatsApp's customer-service window is 24h from the user's last message; keep a safety margin. */
const WINDOW_MS = 24 * 3_600_000 - 5 * 60_000;

export interface WorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  leaseMs: number;
  sendTimeoutMs: number;
  templateName: string | undefined;
  templateLanguage: string;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export function workerConfigFromEnv(): WorkerConfig {
  const c = getConfig();
  return {
    pollIntervalMs: c.REMINDER_POLL_INTERVAL_MS,
    batchSize: c.REMINDER_BATCH_SIZE,
    leaseMs: c.REMINDER_LEASE_SECONDS * 1000,
    sendTimeoutMs: c.REMINDER_SEND_TIMEOUT_MS,
    templateName: c.WHATSAPP_REMINDER_TEMPLATE_NAME || undefined,
    templateLanguage: c.WHATSAPP_REMINDER_TEMPLATE_LANG,
    backoffBaseMs: 30_000,
    backoffMaxMs: 3_600_000,
  };
}

export interface WorkerDeps {
  repo?: ReminderRepository;
  provider?: NotificationProvider;
  clock?: Clock;
  config?: Partial<WorkerConfig>;
}

/**
 * Durable reminder scheduler. The `reminders` table is the schedule; this class only wakes up,
 * claims due rows atomically, delivers them, and records the outcome. Nothing is held in memory
 * that a restart could lose, and any number of instances can run it concurrently.
 */
export class ReminderWorker {
  private readonly repo: ReminderRepository;
  private readonly provider: NotificationProvider;
  private readonly clock: Clock;
  private readonly cfg: WorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(deps: WorkerDeps = {}) {
    this.repo = deps.repo ?? new ReminderRepository();
    this.provider = deps.provider ?? getNotificationProvider();
    this.clock = deps.clock ?? systemClock;
    this.cfg = { ...workerConfigFromEnv(), ...deps.config };
  }

  /** One scheduler pass: recover abandoned work, then deliver up to batchSize due reminders. */
  async tick(): Promise<number> {
    const recovered = await this.repo.recoverStale(this.clock.now());
    if (recovered.requeued || recovered.failed) logger.warn(recovered, 'Recovered stale reminders');

    let processed = 0;
    while (processed < this.cfg.batchSize && (await this.processOne())) processed++;
    return processed;
  }

  /** Claims and delivers a single due reminder. Returns false when nothing was due. */
  async processOne(): Promise<boolean> {
    const claim = await this.repo.claimDue(this.clock.now(), this.cfg.leaseMs);
    if (!claim) return false;

    const { reminder, executionId } = claim;
    // Never log the reminder text.
    const log = logger.child({ reminderId: reminder.id, executionId, attempt: reminder.attempts });
    log.info('Reminder delivery started');

    try {
      if (this.clock.now().getTime() < reminder.remindAt.getTime()) {
        // Defense in depth: claimDue() already requires remind_at <= now.
        await this.repo.scheduleRetry(reminder.id, executionId, reminder.remindAt, 'NOT_DUE_YET', 'Released: not yet due.');
        log.error('Invariant violated: claimed a reminder before its scheduled time; released it');
        return true;
      }

      const receipt = await this.deliver(reminder);
      await this.repo.markAccepted(reminder.id, executionId, receipt);
      log.info({ provider: receipt.provider }, 'Reminder accepted by provider (delivery not yet confirmed)');
    } catch (err) {
      await this.handleFailure(reminder, executionId, err, log);
    }
    return true;
  }

  private async deliver(reminder: Reminder): Promise<NotificationReceipt> {
    // A previous attempt already got a provider acceptance recorded: never send a second copy.
    if (reminder.providerMessageId && reminder.deliveryProvider) {
      return {
        provider: reminder.deliveryProvider as 'whatsapp' | 'mock',
        providerMessageId: reminder.providerMessageId,
        acceptedAt: reminder.acceptedAt ?? this.clock.now(),
      };
    }

    const user = await this.repo.getUser(reminder.userId);
    if (!user || !user.phoneVerifiedAt) {
      throw new NotificationError('permanent', 'RECIPIENT_NOT_VERIFIED', 'The recipient has no verified WhatsApp number.');
    }

    const content = await this.chooseContent(reminder);
    return this.sendWithTimeout(user.phoneNumber, reminder.id, content);
  }

  /** Free-form text inside the 24h customer-service window; an approved template outside it. */
  private async chooseContent(reminder: Reminder): Promise<NotificationContent> {
    const lastInbound = await this.repo.lastInboundAt(reminder.userId);
    const inWindow = lastInbound !== null && this.clock.now().getTime() - lastInbound.getTime() < WINDOW_MS;
    if (inWindow) return { kind: 'text', text: `⏰ Reminder: ${reminder.title}` };

    if (!this.cfg.templateName) {
      throw new NotificationError(
        'permanent',
        'OUTSIDE_WINDOW_NO_TEMPLATE',
        'The 24-hour WhatsApp window is closed and no approved template is configured (WHATSAPP_REMINDER_TEMPLATE_NAME).'
      );
    }
    return {
      kind: 'template',
      name: this.cfg.templateName,
      language: this.cfg.templateLanguage,
      bodyParameters: [reminder.title],
    };
  }

  private async sendWithTimeout(to: string, reminderId: string, content: NotificationContent): Promise<NotificationReceipt> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NotificationError('retryable', 'PROVIDER_TIMEOUT', 'The provider did not answer in time.')),
          this.cfg.sendTimeoutMs
        );
      });
      return await Promise.race([
        this.provider.send({ to, idempotencyKey: `reminder:${reminderId}`, content }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async handleFailure(reminder: Reminder, executionId: string, err: unknown, log: typeof logger): Promise<void> {
    if (err instanceof StaleReminderLeaseError) {
      log.warn('Reminder lease lost; another worker took over');
      return;
    }
    const failure =
      err instanceof NotificationError
        ? err
        : new NotificationError('retryable', 'INTERNAL_ERROR', 'Unexpected error while delivering.');
    if (!(err instanceof NotificationError)) log.error({ err }, 'Unexpected error delivering reminder');

    try {
      const canRetry = failure.kind === 'retryable' && reminder.attempts < reminder.maxAttempts;
      if (canRetry) {
        const backoff = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 4 ** (reminder.attempts - 1));
        const delay = Math.max(backoff, failure.retryAfterMs ?? 0);
        await this.repo.scheduleRetry(
          reminder.id,
          executionId,
          new Date(this.clock.now().getTime() + delay),
          failure.code,
          failure.message
        );
        log.warn({ errorCode: failure.code, delayMs: delay }, 'Reminder delivery failed; retry scheduled');
      } else {
        const exhausted = failure.kind === 'retryable';
        await this.repo.markFailed(
          reminder.id,
          executionId,
          exhausted ? 'RETRIES_EXHAUSTED' : failure.code,
          exhausted ? `Gave up after ${reminder.attempts} attempts. Last error: ${failure.message}` : failure.message
        );
        log.warn({ errorCode: failure.code, exhausted }, 'Reminder delivery failed permanently');
      }
    } catch (persistErr) {
      if (persistErr instanceof StaleReminderLeaseError) {
        log.warn('Reminder lease lost while recording failure');
      } else {
        log.error({ err: persistErr }, 'Could not persist reminder failure; lease recovery will requeue it');
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.timer) return;
    logger.info({ pollMs: this.cfg.pollIntervalMs, provider: this.provider.name }, 'Starting reminder worker');
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.tick()
        .then(() => undefined)
        .catch((err) => logger.error({ err }, 'Reminder worker iteration failed'))
        .finally(() => {
          this.inFlight = null;
        });
    }, this.cfg.pollIntervalMs);
  }

  /** Stops polling and waits (bounded) for the in-flight delivery so shutdown does not strand it. */
  async stop(waitMs = 8000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Reminder worker stopping');
    }
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
  }
}

let active: ReminderWorker | null = null;

export function getReminderWorker(): ReminderWorker {
  if (!active) active = new ReminderWorker();
  return active;
}
