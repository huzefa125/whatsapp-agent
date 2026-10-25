import nodemailer, { Transporter } from 'nodemailer';
import { IEmailOtpSender, EmailOtpSendResult } from './email-sender.interface';
import { getConfig } from '../../../config/env';
import { ExternalServiceError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';

export class SmtpEmailSender implements IEmailOtpSender {
  public readonly providerName = 'smtp-email-sender';
  private transporter: Transporter;
  private fromAddress: string;

  constructor() {
    const config = getConfig();

    if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
      throw new ExternalServiceError('SMTP Email', 'SMTP configuration is incomplete (host, user, or pass missing)');
    }

    this.fromAddress = config.SMTP_FROM || 'noreply@instinct-agent.local';
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }

  async sendOtp(
    email: string,
    otp: string,
    _metadata?: Record<string, unknown>
  ): Promise<EmailOtpSendResult> {
    logger.info(
      { recipient: email, provider: this.providerName },
      'Dispatching email verification OTP via SMTP'
    );

    try {
      const info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: email,
        subject: 'Your Instinct Verification Code',
        text: `Your Instinct security verification code is: ${otp}\n\nThis code is valid for 10 minutes. For your security, do not share this code with anyone.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2D3748;">Instinct Verification Code</h2>
            <p>Use the code below to complete your authentication challenge:</p>
            <div style="background-color: #EDF2F7; padding: 15px; border-radius: 6px; font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #1A202C;">
              ${otp}
            </div>
            <p style="color: #718096; font-size: 13px; margin-top: 20px;">This code is valid for 10 minutes. If you did not request this, please disregard this email.</p>
          </div>
        `,
      });

      return {
        status: 'accepted',
        channel: 'email',
        providerMessageId: info.messageId,
        acceptedAt: new Date(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message, recipient: email }, 'Failed to dispatch email verification OTP');
      throw new ExternalServiceError('SMTP Email', message);
    }
  }
}
