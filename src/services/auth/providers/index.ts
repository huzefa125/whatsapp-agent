import { IPhoneOtpSender } from './phone-sender.interface';
import { IEmailOtpSender } from './email-sender.interface';
import { WhatsAppPhoneSender } from './whatsapp-phone-sender';
import { StubPhoneSender } from './stub-phone-sender';
import { SmtpEmailSender } from './smtp-email-sender';
import { StubEmailSender } from './stub-email-sender';
import { getConfig } from '../../../config/env';

export * from './phone-sender.interface';
export * from './email-sender.interface';
export * from './whatsapp-phone-sender';
export * from './stub-phone-sender';
export * from './smtp-email-sender';
export * from './stub-email-sender';

let activePhoneSender: IPhoneOtpSender | null = null;
let activeEmailSender: IEmailOtpSender | null = null;

export function getPhoneOtpSender(): IPhoneOtpSender {
  if (!activePhoneSender) {
    const config = getConfig();
    if (config.NODE_ENV === 'test' || config.WHATSAPP_ACCESS_TOKEN.startsWith('meta_access_token_placeholder')) {
      activePhoneSender = new StubPhoneSender();
    } else {
      activePhoneSender = new WhatsAppPhoneSender();
    }
  }
  return activePhoneSender;
}

export function setPhoneOtpSenderForTesting(sender: IPhoneOtpSender | null): void {
  activePhoneSender = sender;
}

export function getEmailOtpSender(): IEmailOtpSender {
  if (!activeEmailSender) {
    const config = getConfig();
    if (config.EMAIL_PROVIDER === 'smtp') {
      activeEmailSender = new SmtpEmailSender();
    } else {
      activeEmailSender = new StubEmailSender();
    }
  }
  return activeEmailSender;
}

export function setEmailOtpSenderForTesting(sender: IEmailOtpSender | null): void {
  activeEmailSender = sender;
}
