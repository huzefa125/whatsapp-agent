import { getConfig } from '../../config/env';
import { IntegrationRegistry } from './registry';

export * from './types';
export * from './registry';

let registry: IntegrationRegistry | null = null;

/** All enabled integrations. Future phases register their API providers here, next to the browser fallback. */
export function getIntegrations(): IntegrationRegistry {
  if (!registry) {
    registry = new IntegrationRegistry();
    if (getConfig().BROWSER_ENABLED) {
      // Loaded lazily so the browser stack costs nothing when the feature is off.
      const { getBrowserService } = require('../browser') as typeof import('../browser');
      const { BrowserIntegrationProvider } = require('./browser-provider') as typeof import('./browser-provider');
      registry.register(new BrowserIntegrationProvider(getBrowserService()));
    }
  }
  return registry;
}

export function setIntegrationsForTesting(r: IntegrationRegistry | null): void {
  registry = r;
}
