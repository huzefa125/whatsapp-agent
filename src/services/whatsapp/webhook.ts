import {
  MetaWebhookPayload,
  ParsedWebhookEvent,
  ParsedTextMessageEvent,
  ParsedUnsupportedMediaEvent,
  ParsedStatusEvent,
  YCloudWebhookEvent,
} from './types';
import { verifyMetaSignature } from '../../utils/crypto';
import { logger } from '../../utils/logger';

/**
 * Validates Meta's GET verification request for Webhook setup.
 * Returns the challenge string if valid, or null if invalid.
 */
export function verifyWebhookChallenge(
  query: Record<string, unknown>,
  configuredVerifyToken: string
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === configuredVerifyToken && typeof challenge === 'string') {
    return challenge;
  }

  return null;
}

/**
 * Validates incoming POST webhook signature.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  return verifyMetaSignature(rawBody, signatureHeader, appSecret);
}

/**
 * Parses a YCloud webhook event into the same ParsedWebhookEvent shape as the Meta parser.
 * Handles `whatsapp.inbound_message.received` and `whatsapp.message.updated`.
 */
export function parseYCloudPayload(payload: unknown): ParsedWebhookEvent[] {
  if (!payload || typeof payload !== 'object') {
    return [{ type: 'ignored', reason: 'Payload is not an object' }];
  }
  const evt = payload as YCloudWebhookEvent;

  if (evt.type === 'whatsapp.inbound_message.received' && evt.whatsappInboundMessage) {
    const msg = evt.whatsappInboundMessage;
    const providerMessageId = msg.wamid || msg.id;
    const senderPhoneNumber = (msg.from || '').replace(/\D/g, '');
    const timestamp = msg.sendTime ? new Date(msg.sendTime) : new Date();
    const phoneNumberId = (msg.to || '').replace(/\D/g, '');
    const senderName = msg.customerProfile?.name;

    if (msg.type === 'text' && typeof msg.text?.body === 'string') {
      return [{
        type: 'text_message',
        providerMessageId,
        senderPhoneNumber,
        senderName,
        text: msg.text.body,
        timestamp,
        phoneNumberId,
        raw: msg,
      }];
    }
    // Voice notes / audio: queued like text, transcribed later once the sender is known to be verified.
    if (msg.type === 'audio' && msg.audio?.link) {
      return [{
        type: 'text_message',
        providerMessageId,
        senderPhoneNumber,
        senderName,
        text: '',
        audio: { url: msg.audio.link, mimeType: msg.audio.mime_type },
        timestamp,
        phoneNumberId,
        raw: msg,
      }];
    }
    return [{
      type: 'unsupported_media',
      providerMessageId,
      senderPhoneNumber,
      senderName,
      mediaType: msg.type || 'unknown',
      timestamp,
      phoneNumberId,
      raw: msg,
    }];
  }

  if (evt.type === 'whatsapp.message.updated' && evt.whatsappMessage) {
    const m = evt.whatsappMessage;
    const status = m.status === 'failed' ? 'failed'
      : m.status === 'read' ? 'read'
      : m.status === 'delivered' ? 'delivered'
      : m.status === 'sent' || m.status === 'accepted' ? 'sent'
      : null;
    if (!status) return [{ type: 'ignored', reason: `Ignored YCloud status: ${m.status}` }];

    return [{
      type: 'status_update',
      providerMessageId: m.wamid || m.id,
      recipientPhoneNumber: (m.to || '').replace(/\D/g, ''),
      status,
      timestamp: m.createTime ? new Date(m.createTime) : new Date(),
      errors: status === 'failed'
        ? [{ code: Number(m.errorCode) || 0, title: m.errorMessage || 'Message failed', message: m.errorMessage }]
        : undefined,
      raw: m,
    }];
  }

  return [{ type: 'ignored', reason: `Ignored YCloud event type: ${evt.type}` }];
}

/**
 * Parses and categorizes events from a Meta WhatsApp webhook payload.
 */
export function parseWebhookPayload(payload: unknown): ParsedWebhookEvent[] {
  if (!payload || typeof payload !== 'object') {
    return [{ type: 'ignored', reason: 'Payload is not an object' }];
  }

  const webhook = payload as MetaWebhookPayload;
  if (webhook.object !== 'whatsapp_business_account') {
    return [{ type: 'ignored', reason: `Ignored object type: ${webhook.object}` }];
  }

  if (!Array.isArray(webhook.entry) || webhook.entry.length === 0) {
    return [{ type: 'ignored', reason: 'No entries in webhook' }];
  }

  const results: ParsedWebhookEvent[] = [];

  for (const entry of webhook.entry) {
    if (!Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;

      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id || '';
      const contactMap = new Map<string, string>();
      if (Array.isArray(value.contacts)) {
        for (const contact of value.contacts) {
          if (contact.wa_id && contact.profile?.name) {
            contactMap.set(contact.wa_id, contact.profile.name);
          }
        }
      }

      // 1. Process Messages
      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          const timestamp = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
          const senderName = contactMap.get(msg.from);

          if (msg.type === 'text' && msg.text && typeof msg.text.body === 'string') {
            const textEvent: ParsedTextMessageEvent = {
              type: 'text_message',
              providerMessageId: msg.id,
              senderPhoneNumber: msg.from,
              senderName,
              text: msg.text.body,
              timestamp,
              phoneNumberId,
              raw: msg,
            };
            results.push(textEvent);
          } else {
            // Non-text media (e.g. image, audio, voice, video, document, location)
            const unsupportedEvent: ParsedUnsupportedMediaEvent = {
              type: 'unsupported_media',
              providerMessageId: msg.id,
              senderPhoneNumber: msg.from,
              senderName,
              mediaType: msg.type || 'unknown',
              timestamp,
              phoneNumberId,
              raw: msg,
            };
            results.push(unsupportedEvent);
          }
        }
      }

      // 2. Process Statuses (sent, delivered, read, failed)
      if (Array.isArray(value.statuses)) {
        for (const status of value.statuses) {
          const timestamp = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();
          const statusEvent: ParsedStatusEvent = {
            type: 'status_update',
            providerMessageId: status.id,
            recipientPhoneNumber: status.recipient_id,
            status: status.status,
            timestamp,
            errors: status.errors,
            raw: status,
          };
          results.push(statusEvent);
        }
      }
    }
  }

  if (results.length === 0) {
    logger.debug('No actionable message or status events found in webhook payload');
    return [{ type: 'ignored', reason: 'No actionable events in payload' }];
  }

  return results;
}
