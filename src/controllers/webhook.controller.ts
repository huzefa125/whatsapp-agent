import { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/env';
import { verifyWebhookChallenge, verifyWebhookSignature, parseWebhookPayload } from '../services/whatsapp/webhook';
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
      const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

      // Signature verification
      const isSignatureValid = verifyWebhookSignature(
        rawBody,
        signatureHeader,
        config.WHATSAPP_APP_SECRET
      );

      if (!isSignatureValid) {
        if (config.NODE_ENV === 'production') {
          logger.error('Rejecting webhook: invalid or missing X-Hub-Signature-256 in production');
          throw new ForbiddenError('Invalid webhook signature');
        } else if (signatureHeader) {
          // If signature header was provided in dev/test, enforce validity
          logger.warn('Webhook signature mismatch in non-production environment');
          throw new ForbiddenError('Invalid webhook signature');
        } else {
          logger.warn('Webhook accepted without X-Hub-Signature-256 in development/test mode');
        }
      }

      // Parse payload
      const events = parseWebhookPayload(req.body);
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
