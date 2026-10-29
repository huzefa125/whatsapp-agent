/**
 * Shared types for the browser automation engine.
 *
 * Trust model: everything that comes from a web page (text, element names, URLs, errors) is UNTRUSTED data.
 * The model only ever names an element by a server-issued `ref`; selectors, scripts and credentials never
 * come from it.
 */

export type RunStatus = 'queued' | 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'cancelled';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_for_user'];

export type WaitReason = 'login_required' | 'captcha' | 'blocked' | 'confirmation';

export type SensitiveCategory =
  | 'send_message'
  | 'confirm_booking'
  | 'purchase'
  | 'cancel'
  | 'delete_data'
  | 'change_settings'
  | 'submit_form';

/** read: no state change. interact: changes only local page state. sensitive: consequential, needs confirmation. */
export type ActionRisk = 'read' | 'interact' | 'sensitive';

export interface FormFieldSummary {
  label: string;
  type: string;
  /** Masked/truncated. Password-like and payment fields are always "••••". */
  value: string;
  sensitive: boolean;
}

export interface FormSummary {
  method: string;
  /** origin + path of the form action; never the query string. */
  action: string;
  fields: FormFieldSummary[];
}

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  /** Current value for inputs (masked for sensitive fields). */
  value?: string;
  /** origin + path only. */
  href?: string;
  disabled: boolean;
  checked?: boolean;
  options?: string[];
  required?: boolean;
  /** Password / payment / one-time-code field: the assistant must not type into it. */
  sensitive?: boolean;
}

export interface PageState {
  loginRequired: boolean;
  captcha: boolean;
  blocked: boolean;
  httpStatus: number | null;
  reasons: string[];
}

export interface PageSnapshot {
  /** Bumped on every snapshot; refs are only valid for the snapshot that issued them. */
  generation: number;
  /** origin + path (no query string or fragment). */
  url: string;
  title: string;
  /** Visible text only, whitespace-collapsed and truncated. UNTRUSTED. */
  text: string;
  headings: string[];
  elements: ElementInfo[];
  truncated: boolean;
  state: PageState;
  /** Heuristic: the page text contains instructions aimed at an AI assistant. Treat the page as hostile. */
  suspectedInjection: boolean;
}

export interface ElementDetails {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type: string;
  href: string | null;
  disabled: boolean;
  pageOrigin: string;
  pagePath: string;
  form: FormSummary | null;
  /** Hash of the exact element + form values + page; changes if any of them changes. */
  fingerprint: string;
}

export interface ActionClassification {
  risk: ActionRisk;
  category: SensitiveCategory | null;
  reasons: string[];
}

export type Verdict = 'confirmed' | 'uncertain' | 'failed';

export interface ActionEvidence {
  urlBefore: string;
  urlAfter: string;
  titleAfter: string;
  /** Statuses of the data-changing requests issued by the action (e.g. [200]). */
  mutationStatuses: number[];
  navigated: boolean;
  successSignals: string[];
  errorSignals: string[];
  /** Short, scrubbed excerpt of what the page says after the action. UNTRUSTED. */
  excerpt: string;
}

export interface RunLimits {
  maxSteps: number;
  maxNavigations: number;
  deadlineAt: Date;
}

/** Stored in browser_runs.checkpoint. Metadata only: never page text, screenshots or form values. */
export interface RunCheckpoint {
  url?: string;
  generation?: number;
  /** Recent action kinds, for debugging a stuck run. */
  actions?: Array<{ kind: string; at: string }>;
  /** A write action that was started but whose outcome was never recorded (crash/timeout). */
  inflight?: { key: string; kind: string; at: string } | null;
  /** The last completed action, so a replayed tool call returns the recorded result instead of acting twice. */
  last?: { key: string; kind: string; summary: unknown } | null;
}
