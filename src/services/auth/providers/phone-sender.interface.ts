export interface PhoneOtpSendResult {
  status: 'accepted';
  channel: 'whatsapp';
  providerMessageId?: string;
  acceptedAt: Date;
}

export interface IPhoneOtpSender {
  readonly providerName: string;
  sendOtp(
    phoneNumber: string,
    otp: string,
    metadata?: Record<string, unknown>
  ): Promise<PhoneOtpSendResult>;
}
