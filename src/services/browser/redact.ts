import { scrubText, truncate } from '../agent/engine/sanitize';

/**
 * Redaction helpers. Rule for this whole module: URLs are logged and stored as origin + path ONLY (query strings
 * and fragments routinely carry tokens), and free text from pages or from Playwright errors is scrubbed first.
 */

/** origin + path. Returns "" for anything that is not a parseable URL. */
export function redactUrl(raw: string, maxChars = 300): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return truncate(`${u.origin}${u.pathname}`, maxChars);
  } catch {
    return '';
  }
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/gi;
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|auth|authorization|cookie|session|otp|pin|cvv|cvc)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/g;

/** Scrubs free text for logs/model output: URLs lose their query, secrets and long tokens are masked. */
export function redactText(text: string, maxChars = 500): string {
  const cleaned = scrubText(text)
    .replace(URL_IN_TEXT, (m) => redactUrl(m) || '[url]')
    .replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]')
    .replace(CARD_NUMBER, '[REDACTED]')
    .replace(LONG_TOKEN, '[REDACTED]');
  return truncate(cleaned, maxChars);
}

/** A loggable description of an error: never the raw Playwright message (it can embed URLs, selectors and values). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const firstLine = err.message.split('\n')[0] ?? '';
    return `${err.name}: ${redactText(firstLine, 200)}`;
  }
  return 'Unknown error';
}
