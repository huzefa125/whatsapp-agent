import { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/env';
import {
  verifyWebhookChallenge,
  verifyWebhookSignature,
  parseWebhookPayload,
  parseYCloudPayload,
} from '../services/whatsapp/webhook';
import { verifyYCloudSignature } from '../utils/crypto';
import { getOutboxService } from '../services/queue/outbox';
import { getReminderService } from '../services/reminders/reminder-service';
import { ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';

export class WebhookController {
  /**
   * Meta Webhook Verification Challenge (GET /webhook)
   */
  static verify(req: Request, res: Response, next: NextFunction): void {
    try {
      const config = getConfig();
      const challenge = verifyWebhookChallenge(
        req.query as Record<string, unknown>,
        config.WHATSAPP_VERIFY_TOKEN
      );

      if (!challenge) {
        logger.warn({ query: req.query }, 'Webhook verification rejected: invalid token or mode');
        throw new ForbiddenError('Webhook verification failed: token or mode mismatch');
      }

      logger.info('WhatsApp webhook verified successfully');
      res.status(200).send(challenge);
    } catch (err) {
      next(err);
    }
  }

  /**
   * Meta Webhook Event Ingestion (POST /webhook)
   */
  static async handleEvent(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const config = getConfig();
      const isYCloud = config.WHATSAPP_PROVIDER === 'ycloud';
      const signatureHeaderName = isYCloud ? 'YCloud-Signature' : 'X-Hub-Signature-256';
      const signatureHeader = req.headers[signatureHeaderName.toLowerCase()] as string | undefined;
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

      // Signature verification
      const isSignatureValid = isYCloud
        ? verifyYCloudSignature(rawBody, signatureHeader, config.YCLOUD_WEBHOOK_SECRET)
        : verifyWebhookSignature(rawBody, signatureHeader, config.WHATSAPP_APP_SECRET);

      if (!isSignatureValid) {
        if (config.NODE_ENV === 'production') {
          logger.error(`Rejecting webhook: invalid or missing ${signatureHeaderName} in production`);
          throw new ForbiddenError('Invalid webhook signature');
        } else if (signatureHeader) {
          // If signature header was provided in dev/test, enforce validity
          logger.warn('Webhook signature mismatch in non-production environment');
          throw new ForbiddenError('Invalid webhook signature');
        } else {
          logger.warn(`Webhook accepted without ${signatureHeaderName} in development/test mode`);
        }
      }

      // Parse payload
      const events = isYCloud ? parseYCloudPayload(req.body) : parseWebhookPayload(req.body);
      const outbox = getOutboxService();

      for (const event of events) {
        if (event.type === 'text_message') {
          logger.info(
            {
              sender: event.senderPhoneNumber,
              messageId: event.providerMessageId,
            },
            'Enqueuing valid inbound WhatsApp text message'
          );
          await outbox.enqueueInboundMessage(event);
        } else if (event.type === 'unsupported_media') {
          logger.info(
            {
              sender: event.senderPhoneNumber,
              mediaType: event.mediaType,
              messageId: event.providerMessageId,
            },
            'Received unsupported media message'
          );
        } else if (event.type === 'status_update') {
          logger.debug(
            {
              recipient: event.recipientPhoneNumber,
              status: event.status,
              messageId: event.providerMessageId,
            },
            'Received WhatsApp message status update'
          );
          // Confirmed delivery / failure for reminders we sent. Must never fail the webhook ack.
          try {
            await getReminderService().recordProviderStatus(event);
          } catch (statusErr) {
            logger.error({ err: statusErr, messageId: event.providerMessageId }, 'Failed to apply WhatsApp status to reminder');
          }
        }
      }

      // Promptly acknowledge receipt to Meta
      res.status(200).json({ status: 'received' });
    } catch (err) {
      next(err);
    }
  }
}
