import { AppError, ExternalServiceError, RateLimitError } from '../../utils/errors';
import type { IWhatsAppClient } from '../whatsapp/client';
import {
  NotificationError,
  NotificationProvider,
  NotificationReceipt,
  NotificationRequest,
} from './types';

// Meta Cloud API error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const OUTSIDE_WINDOW = 131047; // re-engagement message: >24h since the user's last message
const UNDELIVERABLE = 131026;
const PAIR_RATE_LIMIT = 131056;
const THROUGHPUT = 130429;
const TEMPLATE_ERROR_MIN = 132000;
const TEMPLATE_ERROR_MAX = 132999;

/**
 * Delivery through the official WhatsApp Business Platform (Cloud API).
 * WhatsApp has no client-supplied idempotency key, so duplicate protection is the caller's job:
 * the scheduler persists the returned message ID and never re-sends once one exists.
 */
export class WhatsAppNotificationProvider implements NotificationProvider {
  readonly name = 'whatsapp' as const;

  constructor(private readonly client: IWhatsAppClient) {}

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    try {
      // maxRetries: 0 — retry policy (and duplicate risk) belongs to the scheduler, not the HTTP layer.
      const result =
        request.content.kind === 'text'
          ? await this.client.sendTextMessage({ to: request.to, text: request.content.text, maxRetries: 0 })
          : await this.sendTemplate(request);
      return { provider: 'whatsapp', providerMessageId: result.providerMessageId, acceptedAt: new Date() };
    } catch (err) {
      throw this.classify(err);
    }
  }

  private async sendTemplate(request: NotificationRequest) {
    if (request.content.kind !== 'template') throw new Error('unreachable');
    if (!this.client.sendTemplateMessage) {
      throw new NotificationError('permanent', 'TEMPLATE_UNSUPPORTED', 'The WhatsApp client cannot send templates.');
    }
    return this.client.sendTemplateMessage({
      to: request.to,
      templateName: request.content.name,
      languageCode: request.content.language,
      bodyParameters: request.content.bodyParameters,
      maxRetries: 0,
    });
  }

  classify(err: unknown): NotificationError {
    if (err instanceof NotificationError) return err;

    if (err instanceof RateLimitError) {
      return new NotificationError('retryable', 'PROVIDER_RATE_LIMITED', 'WhatsApp rate limit reached.', 60_000);
    }

    if (err instanceof AppError) {
      if (err.code === 'WHATSAPP_UNAUTHORIZED') {
        // Operator can fix the token while the bounded retries are still pending.
        return new NotificationError('retryable', 'PROVIDER_UNAUTHORIZED', 'WhatsApp credentials were rejected.');
      }
      if (err.code === 'WHATSAPP_INVALID_RECIPIENT') {
        return new NotificationError('permanent', 'INVALID_RECIPIENT', 'The recipient phone number is not valid.');
      }
      if (err.code === 'WHATSAPP_CONFIG_ERROR' || err.code === 'WHATSAPP_TEMPLATE_CONFIG') {
        return new NotificationError('permanent', 'PROVIDER_MISCONFIGURED', 'WhatsApp is not configured correctly.');
      }
    }

    if (err instanceof ExternalServiceError) {
      const status = Number(err.details?.statusCode ?? 0);
      const code = Number(err.details?.errorCode ?? 0);
      if (code === OUTSIDE_WINDOW) {
        return new NotificationError(
          'permanent',
          'OUTSIDE_MESSAGING_WINDOW',
          'The 24-hour messaging window is closed; an approved template is required.'
        );
      }
      if (code === UNDELIVERABLE) {
        return new NotificationError('permanent', 'RECIPIENT_UNDELIVERABLE', 'WhatsApp cannot deliver to this number.');
      }
      if (code >= TEMPLATE_ERROR_MIN && code <= TEMPLATE_ERROR_MAX) {
        return new NotificationError('permanent', 'TEMPLATE_REJECTED', 'The WhatsApp template was rejected.');
      }
      if (code === PAIR_RATE_LIMIT || code === THROUGHPUT || status === 429) {
        return new NotificationError('retryable', 'PROVIDER_RATE_LIMITED', 'WhatsApp rate limit reached.', 60_000);
      }
      if (status >= 500 || status === 0) {
        return new NotificationError('retryable', 'PROVIDER_UNAVAILABLE', 'WhatsApp is temporarily unavailable.');
      }
      return new NotificationError('permanent', 'PROVIDER_REJECTED', 'WhatsApp rejected the message.');
    }

    // Timeouts / network failures: the request may or may not have reached Meta.
    return new NotificationError('retryable', 'PROVIDER_NETWORK_ERROR', 'Could not reach WhatsApp.');
  }
}
