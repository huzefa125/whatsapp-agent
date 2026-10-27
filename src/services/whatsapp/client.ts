import { WhatsAppSendTextRequest, WhatsAppSendTemplateRequest, WhatsAppSendMessageResult } from './types';
import { AppError, ExternalServiceError, RateLimitError } from '../../utils/errors';
import { withRetry } from '../../utils/retry';
import { logger } from '../../utils/logger';

export interface WhatsAppClientConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  timeoutMs?: number;
}

export interface IWhatsAppClient {
  sendTextMessage(request: WhatsAppSendTextRequest): Promise<WhatsAppSendMessageResult>;
  sendTemplateMessage?(request: WhatsAppSendTemplateRequest): Promise<WhatsAppSendMessageResult>;
}

export class WhatsAppClient implements IWhatsAppClient {
  private accessToken: string;
  private phoneNumberId: string;
  private apiVersion: string;
  private timeoutMs: number;
  private baseUrl: string;

  constructor(config: WhatsAppClientConfig) {
    if (!config.accessToken || config.accessToken.trim() === '') {
      throw new AppError(
        'WhatsApp configuration error: Access token is missing. Set WHATSAPP_ACCESS_TOKEN.',
        500,
        'WHATSAPP_CONFIG_ERROR'
      );
    }
    if (!config.phoneNumberId || config.phoneNumberId.trim() === '') {
      throw new AppError(
        'WhatsApp configuration error: Phone Number ID is missing. Set WHATSAPP_PHONE_NUMBER_ID.',
        500,
        'WHATSAPP_CONFIG_ERROR'
      );
    }

    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.apiVersion = config.apiVersion || 'v21.0';
    this.timeoutMs = config.timeoutMs || 10000;
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
  }

  /**
   * Sends a standard text message to a user on WhatsApp.
   * Enforces 4096 character text limit per WhatsApp API specs.
   */
  async sendTextMessage(request: WhatsAppSendTextRequest): Promise<WhatsAppSendMessageResult> {
    const { to, text, previewUrl = false } = request;

    // Validation
    const cleanTo = to.replace(/\D/g, '');
    if (!cleanTo || cleanTo.length < 8 || cleanTo.length > 16) {
      throw new AppError(`Invalid recipient phone number: ${to}`, 400, 'WHATSAPP_INVALID_RECIPIENT');
    }

    if (!text || text.trim() === '') {
      throw new AppError('Message body cannot be empty', 400, 'WHATSAPP_EMPTY_MESSAGE');
    }

    // Truncate to Meta maximum 4096 chars if necessary
    const sanitizedText = text.length > 4096 ? text.slice(0, 4093) + '...' : text;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: {
        preview_url: previewUrl,
        body: sanitizedText,
      },
    };

    logger.debug({ recipient: cleanTo, textLength: sanitizedText.length }, 'Dispatching WhatsApp message');

    return this.post(payload, cleanTo, request.maxRetries ?? 2);
  }

  /**
   * Sends an approved template message (required outside the 24h customer-service window).
   */
  async sendTemplateMessage(request: WhatsAppSendTemplateRequest): Promise<WhatsAppSendMessageResult> {
    const cleanTo = request.to.replace(/\D/g, '');
    if (!cleanTo || cleanTo.length < 8 || cleanTo.length > 16) {
      throw new AppError('Invalid recipient phone number', 400, 'WHATSAPP_INVALID_RECIPIENT');
    }
    if (!request.templateName.trim()) {
      throw new AppError('Template name is required', 400, 'WHATSAPP_TEMPLATE_CONFIG');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'template',
      template: {
        name: request.templateName,
        language: { code: request.languageCode },
        components: [
          {
            type: 'body',
            parameters: request.bodyParameters.map((text) => ({ type: 'text', text })),
          },
        ],
      },
    };

    logger.debug({ templateName: request.templateName }, 'Dispatching WhatsApp template message');
    return this.post(payload, cleanTo, request.maxRetries ?? 2);
  }

  private async post(
    payload: Record<string, unknown>,
    cleanTo: string,
    maxRetries: number
  ): Promise<WhatsAppSendMessageResult> {
    const result = await withRetry(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
          const response = await fetch(this.baseUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          const data = (await response.json().catch(() => null)) as {
            messaging_product?: string;
            contacts?: Array<{ input: string; wa_id: string }>;
            messages?: Array<{ id: string }>;
            error?: {
              message: string;
              type: string;
              code: number;
              error_subcode?: number;
              fbtrace_id?: string;
            };
          } | null;

          if (!response.ok || data?.error) {
            const errorInfo = data?.error;
            const statusCode = response.status;
            const errorMessage = errorInfo?.message || `HTTP ${statusCode}`;
            const errorCode = errorInfo?.code;

            if (statusCode === 429 || errorCode === 80007) {
              logger.warn({ recipient: cleanTo, errorCode }, 'WhatsApp Cloud API rate limit exceeded');
              throw new RateLimitError(`WhatsApp rate limit: ${errorMessage}`);
            }

            if (statusCode === 401 || statusCode === 403 || errorCode === 190) {
              logger.error({ errorCode }, 'WhatsApp Cloud API token authorization failed');
              throw new AppError(`WhatsApp token unauthorized: ${errorMessage}`, 401, 'WHATSAPP_UNAUTHORIZED');
            }

            logger.error({ statusCode, errorCode, fbtrace: errorInfo?.fbtrace_id }, 'WhatsApp Cloud API returned error');
            throw new ExternalServiceError('WhatsApp API', errorMessage, {
              statusCode,
              errorCode,
              fbtraceId: errorInfo?.fbtrace_id,
            });
          }

          const messageId = data?.messages?.[0]?.id;
          if (!messageId) {
            throw new ExternalServiceError('WhatsApp API', 'Response did not include a message ID');
          }

          return {
            messagingProduct: data?.messaging_product || 'whatsapp',
            providerMessageId: messageId,
            recipientId: cleanTo,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
      {
        maxRetries,
        initialDelayMs: 500,
        retryableErrors: (err) => {
          if (err instanceof RateLimitError) return true;
          if (err instanceof ExternalServiceError) {
            const status = (err.details?.statusCode as number) || 0;
            return status >= 500;
          }
          if (err instanceof Error && err.name === 'AbortError') return true;
          return false;
        },
      }
    );

    return result;
  }
}

let activeWhatsAppClient: IWhatsAppClient | null = null;

export function getWhatsAppClient(): IWhatsAppClient {
  if (!activeWhatsAppClient) {
    const { getConfig } = require('../../config/env');
    const config = getConfig();
    activeWhatsAppClient = new WhatsAppClient({
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: config.WHATSAPP_API_VERSION,
    });
  }
  return activeWhatsAppClient;
}

export function setWhatsAppClientForTesting(client: IWhatsAppClient | null): void {
  activeWhatsAppClient = client;
}
