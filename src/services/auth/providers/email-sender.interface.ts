export interface EmailOtpSendResult {
  status: 'accepted';
  channel: 'email';
  providerMessageId?: string;
  acceptedAt: Date;
}

export interface IEmailOtpSender {
  readonly providerName: string;
  sendOtp(
    email: string,
    otp: string,
    metadata?: Record<string, unknown>
  ): Promise<EmailOtpSendResult>;
}
