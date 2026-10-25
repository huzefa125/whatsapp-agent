import { IEmailOtpSender, EmailOtpSendResult } from './email-sender.interface';
import { logger } from '../../../utils/logger';

export class StubEmailSender implements IEmailOtpSender {
  public readonly providerName = 'stub-email-sender';
  public sentOtps: Array<{ email: string; otp: string; timestamp: Date }> = [];
  private failureError: Error | null = null;

  setSimulatedFailure(error: Error | null): void {
    this.failureError = error;
  }

  async sendOtp(
    email: string,
    otp: string,
    _metadata?: Record<string, unknown>
  ): Promise<EmailOtpSendResult> {
    if (this.failureError) {
      throw this.failureError;
    }

    logger.debug({ recipient: email }, '[StubEmailSender] Simulated email OTP dispatch accepted');
    this.sentOtps.push({ email, otp, timestamp: new Date() });

    return {
      status: 'accepted',
      channel: 'email',
      providerMessageId: `stub-email-msg-${Date.now()}`,
      acceptedAt: new Date(),
    };
  }
}
