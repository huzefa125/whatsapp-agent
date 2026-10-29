import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { conversations, messages, users } from '../../../db/schema';
import { BadRequestError, ConflictError, NotFoundError } from '../../../utils/errors';
import { normalizePhoneNumber } from '../../../utils/normalization';
import { logger } from '../../../utils/logger';
import { getWhatsAppClient, IWhatsAppClient } from '../../whatsapp/client';
import type { ParsedTextMessageEvent } from '../../whatsapp/types';
import { AgentTaskService, getAgentTaskService } from '../engine/task-service';
import { getTranscriber, Transcriber } from '../../transcription';

export const NOT_REGISTERED_REPLY =
  "Hi! I don't recognise this number yet. Please finish signing up (verify your WhatsApp number and email) and then message me again.";
export const VOICE_DISABLED_REPLY = "Voice notes aren't enabled yet. Please type your message.";
export const VOICE_UNCLEAR_REPLY = "Sorry, I couldn't make out that voice note. Could you try again or type it?";
export const TOO_LONG_REPLY = 'That message is too long for me to handle. Could you shorten it or split it up?';

const YES = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'confirm', 'confirmed', 'go ahead', 'do it', '👍']);
const NO = new Set(['no', 'n', 'nope', 'cancel', 'stop', 'reject', 'dont', "don't", 'do not', 'never mind', 'nevermind', '👎']);

const normalizeCommand = (text: string) => text.trim().toLowerCase().replace(/[\s.!]+$/g, '');

/** Strict whole-message match: "yes please set it" is a normal message, not a confirmation. */
export function parseDecision(text: string): 'approve' | 'reject' | null {
  const t = normalizeCommand(text);
  if (YES.has(t)) return 'approve';
  if (NO.has(t)) return 'reject';
  return null;
}

/**
 * Turns an inbound WhatsApp text into engine work. Everything here is idempotent per WhatsApp message id,
 * because the outbox that calls it is at-least-once. Task outcomes are NOT sent from here: the reply
 * dispatcher announces them. Only short fixed notices (unknown number, "still waiting for YES/NO") are sent inline.
 */
export class WhatsAppChannel {
  constructor(
    private readonly tasks: AgentTaskService = getAgentTaskService(),
    private readonly client: IWhatsAppClient = getWhatsAppClient(),
    private readonly transcriber: Transcriber | null = null
  ) {}

  async handleInbound(event: ParsedTextMessageEvent): Promise<void> {
    let text = event.text.replace(/\0/g, '').trim();
    if (!text && !event.audio) return;

    let phone: string;
    try {
      phone = normalizePhoneNumber(event.senderPhoneNumber); // Meta sends digits without "+"
    } catch {
      logger.warn({ messageId: event.providerMessageId }, 'Ignoring inbound message with an invalid sender number');
      return;
    }

    const [user] = await getDb().select().from(users).where(eq(users.phoneNumber, phone)).limit(1);
    // Only fully verified accounts reach the model: no AI spend and no user rows for strangers.
    if (!user || !user.phoneVerifiedAt || !user.emailVerifiedAt) {
      await this.say(phone, NOT_REGISTERED_REPLY);
      return;
    }

    const wamid = event.providerMessageId;
    const repo = this.tasks.repo;

    // Voice note: turn it into text only now that the sender is verified (no API spend for strangers).
    if (!text && event.audio) {
      const transcriber = this.transcriber ?? getTranscriber();
      if (!transcriber) {
        await this.say(phone, VOICE_DISABLED_REPLY);
        return;
      }
      // A transcription failure throws, so the outbox retries the whole (idempotent) job.
      text = (await transcriber.transcribe(event.audio)).replace(/\0/g, '').trim();
      logger.info({ messageId: wamid, chars: text.length }, 'Voice note transcribed');
      if (!text) {
        await this.say(phone, VOICE_UNCLEAR_REPLY);
        return;
      }
    }

    // 1. A confirmation is pending: this message answers it.
    const awaiting = await repo.latestForUser(user.id, 'whatsapp', ['awaiting_confirmation']);
    if (awaiting) {
      const pending = (awaiting.result as { pendingConfirmation?: { callId: string; summary: string } } | null)
        ?.pendingConfirmation;
      if (!pending) return;
      const decision = parseDecision(text);
      if (!decision) {
        await this.say(phone, `I'm waiting for your answer on: ${pending.summary}\n\nReply YES to go ahead or NO to cancel.`);
        await this.recordControlMessage(user.id, text, wamid);
        return;
      }
      const seen = await this.messageSeen(wamid);
      try {
        await this.tasks.confirmTask(user.id, awaiting.id, pending.callId, decision);
      } catch (err) {
        if (!(err instanceof ConflictError || err instanceof NotFoundError)) throw err;
        // A redelivered job finds the confirmation already resolved: stay quiet then.
        if (!seen) await this.say(phone, 'That request is no longer waiting for confirmation (it may have expired). Just ask me again.');
      }
      await this.recordControlMessage(user.id, text, wamid);
      return;
    }

    // 2. "cancel" / "stop" while a request is still being worked on.
    if (['cancel', 'stop'].includes(normalizeCommand(text))) {
      const running = await repo.latestForUser(user.id, 'whatsapp', ['running', 'pending']);
      if (running) {
        try {
          await this.tasks.cancelTask(user.id, running.id);
        } catch (err) {
          if (!(err instanceof ConflictError || err instanceof NotFoundError)) throw err;
        }
        await this.recordControlMessage(user.id, text, wamid);
        return;
      }
    }

    // 3. A normal request for the agent. The wamid-derived key makes redelivery a no-op.
    const conversationId = await this.activeConversation(user.id);
    try {
      await this.tasks.createTask(user.id, {
        request: text,
        conversationId,
        idempotencyKey: `wa:${wamid}`,
        channel: 'whatsapp',
        providerMessageId: wamid,
      });
    } catch (err) {
      if (!(err instanceof BadRequestError)) throw err;
      await this.say(phone, TOO_LONG_REPLY);
    }
  }

  private async say(to: string, text: string): Promise<void> {
    await this.client.sendTextMessage({ to, text });
  }

  private async activeConversation(userId: string): Promise<string> {
    const db = getDb();
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.status, 'active')))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    if (existing) return existing.id;
    const [created] = await db.insert(conversations).values({ userId, title: 'WhatsApp Chat', status: 'active' }).returning();
    if (!created) throw new Error('Failed to create conversation');
    return created.id;
  }

  private async messageSeen(wamid: string): Promise<boolean> {
    const [row] = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.providerMessageId, wamid))
      .limit(1);
    return Boolean(row);
  }

  /**
   * Stores a YES/NO/cancel message. It is a real inbound message (it opens the 24h window) but must not be
   * mistaken for a request, so it is tagged and carries no task id.
   */
  private async recordControlMessage(userId: string, text: string, wamid: string): Promise<void> {
    const conversationId = await this.activeConversation(userId);
    await getDb()
      .insert(messages)
      .values({
        conversationId,
        userId,
        role: 'user',
        content: text,
        providerMessageId: wamid,
        status: 'received',
        metadata: { control: true },
      })
      .onConflictDoNothing();
  }
}

let active: WhatsAppChannel | null = null;

export function getWhatsAppChannel(): WhatsAppChannel {
  if (!active) active = new WhatsAppChannel();
  return active;
}

export function setWhatsAppChannelForTesting(channel: WhatsAppChannel | null): void {
  active = channel;
}
