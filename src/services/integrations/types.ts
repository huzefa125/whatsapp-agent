import type { ToolDefinition } from '../agent/engine/types';

/**
 * Provider-neutral contract for anything the assistant can use on a user's behalf: an official API integration
 * (Gmail, Google Calendar, Zoom, Calendly, a CRM...) or the generic browser fallback. Later phases add providers;
 * the agent and the safety rules (permissions, confirmation of consequential actions) do not change.
 *
 * Rule of thumb enforced by the registry: an official API provider is always preferred over the browser, and the
 * browser is the fallback for sites that have no approved API or that the user has not connected through one.
 */
export type IntegrationKind = 'api' | 'browser';

export type IntegrationCapability = 'email' | 'calendar' | 'meetings' | 'booking' | 'travel' | 'crm' | 'forms' | 'web';

export interface IntegrationStatus {
  state: 'connected' | 'not_connected' | 'expired';
  /** Human-readable accounts/sites that are connected. Never credentials or tokens. */
  accounts: string[];
}

export interface IntegrationProvider {
  /** Stable id, e.g. "gmail", "google_calendar", "browser.web". */
  readonly id: string;
  readonly kind: IntegrationKind;
  readonly displayName: string;
  readonly capabilities: readonly IntegrationCapability[];
  /** API providers claim the hosts of their service so a URL can be routed to them instead of the browser. */
  handlesHost?(host: string): boolean;
  status(userId: string): Promise<IntegrationStatus>;
  /** Revokes and deletes whatever this provider stored for the user (tokens, sessions). */
  disconnect(userId: string): Promise<void>;
  /** Agent tools this provider contributes. Consequential tools must set requiresConfirmation / shouldConfirm. */
  tools(): Array<ToolDefinition<any, any>>;
}
