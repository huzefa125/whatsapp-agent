import crypto from 'crypto';
import type { ActionClassification, ElementDetails, FormSummary, SensitiveCategory } from './types';

/**
 * Pure functions that decide how risky a browser action is. They run on trusted server code against what the
 * element ACTUALLY is at execution time, not against anything the model claimed.
 *
 * Keyword matching is a best-effort first line; the network-level mutation guard in the session is the backstop
 * that stops a mislabelled button from submitting anything without a confirmed action.
 */

const CATEGORY_PATTERNS: Array<[SensitiveCategory, RegExp]> = [
  ['purchase', /\b(buy|purchase|pay(ment)?|place (your )?order|checkout|complete (the )?order|order now|add (a )?payment|subscribe|upgrade|donate|transfer|top ?up)\b/i],
  ['cancel', /\b(cancel|unsubscribe|terminate|close (my )?account|end (my )?subscription|refund)\b/i],
  ['delete_data', /\b(delete|remove|erase|discard|clear all|deactivate|trash|wipe)\b/i],
  ['confirm_booking', /\b(book( now)?|reserve|confirm (the |my )?(booking|reservation|appointment|meeting|ticket)|schedule|rsvp|accept (the )?invit)/i],
  ['send_message', /\b(send|reply|forward|post( comment)?|publish|share|tweet)\b/i],
  ['change_settings', /\b(save (my )?settings|change (my )?(email|password|username|settings|plan)|update (my )?(profile|settings|email|password)|enable|disable|two[- ]factor|2fa|connect account|link account|authorize|grant access)\b/i],
  ['submit_form', /\b(submit|apply( now)?|register|sign ?up|create (an )?account|save changes|confirm|finish|complete)\b/i],
];

/** Path fragments that make a plain GET link state-changing in practice. */
const SENSITIVE_PATH = /\/(cancel|delete|remove|unsubscribe|checkout|confirm|purchase|pay|logout|deactivate)\b/i;

export function categoryFromText(text: string): SensitiveCategory | null {
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

export function classifyClick(d: ElementDetails): ActionClassification {
  const reasons: string[] = [];
  const textCategory = categoryFromText(d.name);
  const hrefPath = d.href ? safePath(d.href) : '';
  const pathSensitive = d.href !== null && SENSITIVE_PATH.test(hrefPath);

  const inForm = d.form !== null;
  const formPosts = inForm && d.form!.method !== 'get';
  // Only a control inside a form submits it; a lone <button> (default type "submit") does nothing by itself.
  const isSubmitControl =
    inForm && (d.type === 'submit' || d.type === 'image' || (d.tag === 'button' && d.type !== 'button' && d.type !== 'reset'));

  if (isSubmitControl && formPosts) {
    reasons.push('submits a form that sends data');
    return { risk: 'sensitive', category: textCategory ?? 'submit_form', reasons };
  }
  if (textCategory) {
    reasons.push(`label suggests a consequential action (${textCategory})`);
    return { risk: 'sensitive', category: textCategory, reasons };
  }
  if (pathSensitive) {
    reasons.push('link target looks like a state-changing page');
    return { risk: 'sensitive', category: categoryFromText(hrefPath.replace(/[/_-]/g, ' ')) ?? 'submit_form', reasons };
  }
  if (isSubmitControl) {
    reasons.push('submits a search or lookup form');
    return { risk: 'interact', category: null, reasons };
  }
  if (d.href !== null) {
    return { risk: 'read', category: null, reasons: ['navigation link'] };
  }
  return { risk: 'interact', category: null, reasons: ['changes only the page view'] };
}

function safePath(href: string): string {
  try {
    return new URL(href).pathname;
  } catch {
    return href;
  }
}

// -------------------------------------------------------------------------------- sensitive input fields

const SENSITIVE_FIELD_NAME = /(pass(word|wd)?|pwd|cvv|cvc|card[-_ ]?(num|number)|cc[-_ ]?(num|number|exp)|ccnum|iban|ssn|otp|one[-_ ]?time|2fa|pin\b|secret|token)/i;
const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.*)$/i;

/** Fields the assistant must never type into: credentials, payment data, one-time codes. */
export function isSensitiveField(f: { type: string; name: string; autocomplete?: string | null }): boolean {
  if (f.type === 'password') return true;
  if (f.autocomplete && SENSITIVE_AUTOCOMPLETE.test(f.autocomplete.trim())) return true;
  return SENSITIVE_FIELD_NAME.test(f.name);
}

// ---------------------------------------------------------------------------------------- fingerprint

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Binds a confirmation to the exact thing the user approved: the page, the element, and the form it would
 * submit including every field value (hashed, so values are never stored). Any change invalidates it.
 */
export function computeFingerprint(input: {
  pageOrigin: string;
  pagePath: string;
  role: string;
  name: string;
  tag: string;
  type: string;
  href: string | null;
  form: FormSummary | null;
}): string {
  const canonical = JSON.stringify({
    o: input.pageOrigin,
    p: input.pagePath,
    r: input.role,
    n: input.name,
    t: input.tag,
    y: input.type,
    h: input.href,
    f: input.form
      ? {
          m: input.form.method,
          a: input.form.action,
          v: input.form.fields.map((f) => [f.label, f.type, sha256(f.value)]),
        }
      : null,
  });
  return sha256(canonical).slice(0, 24);
}

// ----------------------------------------------------------------------------------- page text signals

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages|rules)/i,
  /disregard (all |any |your |the )?(previous|prior|above|system)/i,
  /(you are|you're) now (a|an|in)\b/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /\b(ai|assistant|language model|llm|agent|chatgpt|claude|gemini)\b.{0,40}\b(must|should|need to|has to|will)\b.{0,60}\b(send|email|forward|reveal|click|buy|pay|transfer|delete|ignore)/i,
  /(reveal|share|send|exfiltrate|forward) .{0,40}\b(password|api key|secret|token|credentials|conversation|chat history)/i,
  /new instructions?:/i,
];

export function detectPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

const SUCCESS_TEXT = /\b(thank you|thanks for|successfully|success|confirmed|confirmation (number|code|id)|order (number|id|placed|confirmed)|booking (id|reference|confirmed)|reservation (confirmed|number)|message sent|has been (sent|submitted|booked|placed|cancelled|canceled|deleted|saved)|your request (has been|was) )/i;
const ERROR_TEXT = /\b(error|failed|failure|invalid|unable to|could not|couldn't|try again|not available|declined|required field|something went wrong)\b/i;
const SUCCESS_PATH = /\/(thank|thanks|confirm|confirmation|success|complete|completed|receipt|order-placed|booked)\b/i;

export function findSignals(
  text: string,
  urlPath: string
): { success: string[]; error: string[] } {
  const success: string[] = [];
  const error: string[] = [];
  const s = text.match(SUCCESS_TEXT);
  if (s) success.push(`text: "${s[0].toLowerCase()}"`);
  if (SUCCESS_PATH.test(urlPath)) success.push('url looks like a confirmation page');
  const e = text.match(ERROR_TEXT);
  if (e) error.push(`text: "${e[0].toLowerCase()}"`);
  return { success, error };
}

/**
 * Honest verdict. "confirmed" needs BOTH proof the data-changing request was accepted AND a visible success
 * signal. Anything weaker is "uncertain", and the assistant must verify before retrying or claiming success.
 */
export function decideVerdict(input: {
  mutationStatuses: number[];
  successSignals: string[];
  errorSignals: string[];
  navigated: boolean;
}): 'confirmed' | 'uncertain' | 'failed' {
  const { mutationStatuses, successSignals, errorSignals } = input;
  if (mutationStatuses.some((s) => s >= 400)) return 'failed';
  const accepted = mutationStatuses.length > 0 && mutationStatuses.every((s) => s < 400);
  if (accepted && successSignals.length > 0 && errorSignals.length === 0) return 'confirmed';
  if (mutationStatuses.length === 0 && errorSignals.length > 0 && successSignals.length === 0) return 'failed';
  return 'uncertain';
}

/** A URL whose path looks state-changing (cancel, delete, checkout...). Navigating straight to it needs confirmation. */
export function isSensitiveUrl(raw: string): boolean {
  try {
    return SENSITIVE_PATH.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}
