import { getConfig } from '../../../config/env';
import { getBrowserService } from '../index';
import { HandoffService, handoffSettingsFromEnv } from './handoff-service';

export * from './handoff-repository';
export * from './handoff-service';
export * from './handoff-notifier';

let instance: HandoffService | null = null;

/** The handoff service, or null when the feature is off (routes then answer 404). */
export function getHandoffService(): HandoffService | null {
  if (instance) return instance;
  const config = getConfig();
  if (!config.BROWSER_ENABLED || !config.BROWSER_HANDOFF_ENABLED) return null;
  instance = new HandoffService({ settings: handoffSettingsFromEnv(), browser: getBrowserService() });
  return instance;
}

export function setHandoffServiceForTesting(service: HandoffService | null): void {
  instance = service;
}
