import type { Request, Response } from 'express';
import { getGmailOAuth } from '../services/gmail';
import { logger } from '../utils/logger';

/**
 * Handles the Google OAuth 2.0 callback.
 * GET /api/gmail/oauth/callback?state=...&code=...
 *
 * Google redirects here after user consents. We validate the state (CSRF/PKCE),
 * exchange the auth code for tokens, and store the encrypted refresh token.
 */
export async function gmailOAuthCallbackController(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { state, code, error } = req.query;

    if (error) {
      logger.warn({ error }, 'Gmail OAuth error from Google');
      res.status(400).json({
        ok: false,
        error: 'GMAIL_OAUTH_DENIED',
        message: `Google authorization was denied: ${error}`,
      });
      return;
    }

    if (typeof state !== 'string' || typeof code !== 'string') {
      res.status(400).json({
        ok: false,
        error: 'GMAIL_OAUTH_INVALID',
        message: 'Missing state or code parameter',
      });
      return;
    }

    const oauth = getGmailOAuth();
    const result = await oauth.handleCallback(state, code);

    // In production, redirect to a success page. For now, return JSON.
    res.status(200).json({
      ok: true,
      message: `Gmail connected successfully for ${result.email}. You can close this page and return to WhatsApp.`,
      email: result.email,
    });
  } catch (err) {
    const message = (err as Error).message || 'Gmail OAuth callback failed';
    logger.error({ err: message }, 'Gmail OAuth callback error');

    // Don't expose internal details
    const safeMessage = message.includes('Invalid or expired')
      ? 'The authorization link has expired. Please request a new one.'
      : message.includes('already been used')
      ? 'This authorization link has already been used.'
      : 'Gmail connection failed. Please try again.';

    res.status(400).json({
      ok: false,
      error: 'GMAIL_OAUTH_FAILED',
      message: safeMessage,
    });
  }
}
