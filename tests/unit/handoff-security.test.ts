import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import pino from 'pino';
import request from 'supertest';
import {
  clearedCookie,
  csrfTokenFor,
  generateToken,
  hashToken,
  isWellFormedToken,
  parseCookies,
  safeEqual,
  serializeCookie,
  TokenBucket,
} from '../../src/utils/handoff-token';
import { redactPath } from '../../src/utils/redact-path';
import { createHttpLogger } from '../../src/middleware/logging';
import { escapeHtml, interstitialPage, messagePage, viewerPage } from '../../src/services/browser/handoff/handoff-pages';
import { userFacingState } from '../../src/services/browser/handoff/handoff-service';
import { validateEnv } from '../../src/config/env';

describe('handoff tokens: entropy and hashing', () => {
  it('generates 256-bit URL-safe tokens of fixed shape', () => {
    for (let i = 0; i < 50; i++) {
      const t = generateToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t, 'base64url')).toHaveLength(32);
      expect(isWellFormedToken(t)).toBe(true);
    }
  });

  it('never repeats and looks uniformly random', () => {
    const N = 4000;
    const tokens = new Set<string>();
    const byteCounts = new Array<number>(256).fill(0);
    for (let i = 0; i < N; i++) {
      const t = generateToken();
      tokens.add(t);
      for (const b of Buffer.from(t, 'base64url')) byteCounts[b]!++;
    }
    expect(tokens.size).toBe(N); // no collisions
    // Chi-square on byte frequencies: a biased generator (e.g. Math.random or a counter) fails this badly.
    const expected = (N * 32) / 256;
    const chi = byteCounts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(330); // df=255, p~0.001 is ~330
    expect(chi).toBeGreaterThan(180); // and not suspiciously uniform either
  });

  it('stores only a SHA-256 hash that cannot reveal the token', () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(crypto.createHash('sha256').update(t).digest('hex'));
    expect(h).not.toContain(t.slice(0, 8));
    expect(hashToken(t)).toBe(h); // deterministic (indexed lookup)
    expect(hashToken(generateToken())).not.toBe(h);
  });

  it.each(['', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, `${'a'.repeat(42)}=`, '../../etc/passwd', 'session'])(
    'rejects malformed token %j before it can reach the database',
    (t) => {
      expect(isWellFormedToken(t)).toBe(false);
    }
  );

  it('rejects non-strings', () => {
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken(123 as unknown)).toBe(false);
    expect(isWellFormedToken({ toString: () => 'a'.repeat(43) } as unknown)).toBe(false);
  });

  it('compares secrets in constant time and rejects length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('CSRF token', () => {
  it('is derived from the session secret: stable per session, different per session', () => {
    const a = generateToken();
    const b = generateToken();
    expect(csrfTokenFor(a)).toBe(csrfTokenFor(a));
    expect(csrfTokenFor(a)).not.toBe(csrfTokenFor(b));
    expect(csrfTokenFor(a)).not.toContain(a.slice(0, 10));
  });
});

describe('cookies', () => {
  it('sets HttpOnly, SameSite=Strict, scoped path and a lifetime; Secure on https', () => {
    const c = serializeCookie('hs', generateToken(), { path: '/handoff', maxAgeSeconds: 599.9, secure: true });
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/handoff');
    expect(c).toContain('Max-Age=599');
    expect(serializeCookie('hs', 'abc', { path: '/handoff', maxAgeSeconds: 5, secure: false })).not.toContain('Secure');
  });

  it('refuses values that could break out of the header', () => {
    for (const bad of ['a;b', 'a b', 'a\r\nSet-Cookie: x=1', 'a=b', '']) {
      expect(() => serializeCookie('hs', bad, { path: '/', maxAgeSeconds: 1, secure: false })).toThrow();
    }
  });

  it('expires a cookie on clear', () => {
    expect(clearedCookie('hs', { path: '/handoff', secure: true })).toContain('Max-Age=0');
  });

  it('parses cookie headers and ignores later duplicates of the same name', () => {
    expect(parseCookies('a=1; hs=first; b=2; hs=second')).toEqual({ a: '1', hs: 'first', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('garbage; =x; y')).toEqual({});
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills at the configured rate, per key', () => {
    let now = 0;
    const b = new TokenBucket(3, 1, () => now);
    expect([b.take('a'), b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, true, false]);
    expect(b.take('other')).toBe(true); // keys are independent
    now += 2000;
    expect([b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, false]);
    now += 60_000;
    expect(b.take('a', 3)).toBe(true); // capped at capacity
    expect(b.take('a')).toBe(false);
  });

  it('can forget a key', () => {
    const b = new TokenBucket(1, 0);
    expect(b.take('k')).toBe(true);
    expect(b.take('k')).toBe(false);
    b.forget('k');
    expect(b.take('k')).toBe(true);
  });
});

describe('request path redaction', () => {
  const token = generateToken();
  it('removes the token and the query from handoff URLs', () => {
    expect(redactPath(`/handoff/${token}`)).toBe('/handoff/[token]');
    expect(redactPath(`/handoff/${token}/start`)).toBe('/handoff/[token]/start');
    expect(redactPath(`/handoff/${token}?utm=abc&x=secret`)).toBe('/handoff/[token]');
  });
  it('keeps the session routes readable and leaves other paths alone', () => {
    expect(redactPath('/handoff/session/frame?_=123')).toBe('/handoff/session/frame');
    expect(redactPath('/api/agent/tasks?limit=5')).toBe('/api/agent/tasks?limit=5');
    expect(redactPath(undefined)).toBe('');
  });

  it('keeps tokens, cookies and CSRF headers out of the real HTTP log output', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (chunk: string) => void lines.push(chunk) });
    const app = express();
    app.use(createHttpLogger(log as never));
    app.get('/handoff/:token', (_req, res) => res.status(404).send('no'));
    app.post('/handoff/session/input', (_req, res) => res.status(200).send('ok'));

    const sessionSecret = generateToken();
    await request(app).get(`/handoff/${token}?x=queryvalue`).set('Cookie', `hs=${sessionSecret}`);
    await request(app).post('/handoff/session/input').set('Cookie', `hs=${sessionSecret}`).set('X-CSRF-Token', 'csrf-secret-value').send({ type: 'type', text: 'MyPassword123' });

    const out = lines.join('');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(token);
    expect(out).not.toContain(sessionSecret);
    expect(out).not.toContain('csrf-secret-value');
    expect(out).not.toContain('queryvalue');
    expect(out).not.toContain('MyPassword123');
    expect(out).toContain('/handoff/[token]');
  });
});

describe('handoff pages', () => {
  const nonce = 'abc123';

  it('escapes every dynamic value (host, token, headings)', () => {
    const evil = '"><script>alert(1)</script>';
    for (const html of [
      interstitialPage({ nonce, host: evil, token: evil, reason: evil, minutes: 5 }),
      viewerPage({ nonce, host: evil, csrf: evil, reason: evil }),
      messagePage({ nonce, heading: evil, text: evil }),
    ]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    }
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('uses only nonce-protected inline code and no external resources', () => {
    const html = viewerPage({ nonce, host: 'example.com', csrf: 'c', reason: 'login' });
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\/(?!example\.com)/); // no third-party URLs
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });

  it('does not put the session secret in the viewer page (only a derived CSRF value)', () => {
    const secret = generateToken();
    const html = viewerPage({ nonce, host: 'example.com', csrf: csrfTokenFor(secret), reason: 'login' });
    expect(html).not.toContain(secret);
  });

  it('shows only the five user-facing states', () => {
    expect(userFacingState('pending')).toBe('waiting_for_login');
    expect(userFacingState('active')).toBe('waiting_for_login');
    expect(userFacingState('completed')).toBe('connected');
    expect(userFacingState('expired')).toBe('expired');
    expect(userFacingState('cancelled')).toBe('cancelled');
    expect(userFacingState('failed')).toBe('failed');
  });
});

describe('production configuration guards', () => {
  const prod = {
    NODE_ENV: 'production',
    WHATSAPP_VERIFY_TOKEN: 'x', WHATSAPP_APP_SECRET: 'real-secret', WHATSAPP_ACCESS_TOKEN: 'real-token', WHATSAPP_PHONE_NUMBER_ID: '1',
    AI_PROVIDER: 'stub', REMINDER_PROVIDER: 'whatsapp', AUTH_OTP_HMAC_SECRET: 'a-secure-secret-that-is-at-least-32-chars-long',
  };

  it('requires browser automation, an https public URL and an encryption key for handoff in production', () => {
    expect(() => validateEnv({ ...prod, BROWSER_HANDOFF_ENABLED: 'true' })).toThrow(/BROWSER_ENABLED/);
    expect(() => validateEnv({ ...prod, BROWSER_ENABLED: 'true', BROWSER_HANDOFF_ENABLED: 'true', PUBLIC_BASE_URL: 'http://x.example' })).toThrow(/https/);
    expect(() => validateEnv({ ...prod, BROWSER_ENABLED: 'true', BROWSER_HANDOFF_ENABLED: 'true', PUBLIC_BASE_URL: 'https://x.example' })).toThrow(/ENCRYPTION_KEY/);
    expect(
      validateEnv({ ...prod, BROWSER_ENABLED: 'true', BROWSER_HANDOFF_ENABLED: 'true', PUBLIC_BASE_URL: 'https://x.example', BROWSER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }).BROWSER_HANDOFF_ENABLED
    ).toBe(true);
  });

  it('is off by default and bounds its timers', () => {
    const c = validateEnv({ NODE_ENV: 'development', WHATSAPP_VERIFY_TOKEN: 'x', WHATSAPP_APP_SECRET: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: '1' });
    expect(c.BROWSER_HANDOFF_ENABLED).toBe(false);
    expect(c.BROWSER_HANDOFF_LINK_TTL_MINUTES).toBe(10);
    expect(() => validateEnv({ NODE_ENV: 'development', WHATSAPP_VERIFY_TOKEN: 'x', WHATSAPP_APP_SECRET: 'x', WHATSAPP_ACCESS_TOKEN: 'x', WHATSAPP_PHONE_NUMBER_ID: '1', BROWSER_HANDOFF_LINK_TTL_MINUTES: '600' })).toThrow();
  });
});
