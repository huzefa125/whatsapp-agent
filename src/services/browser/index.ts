import { getConfig } from '../../config/env';
import { BrowserService, browserSettingsFromEnv } from './browser-service';

export * from './browser-service';
export * from './browser-tools';
export * from './connection-service';
export * from './policy';
export * from './redact';
export * from './risk';
export * from './run-repository';
export * from './session';
export * from './session-manager';
export * from './types';

let instance: BrowserService | null = null;

export function isBrowserEnabled(): boolean {
  return getConfig().BROWSER_ENABLED;
}

export function getBrowserService(): BrowserService {
  if (!instance) instance = new BrowserService(browserSettingsFromEnv());
  return instance;
}

export function setBrowserServiceForTesting(service: BrowserService | null): void {
  instance = service;
}
