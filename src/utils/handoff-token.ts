import crypto from 'crypto';

/**
 * Primitives for the remote-browser handoff. A handoff link carries an opaque, random bearer token. The database
 * keeps only its SHA-256 hash, so a database leak cannot be turned back into working links. Tokens are 256-bit
 * random values, so a fast hash is appropriate (there is nothing to brute-force; slow KDFs are for human passwords).
 */

const TOKEN_BYTES = 32;
/** 32 random bytes in base64url is always exactly 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check so malformed input never reaches the database. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Anti-CSRF value derived from the session secret, so no extra state has to be stored. */
export function csrfTokenFor(sessionSecret: string): string {
  return crypto.createHmac('sha256', sessionSecret).update('handoff-csrf-v1').digest('base64url');
}

// ------------------------------------------------------------------------------------------------ cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    const value = part.slice(i + 1).trim();
    if (!(name in out)) out[name] = value; // first one wins; never let a later duplicate override
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds: number; path: string; secure: boolean }
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('cookie value must be base64url');
  return [
    `${name}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookie(name: string, opts: { path: string; secure: boolean }): string {
  return serializeCookie(name, 'x', { maxAgeSeconds: 0, path: opts.path, secure: opts.secure });
}

// ---------------------------------------------------------------------------------------------- rate limit

/** In-memory token bucket per key. Counters live in this process (the remote browser is in this process too). */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now
  ) {}

  take(key: string, cost = 1): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSecond);
    b.at = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.prune(t);
    return ok;
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  private prune(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.at > 60_000) this.buckets.delete(k);
  }
}
