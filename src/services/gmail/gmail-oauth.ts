import crypto from 'crypto';
import { eq, and, gt } from 'drizzle-orm';
import { google } from 'googleapis';
import { getDb } from '../../db/client';
import { gmailConnections, gmailOauthStates } from '../../db/schema';
import { getConfig } from '../../config/env';
import { encryptSecret, decryptSecret } from '../../utils/secret-box';
import { logger } from '../../utils/logger';

/**
 * Gmail OAuth 2.0 scopes. Read-only by default; send scopes only when user opts in.
 */
export const GMAIL_SCOPES = {
  /** Search, read and list emails. */
  READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
  /** Send emails on behalf of the user. */
  SEND: 'https://www.googleapis.com/auth/gmail.send',
  /** Create, read and update drafts. */
  COMPOSE: 'https://www.googleapis.com/auth/gmail.compose',
  /** View email address. */
  EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
} as const;

/**
 * Minimum read-only scopes requested by default.
 */
export const DEFAULT_GMAIL_SCOPES = [GMAIL_SCOPES.EMAIL, GMAIL_SCOPES.READONLY] as const;

/**
 * Full scopes when user enables sending.
 */
export const SEND_GMAIL_SCOPES = [
  GMAIL_SCOPES.EMAIL,
  GMAIL_SCOPES.READONLY,
  GMAIL_SCOPES.SEND,
  GMAIL_SCOPES.COMPOSE,
] as const;

function aad(userId: string): string {
  return `gmail:${userId}`;
}

function getOAuth2Client() {
  const config = getConfig();
  return new google.auth.OAuth2(
    config.GMAIL_CLIENT_ID,
    config.GMAIL_CLIENT_SECRET,
    config.GMAIL_REDIRECT_URI,
  );
}

/**
 * Generates a PKCE code verifier and challenge (S256).
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

export interface GmailOAuthService {
  /** Creates the authorization URL and persists the CSRF state. */
  startAuthorization(userId: string, includeSendScope: boolean): Promise<{ authUrl: string }>;
  /** Exchanges the auth code for tokens, validates state, and stores the encrypted refresh token. */
  handleCallback(state: string, code: string): Promise<{ email: string; userId: string }>;
  /** Returns the connection status for a user. */
  getStatus(userId: string): Promise<{ status: 'connected' | 'not_connected' | 'expired' | 'revoked'; email?: string; scopes?: string[] }>;
  /** Revokes the token and marks the connection as revoked. */
  disconnect(userId: string): Promise<void>;
  /** Returns an authenticated OAuth2 client for making Gmail API calls. */
  getAuthenticatedClient(userId: string): Promise<{ client: InstanceType<typeof google.auth.OAuth2>; connectionId: string; scopes: string[] }>;
  /** Checks if the user has the send scope granted. */
  hasSendScope(userId: string): Promise<boolean>;
}

export function createGmailOAuthService(): GmailOAuthService {
  const config = getConfig();

  return {
    async startAuthorization(userId, includeSendScope) {
      const db = getDb();
      const scopes = includeSendScope ? [...SEND_GMAIL_SCOPES] : [...DEFAULT_GMAIL_SCOPES];
      const { codeVerifier, codeChallenge } = generatePKCE();
      const state = crypto.randomBytes(32).toString('base64url');

      const expiresAt = new Date(Date.now() + config.GMAIL_OAUTH_STATE_TTL_MINUTES * 60 * 1000);

      await db.insert(gmailOauthStates).values({
        userId,
        state,
        codeVerifier,
        requestedScopes: scopes.join(' '),
        redirectUri: config.GMAIL_REDIRECT_URI,
        expiresAt,
      });

      const oauth2 = getOAuth2Client();
      const authUrl = oauth2.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        state,
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256' as any,
      });

      logger.info({ userId }, 'Gmail OAuth authorization started');
      return { authUrl };
    },

    async handleCallback(state, code) {
      const db = getDb();

      // Validate state (CSRF protection)
      const [oauthState] = await db
        .select()
        .from(gmailOauthStates)
        .where(and(eq(gmailOauthStates.state, state), gt(gmailOauthStates.expiresAt, new Date())))
        .limit(1);

      if (!oauthState) {
        throw new Error('Invalid or expired OAuth state');
      }

      if (oauthState.usedAt) {
        throw new Error('OAuth state has already been used');
      }

      // Mark state as used
      await db
        .update(gmailOauthStates)
        .set({ usedAt: new Date() })
        .where(eq(gmailOauthStates.id, oauthState.id));

      // Validate redirect URI matches
      if (oauthState.redirectUri !== config.GMAIL_REDIRECT_URI) {
        throw new Error('Redirect URI mismatch');
      }

      // Exchange code for tokens with PKCE
      const oauth2 = getOAuth2Client();
      const { tokens } = await oauth2.getToken({
        code,
        codeVerifier: oauthState.codeVerifier,
      });

      if (!tokens.refresh_token) {
        throw new Error('No refresh token received; user may need to re-authorize with consent prompt');
      }

      // Get the user's email address
      oauth2.setCredentials(tokens);
      const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
      const userInfo = await oauth2Api.userinfo.get();
      const email = userInfo.data.email;

      if (!email) {
        throw new Error('Could not retrieve Google email address');
      }

      // Encrypt the refresh token
      const encryptedRefreshToken = encryptSecret(
        tokens.refresh_token,
        config.GMAIL_ENCRYPTION_KEY,
        aad(oauthState.userId),
      );

      // Upsert the connection
      const existing = await db
        .select()
        .from(gmailConnections)
        .where(and(eq(gmailConnections.userId, oauthState.userId), eq(gmailConnections.googleEmail, email)))
        .limit(1);

      if (existing[0]) {
        await db
          .update(gmailConnections)
          .set({
            encryptedRefreshToken,
            scopes: oauthState.requestedScopes,
            status: 'connected',
            tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            updatedAt: new Date(),
          })
          .where(eq(gmailConnections.id, existing[0].id));
      } else {
        await db.insert(gmailConnections).values({
          userId: oauthState.userId,
          googleEmail: email,
          scopes: oauthState.requestedScopes,
          encryptedRefreshToken,
          tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        });
      }

      logger.info({ userId: oauthState.userId, email }, 'Gmail OAuth connection established');
      return { email, userId: oauthState.userId };
    },

    async getStatus(userId) {
      const db = getDb();
      const [conn] = await db
        .select()
        .from(gmailConnections)
        .where(eq(gmailConnections.userId, userId))
        .limit(1);

      if (!conn) {
        return { status: 'not_connected' };
      }

      return {
        status: conn.status as 'connected' | 'expired' | 'revoked',
        email: conn.googleEmail,
        scopes: conn.scopes.split(' '),
      };
    },

    async disconnect(userId) {
      const db = getDb();
      const [conn] = await db
        .select()
        .from(gmailConnections)
        .where(and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, 'connected')))
        .limit(1);

      if (!conn) return;

      // Try to revoke the token with Google
      try {
        const refreshToken = decryptSecret(
          conn.encryptedRefreshToken,
          config.GMAIL_ENCRYPTION_KEY,
          aad(userId),
        );
        const oauth2 = getOAuth2Client();
        oauth2.setCredentials({ refresh_token: refreshToken });
        await oauth2.revokeCredentials();
      } catch (err) {
        logger.warn({ userId, err: (err as Error).message }, 'Failed to revoke Gmail token with Google; marking as revoked locally');
      }

      await db
        .update(gmailConnections)
        .set({ status: 'revoked', encryptedRefreshToken: '***revoked***', updatedAt: new Date() })
        .where(eq(gmailConnections.id, conn.id));

      logger.info({ userId }, 'Gmail connection disconnected');
    },

    async getAuthenticatedClient(userId) {
      const db = getDb();
      const [conn] = await db
        .select()
        .from(gmailConnections)
        .where(and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, 'connected')))
        .limit(1);

      if (!conn) {
        throw new Error('Gmail is not connected. Please connect your Gmail account first.');
      }

      let refreshToken: string;
      try {
        refreshToken = decryptSecret(
          conn.encryptedRefreshToken,
          config.GMAIL_ENCRYPTION_KEY,
          aad(userId),
        );
      } catch {
        // Mark as expired if decryption fails (likely key rotation)
        await db
          .update(gmailConnections)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(gmailConnections.id, conn.id));
        throw new Error('Gmail connection has expired. Please reconnect your Gmail account.');
      }

      const oauth2 = getOAuth2Client();
      oauth2.setCredentials({ refresh_token: refreshToken });

      // Refresh the access token
      try {
        const { credentials } = await oauth2.refreshAccessToken();
        oauth2.setCredentials(credentials);

        // Update last used
        await db
          .update(gmailConnections)
          .set({
            lastUsedAt: new Date(),
            tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
            updatedAt: new Date(),
          })
          .where(eq(gmailConnections.id, conn.id));
      } catch (err) {
        const message = (err as Error).message || '';
        if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
          await db
            .update(gmailConnections)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(eq(gmailConnections.id, conn.id));
          throw new Error('Gmail access has been revoked or expired. Please reconnect your Gmail account.');
        }
        throw err;
      }

      return { client: oauth2, connectionId: conn.id, scopes: conn.scopes.split(' ') };
    },

    async hasSendScope(userId) {
      const db = getDb();
      const [conn] = await db
        .select({ scopes: gmailConnections.scopes })
        .from(gmailConnections)
        .where(and(eq(gmailConnections.userId, userId), eq(gmailConnections.status, 'connected')))
        .limit(1);

      if (!conn) return false;
      return conn.scopes.includes(GMAIL_SCOPES.SEND);
    },
  };
}
