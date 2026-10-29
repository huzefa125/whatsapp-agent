import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { clearedCookie, csrfTokenFor, parseCookies, safeEqual, serializeCookie, TokenBucket } from '../utils/handoff-token';
import { interstitialPage, messagePage, viewerPage } from '../services/browser/handoff/handoff-pages';
import { getHandoffService, HandoffError, type HandoffService, type HumanInput } from '../services/browser/handoff';
import type { BrowserHandoff } from '../db/schema';

/**
 * Public HTTP surface of the remote sign-in. Deliberately tiny and fixed:
 *   - no URL entry, no "open this address" endpoint: the browser starts on the approved site and can only follow
 *     that site's own links;
 *   - every response is no-store with a strict CSP;
 *   - authenticated by an opaque secret (link token once, then an HttpOnly cookie), never by ids in the URL;
 *   - nothing the user types is logged: bodies are never logged and errors never echo them.
 */

const COOKIE = 'hs';
const MAX_BODY_BYTES = 4096;

/** Per-IP limiter for the endpoints that take a link token (guessing / hammering). */
const ipBucket = new TokenBucket(20, 20 / 60);

export function resetHandoffLimitersForTesting(): void {
  (ipBucket as unknown as { buckets: Map<string, unknown> }).buckets.clear();
}

const inputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('key'), key: z.string().min(1).max(20) }).strict(),
  z.object({ type: z.literal('scroll'), dy: z.number().min(-2000).max(2000) }).strict(),
]);

/** Headers for every handoff response. The nonce lets this page's own inline script/style run and nothing else. */
function harden(res: Response, nonce: string): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src 'self' blob:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; ')
  );
}

const newNonce = () => crypto.randomBytes(16).toString('base64');

function page(res: Response, status: number, render: (nonce: string) => string): void {
  const nonce = newNonce();
  harden(res, nonce);
  res.status(status).type('html').send(render(nonce));
}

function json(res: Response, status: number, body: unknown): void {
  harden(res, newNonce());
  res.status(status).json(body);
}

const invalidLink = (res: Response) =>
  page(res, 404, (nonce) =>
    messagePage({ nonce, heading: 'Link not valid', text: 'This link is invalid, has already been used, or has expired. Ask your assistant on WhatsApp for a new one.', tone: 'bad' })
  );

const clientKey = (req: Request) => req.ip ?? 'unknown';
const isSecure = (service: HandoffService) => service.settings.baseUrl.startsWith('https://');

/** POSTs must come from our own pages: same-origin fetch metadata and Origin, when the browser sends them. */
function sameOrigin(req: Request, service: HandoffService): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return origin === new URL(service.settings.baseUrl).origin;
  } catch {
    return false;
  }
}

function sessionSecret(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[COOKIE];
}

export class HandoffController {
  /** 404 for everything when the feature is off, so the routes are not even discoverable. */
  static requireEnabled(_req: Request, res: Response, next: NextFunction): void {
    if (!getHandoffService()) {
      res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    next();
  }

  // --------------------------------------------------------------------------- link: view and redeem

  /** GET /handoff/:token. Describes the link; changes nothing, so chat link-previews cannot use it up. */
  static async preview(req: Request, res: Response): Promise<void> {
    const service = getHandoffService()!;
    if (!ipBucket.take(clientKey(req))) return void json(res, 429, { status: 'error', code: 'RATE_LIMITED' });
    const info = await service.preview(String(req.params['token'] ?? ''));
    if (!info) return invalidLink(res);
    page(res, 200, (nonce) => interstitialPage({ nonce, host: info.host, token: String(req.params['token']), reason: info.reason, minutes: info.minutes }));
  }

  /** POST /handoff/:token/start. Spends the single use and sets the session cookie. */
  static async start(req: Request, res: Response): Promise<void> {
    const service = getHandoffService()!;
    if (!ipBucket.take(clientKey(req), 2)) return void json(res, 429, { status: 'error', code: 'RATE_LIMITED' });
    if (!sameOrigin(req, service)) return void json(res, 403, { status: 'error', code: 'FORBIDDEN' });
    try {
      const { sessionSecret: secret, sessionExpiresAt } = await service.redeem(String(req.params['token'] ?? ''));
      res.setHeader(
        'Set-Cookie',
        serializeCookie(COOKIE, secret, {
          path: '/handoff',
          secure: isSecure(service),
          maxAgeSeconds: (sessionExpiresAt.getTime() - Date.now()) / 1000,
        })
      );
      harden(res, newNonce());
      res.redirect(303, '/handoff/session');
    } catch (err) {
      if (err instanceof HandoffError && err.code === 'START_FAILED') {
        return page(res, 503, (nonce) => messagePage({ nonce, heading: 'Could not open the sign-in page', text: 'Something went wrong. Ask your assistant on WhatsApp for a new link.', tone: 'bad' }));
      }
      invalidLink(res); // every other reason looks the same: unknown, used, expired, malformed
    }
  }

  // ------------------------------------------------------------------------------ the user's session

  /** Resolves the cookie to a handoff (any status). Null means "not authenticated". */
  private static async authenticate(req: Request): Promise<{ row: BrowserHandoff; secret: string } | null> {
    const service = getHandoffService()!;
    const secret = sessionSecret(req);
    const row = await service.lookup(secret);
    return row && secret ? { row, secret } : null;
  }

  /** Same, plus the anti-CSRF checks every state-changing request needs. */
  private static async authenticateWrite(req: Request, res: Response): Promise<{ row: BrowserHandoff } | null> {
    const service = getHandoffService()!;
    const auth = await HandoffController.authenticate(req);
    if (!auth) {
      json(res, 401, { status: 'error', code: 'UNAUTHORIZED' });
      return null;
    }
    const sent = req.header('x-csrf-token');
    if (!sameOrigin(req, service) || !sent || !safeEqual(sent, csrfTokenFor(auth.secret))) {
      json(res, 403, { status: 'error', code: 'FORBIDDEN' });
      return null;
    }
    return { row: auth.row };
  }

  /** GET /handoff/session */
  static async viewer(req: Request, res: Response): Promise<void> {
    const auth = await HandoffController.authenticate(req);
    if (!auth) return invalidLink(res);
    const service = getHandoffService()!;
    const view = service.statusOf(auth.row);
    if (view.state !== 'waiting_for_login') {
      return page(res, 200, (nonce) => messagePage({ nonce, heading: view.label, text: endedText(view.state), tone: view.state === 'connected' ? 'ok' : 'bad' }));
    }
    page(res, 200, (nonce) => viewerPage({ nonce, host: view.host, csrf: csrfTokenFor(auth.secret), reason: view.reason }));
  }

  /** GET /handoff/session/status */
  static async status(req: Request, res: Response): Promise<void> {
    const auth = await HandoffController.authenticate(req);
    if (!auth) return void json(res, 401, { status: 'error', code: 'UNAUTHORIZED' });
    json(res, 200, getHandoffService()!.statusOf(auth.row));
  }

  /** GET /handoff/session/frame */
  static async frame(req: Request, res: Response): Promise<void> {
    const service = getHandoffService()!;
    const auth = await HandoffController.authenticate(req);
    if (!auth) return void json(res, 401, { status: 'error', code: 'UNAUTHORIZED' });
    if (!service.allowFrame(auth.row.id)) return void json(res, 429, { status: 'error', code: 'RATE_LIMITED' });
    try {
      const image = await service.frame(auth.row);
      harden(res, newNonce());
      res.status(200).type('image/jpeg').send(image);
    } catch (err) {
      if (err instanceof HandoffError) return void json(res, 410, { status: 'error', code: err.code });
      logger.warn({ handoffId: auth.row.id }, 'Could not capture a handoff frame');
      json(res, 500, { status: 'error', code: 'FRAME_FAILED' });
    }
  }

  /** POST /handoff/session/input */
  static async input(req: Request, res: Response): Promise<void> {
    const service = getHandoffService()!;
    const auth = await HandoffController.authenticateWrite(req, res);
    if (!auth) return;
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) return void json(res, 413, { status: 'error', code: 'TOO_LARGE' });
    if (!service.allowInput(auth.row.id)) return void json(res, 429, { status: 'error', code: 'RATE_LIMITED' });
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return void json(res, 400, { status: 'error', code: 'INVALID_INPUT' }); // never echo the body back
    try {
      await service.input(auth.row, parsed.data as HumanInput);
      json(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof HandoffError) return void json(res, err.code === 'NOT_ACTIVE' ? 410 : 400, { status: 'error', code: err.code });
      json(res, 500, { status: 'error', code: 'INPUT_FAILED' });
    }
  }

  /** POST /handoff/session/complete */
  static async complete(req: Request, res: Response): Promise<void> {
    const auth = await HandoffController.authenticateWrite(req, res);
    if (!auth) return;
    const result = await getHandoffService()!.complete(auth.row);
    if (result.ok) return void json(res, 200, { ok: true });
    json(res, result.code === 'NOT_ACTIVE' ? 410 : 409, { ok: false, code: result.code, message: result.message });
  }

  /** POST /handoff/session/cancel */
  static async cancel(req: Request, res: Response): Promise<void> {
    const auth = await HandoffController.authenticateWrite(req, res);
    if (!auth) return;
    await getHandoffService()!.cancelFromViewer(auth.row);
    const service = getHandoffService()!;
    res.setHeader('Set-Cookie', clearedCookie(COOKIE, { path: '/handoff', secure: isSecure(service) }));
    json(res, 200, { ok: true });
  }
}

function endedText(state: string): string {
  switch (state) {
    case 'connected':
      return 'You are connected. You can close this page and go back to WhatsApp.';
    case 'expired':
      return 'This sign-in expired. Ask your assistant on WhatsApp for a new link.';
    case 'cancelled':
      return 'This sign-in was cancelled.';
    default:
      return 'Something went wrong. Ask your assistant on WhatsApp for a new link.';
  }
}

