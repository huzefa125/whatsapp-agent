import type { ToolDefinition } from '../agent/engine/types';
import type { IntegrationCapability, IntegrationProvider } from './types';

const KIND_ORDER: Record<IntegrationProvider['kind'], number> = { api: 0, browser: 1 };

/** Holds the available providers and answers "who should do this?", always preferring official APIs. */
export class IntegrationRegistry {
  private readonly providers = new Map<string, IntegrationProvider>();

  register(provider: IntegrationProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Integration "${provider.id}" is already registered`);
    if (!provider.capabilities.length) throw new Error(`Integration "${provider.id}" must declare capabilities`);
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): IntegrationProvider | undefined {
    return this.providers.get(id);
  }

  list(): IntegrationProvider[] {
    return [...this.providers.values()];
  }

  /** Providers able to do `capability`, official APIs first and the browser last. */
  forCapability(capability: IntegrationCapability): IntegrationProvider[] {
    return this.list()
      .filter((p) => p.capabilities.includes(capability))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  }

  /** The provider for a site: an API provider that claims the host, otherwise the browser fallback if present. */
  resolveForHost(host: string): IntegrationProvider | undefined {
    const api = this.list().find((p) => p.kind === 'api' && p.handlesHost?.(host));
    return api ?? this.list().find((p) => p.kind === 'browser');
  }

  allTools(): Array<ToolDefinition<any, any>> {
    return this.list().flatMap((p) => p.tools());
  }
}
