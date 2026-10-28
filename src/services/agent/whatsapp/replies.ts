import { sql } from 'drizzle-orm';
import { getConfig } from '../../../config/env';
import { getDb } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { WhatsAppNotificationProvider } from '../../notifications/whatsapp-provider';
import { getWhatsAppClient, IWhatsAppClient } from '../../whatsapp/client';

/** Delivery attempts per outcome before we stop trying and record `reply_error`. */
export const MAX_REPLY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5_000;
const LEASE_MS = 60_000;

export interface OwedReply {
  taskId: string;
  to: string;
  /** Outcome being announced: a terminal status, or `awaiting:<callId>`. Stored once it is delivered. */
  key: string;
  text: string;
  attempt: number;
}

interface ClaimRow {
  id: string;
  status: string;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  reply_attempts: number;
  phone_number: string;
  reply_key_now: string;
}

/**
 * What the user is told for each task outcome. Only text that is safe to show: the model's final answer,
 * the engine's user-facing failure messages, or fixed strings. Never stack traces or tool internals.
 */
export function composeReply(row: Pick<ClaimRow, 'status' | 'result' | 'error_code' | 'error_message'>): string {
  const result = (row.result ?? null) as { response?: unknown; pendingConfirmation?: { summary?: unknown } } | null;
  switch (row.status) {
    case 'succeeded':
      return typeof result?.response === 'string' && result.response.trim() ? result.response : 'Done.';
    case 'awaiting_confirmation': {
      const summary =
        typeof result?.pendingConfirmation?.summary === 'string' ? result.pendingConfirmation.summary : 'an action';
      return `Please confirm: ${summary}\n\nReply YES to go ahead or NO to cancel.`;
    }
    case 'cancelled':
      return row.error_code === 'CONFIRMATION_EXPIRED'
        ? 'That request timed out before you confirmed it, so nothing was done. Just ask again if you still want it.'
        : "Okay, I've cancelled that.";
    default:
      return `Sorry, I couldn't complete that. ${row.error_message ?? 'Something went wrong.'} Please try again.`.trim();
  }
}

/**
 * Pushes task outcomes back to the user on WhatsApp. The `agent_tasks` row is the outbox: a task is owed a
 * reply while `reply_key` differs from its current outcome, so nothing is lost on restart and a confirmation
 * prompt followed by a final answer are two separate, individually tracked replies. Delivery is at-least-once.
 */
export class WhatsAppReplyDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly client: IWhatsAppClient = getWhatsAppClient()) {}

  /** Atomically leases the next reply that is owed (SKIP LOCKED: safe across instances). */
  async claimNext(): Promise<OwedReply | null> {
    const res = await getDb().execute(sql`
      WITH next AS (
        SELECT t.id FROM agent_tasks t
        WHERE t.channel = 'whatsapp'
          AND t.status IN ('succeeded', 'failed', 'cancelled', 'awaiting_confirmation')
          AND t.reply_key IS DISTINCT FROM (CASE WHEN t.status = 'awaiting_confirmation'
                THEN 'awaiting:' || coalesce(t.result->'pendingConfirmation'->>'callId', '') ELSE t.status END)
          AND t.reply_next_at <= now()
          AND (t.reply_lease_until IS NULL OR t.reply_lease_until < now())
        ORDER BY t.updated_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE agent_tasks t
      SET reply_lease_until = now() + (${LEASE_MS} * interval '1 millisecond'),
          reply_attempts = t.reply_attempts + 1
      FROM next, users u
      WHERE t.id = next.id AND u.id = t.user_id
      RETURNING t.id, t.status, t.result, t.error_code, t.error_message, t.reply_attempts, u.phone_number,
        (CASE WHEN t.status = 'awaiting_confirmation'
              THEN 'awaiting:' || coalesce(t.result->'pendingConfirmation'->>'callId', '') ELSE t.status END) AS reply_key_now
    `);
    const row = (res.rows as unknown as ClaimRow[])[0];
    if (!row) return null;
    return {
      taskId: row.id,
      to: row.phone_number,
      key: row.reply_key_now,
      text: composeReply(row),
      attempt: row.reply_attempts,
    };
  }

  private async markDone(taskId: string, key: string, error: string | null): Promise<void> {
    await getDb().execute(sql`
      UPDATE agent_tasks
      SET reply_key = ${key}, reply_attempts = 0, reply_error = ${error}, reply_lease_until = NULL, reply_next_at = now()
      WHERE id = ${taskId}`);
  }

  private async scheduleRetry(taskId: string, attempt: number, error: string): Promise<void> {
    const delay = Math.min(300_000, BASE_BACKOFF_MS * 4 ** (attempt - 1));
    await getDb().execute(sql`
      UPDATE agent_tasks
      SET reply_error = ${error}, reply_lease_until = NULL, reply_next_at = now() + (${delay} * interval '1 millisecond')
      WHERE id = ${taskId}`);
  }

  /** Claims and delivers one owed reply. Returns false when none was owed. */
  async processNext(): Promise<boolean> {
    const owed = await this.claimNext();
    if (!owed) return false;
    const log = logger.child({ taskId: owed.taskId, replyKey: owed.key, attempt: owed.attempt });
    try {
      await this.client.sendTextMessage({ to: owed.to, text: owed.text, maxRetries: 0 });
      await this.markDone(owed.taskId, owed.key, null);
      log.info('WhatsApp reply sent');
    } catch (err) {
      const failure = new WhatsAppNotificationProvider(this.client).classify(err);
      const giveUp = failure.kind === 'permanent' || owed.attempt >= MAX_REPLY_ATTEMPTS;
      if (giveUp) {
        await this.markDone(owed.taskId, owed.key, failure.code);
        log.error({ errorCode: failure.code }, 'WhatsApp reply could not be delivered; giving up');
      } else {
        await this.scheduleRetry(owed.taskId, owed.attempt, failure.code);
        log.warn({ errorCode: failure.code }, 'WhatsApp reply failed; retry scheduled');
      }
    }
    return true;
  }

  start(): void {
    if (this.timer) return;
    const pollMs = getConfig().AGENT_POLL_INTERVAL_MS;
    logger.info({ pollMs }, 'Starting WhatsApp reply dispatcher');
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = (async () => {
        try {
          while (this.timer && (await this.processNext())) {
            /* drain */
          }
        } catch (err) {
          logger.error({ err }, 'WhatsApp reply dispatcher iteration failed');
        }
      })().finally(() => {
        this.inFlight = null;
      });
    }, pollMs);
  }

  async stop(waitMs = 8000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
  }
}

let active: WhatsAppReplyDispatcher | null = null;

export function getReplyDispatcher(): WhatsAppReplyDispatcher {
  if (!active) active = new WhatsAppReplyDispatcher();
  return active;
}

export function setReplyDispatcherForTesting(dispatcher: WhatsAppReplyDispatcher | null): void {
  active = dispatcher;
}
