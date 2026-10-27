import { getConfig, type EnvConfig } from '../../config/env';
import { getWhatsAppClient } from '../whatsapp/client';
import { MockNotificationProvider } from './mock-provider';
import { NotificationProvider } from './types';
import { WhatsAppNotificationProvider } from './whatsapp-provider';

export * from './types';
export * from './mock-provider';
export * from './whatsapp-provider';

export function resolveProviderKind(config: EnvConfig): 'whatsapp' | 'mock' {
  return config.REMINDER_PROVIDER ?? (config.NODE_ENV === 'production' ? 'whatsapp' : 'mock');
}

let active: NotificationProvider | null = null;

export function getNotificationProvider(): NotificationProvider {
  if (!active) {
    const config = getConfig();
    active =
      resolveProviderKind(config) === 'whatsapp'
        ? new WhatsAppNotificationProvider(getWhatsAppClient())
        : new MockNotificationProvider();
  }
  return active;
}

export function setNotificationProviderForTesting(provider: NotificationProvider | null): void {
  active = provider;
}
