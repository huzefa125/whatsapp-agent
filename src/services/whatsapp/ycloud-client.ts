import { IWhatsAppClient } from './client';
import {
  WhatsAppSendTextRequest,
  WhatsAppSendTemplateRequest,
  WhatsAppSendImageRequest,
  WhatsAppReactionRequest,
  WhatsAppSendMessageResult,
} from './types';
import { AppError, ExternalServiceError, RateLimitError } from '../../utils/errors';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';

export interface YCloudClientConfig {
  apiKey: string;
  /** WhatsApp business number registered in YCloud (E.164). */
  from: string;
  timeoutMs?: number;
  baseUrl?: string;
}

export class YCloudClient implements IWhatsAppClient {
  private apiKey: string;
  private from: string;
  private timeoutMs: number;
  private url: string;
  private baseUrl: string;

  constructor(config: YCloudClientConfig) {
    if (!config.apiKey || config.apiKey.trim() === '') {
      throw new AppError('YCloud configuration error: API key is missing. Set YCLOUD_API_KEY.', 500, 'WHATSAPP_CONFIG_ERROR');
    }
    if (!config.from || config.from.trim() === '') {
      throw new AppError(
        'YCloud configuration error: sender number is missing. Set YCLOUD_WHATSAPP_FROM.',
        500,
        'WHATSAPP_CONFIG_ERROR'
      );
    }
    this.apiKey = config.apiKey;
    this.from = config.from.startsWith('+') ? config.from : `+${config.from}`;
    this.timeoutMs = config.timeoutMs || 10000;
    this.baseUrl = config.baseUrl || 'https://api.ycloud.com';
    this.url = `${this.baseUrl}/v2/whatsapp/messages/sendDirectly`;
  }

  async sendTextMessage(request: WhatsAppSendTextRequest): Promise<WhatsAppSendMessageResult> {
    const to = this.cleanRecipient(request.to);
    if (!request.text || request.text.trim() === '') {
      throw new AppError('Message body cannot be empty', 400, 'WHATSAPP_EMPTY_MESSAGE');
    }
    const body = request.text.length > 4096 ? request.text.slice(0, 4093) + '...' : request.text;

    logger.debug({ recipient: to, textLength: body.length }, 'Dispatching YCloud WhatsApp message');
    return this.post(
      { from: this.from, to, type: 'text', text: { body, preview_url: request.previewUrl ?? false } },
      to,
      request.maxRetries ?? 2
    );
  }

  async sendTemplateMessage(request: WhatsAppSendTemplateRequest): Promise<WhatsAppSendMessageResult> {
    const to = this.cleanRecipient(request.to);
    if (!request.templateName.trim()) {
      throw new AppError('Template name is required', 400, 'WHATSAPP_TEMPLATE_CONFIG');
    }
    return this.post(
      {
        from: this.from,
        to,
        type: 'template',
        template: {
          name: request.templateName,
          language: { code: request.languageCode },
          components: [
            { type: 'body', parameters: request.bodyParameters.map((text) => ({ type: 'text', text })) },
          ],
        },
      },
      to,
      request.maxRetries ?? 2
    );
  }

  /** Reacts to one of the user's messages with an emoji. */
  async sendReaction(request: WhatsAppReactionRequest): Promise<WhatsAppSendMessageResult> {
    const to = this.cleanRecipient(request.to);
    return this.post(
      { from: this.from, to, type: 'reaction', reaction: { message_id: request.messageId, emoji: request.emoji } },
      to,
      0
    );
  }

  /** Uploads the image to YCloud media storage, then sends it by media id. */
  async sendImageMessage(request: WhatsAppSendImageRequest): Promise<WhatsAppSendMessageResult> {
    const to = this.cleanRecipient(request.to);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(request.image)], { type: request.mimeType }), 'screenshot.png');

    const upload = await fetch(`${this.baseUrl}/v2/whatsapp/media/${encodeURIComponent(this.from)}/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs * 3),
    });
    const uploaded = (await upload.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
    if (!upload.ok || !uploaded?.id) {
      throw new ExternalServiceError('YCloud API', uploaded?.error?.message || `Media upload failed (HTTP ${upload.status})`, {
        statusCode: upload.status,
      });
    }
    return this.post(
      {
        from: this.from,
        to,
        type: 'image',
        image: { id: uploaded.id, ...(request.caption ? { caption: request.caption.slice(0, 1024) } : {}) },
      },
      to,
      0
    );
  }

  private cleanRecipient(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (!digits || digits.length < 8 || digits.length > 16) {
      throw new AppError(`Invalid recipient phone number: ${raw}`, 400, 'WHATSAPP_INVALID_RECIPIENT');
    }
    return `+${digits}`;
  }

  private async post(payload: Record<string, unknown>, to: string, maxRetries: number): Promise<WhatsAppSendMessageResult> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const response = await fetch(this.url, {
            method: 'POST',
            headers: { 'X-API-Key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          const data = (await response.json().catch(() => null)) as {
            id?: string;
            wamid?: string;
            error?: { code?: string; message?: string };
          } | null;

          if (!response.ok) {
            const message = data?.error?.message || `HTTP ${response.status}`;
            if (response.status === 429) {
              logger.warn({ recipient: to }, 'YCloud rate limit exceeded');
              throw new RateLimitError(`YCloud rate limit: ${message}`);
            }
            if (response.status === 401 || response.status === 403) {
              logger.error('YCloud API key unauthorized');
              throw new AppError(`YCloud API key unauthorized: ${message}`, 401, 'WHATSAPP_UNAUTHORIZED');
            }
            logger.error({ statusCode: response.status, errorCode: data?.error?.code }, 'YCloud API returned error');
            throw new ExternalServiceError('YCloud API', message, {
              statusCode: response.status,
              errorCode: data?.error?.code,
            });
          }

          // wamid is the WhatsApp message id that status webhooks reference; it can be absent until accepted.
          const providerMessageId = data?.wamid || data?.id;
          if (!providerMessageId) {
            throw new ExternalServiceError('YCloud API', 'Response did not include a message ID');
          }
          return { messagingProduct: 'whatsapp', providerMessageId, recipientId: to.replace(/\D/g, '') };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxRetries,
        initialDelayMs: 500,
        retryableErrors: (err) => {
          if (err instanceof RateLimitError) return true;
          if (err instanceof ExternalServiceError) return ((err.details?.statusCode as number) || 0) >= 500;
          return err instanceof Error && err.name === 'AbortError';
        },
      }
    );
  }
}
