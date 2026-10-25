import { IPhoneOtpSender, PhoneOtpSendResult } from './phone-sender.interface';
import { logger } from '../../../utils/logger';

export class StubPhoneSender implements IPhoneOtpSender {
  public readonly providerName = 'stub-phone-sender';
  public sentOtps: Array<{ phoneNumber: string; otp: string; timestamp: Date }> = [];
  private failureError: Error | null = null;

  setSimulatedFailure(error: Error | null): void {
    this.failureError = error;
  }

  async sendOtp(
    phoneNumber: string,
    otp: string,
    _metadata?: Record<string, unknown>
  ): Promise<PhoneOtpSendResult> {
    if (this.failureError) {
      throw this.failureError;
    }

    logger.debug({ recipient: phoneNumber }, '[StubPhoneSender] Simulated OTP dispatch accepted');
    this.sentOtps.push({ phoneNumber, otp, timestamp: new Date() });

    return {
      status: 'accepted',
      channel: 'whatsapp',
      providerMessageId: `stub-wa-msg-${Date.now()}`,
      acceptedAt: new Date(),
    };
  }
}
