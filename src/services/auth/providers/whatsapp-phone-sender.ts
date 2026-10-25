import { IPhoneOtpSender, PhoneOtpSendResult } from './phone-sender.interface';
import { getWhatsAppClient } from '../../whatsapp/client';
import { logger } from '../../../utils/logger';

export class WhatsAppPhoneSender implements IPhoneOtpSender {
  public readonly providerName = 'whatsapp-cloud-api';

  async sendOtp(
    phoneNumber: string,
    otp: string,
    _metadata?: Record<string, unknown>
  ): Promise<PhoneOtpSendResult> {
    const whatsapp = getWhatsAppClient();

    // Security: Do NOT log the OTP or private message content
    logger.info(
      { recipient: phoneNumber, provider: this.providerName },
      'Dispatching phone verification OTP via WhatsApp'
    );

    const messageText = `Your Instinct security verification code is: ${otp}\n\nThis code is valid for 10 minutes. For your security, do not share this code with anyone.`;

    const result = await whatsapp.sendTextMessage({
      to: phoneNumber,
      text: messageText,
    });

    return {
      status: 'accepted',
      channel: 'whatsapp',
      providerMessageId: result.providerMessageId,
      acceptedAt: new Date(),
    };
  }
}
