import { eq, and, desc, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
  users,
  authFlows,
  authChallenges,
  sessions,
  User,
  AuthFlow,
  Session,
} from '../../db/schema';
import { getConfig } from '../../config/env';
import { normalizePhoneNumber, normalizeEmail } from '../../utils/normalization';
import {
  generateSecureOtp,
  computeOtpHash,
  verifyOtpHash,
  generateSessionToken,
  hashSessionToken,
} from '../../utils/otp';
import { getPhoneOtpSender, getEmailOtpSender } from './providers';
import {
  BadRequestError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  ExternalServiceError,
} from '../../utils/errors';
import { logger } from '../../utils/logger';

export interface InitiateAuthResult {
  authFlowId: string;
  phoneNumber: string;
  email: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  expiresAt: Date;
}

export interface ChallengeDispatchResult {
  accepted: boolean;
  channel: 'whatsapp' | 'email';
  providerMessageId?: string;
  cooldownSeconds: number;
  expiresAt: Date;
}

export interface VerificationResult {
  authFlowId: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  isFullyVerified: boolean;
  user?: {
    id: string;
    phoneNumber: string;
    email: string | null;
    displayName: string | null;
  };
  session?: {
    sessionToken: string;
    expiresAt: Date;
  };
}

export class AuthService {
  /**
   * Initiates a dual-channel passwordless authentication flow for phone and email.
   * Preserves partial verification state if an active session already exists.
   */
  async initiateAuthFlow(rawPhoneNumber: string, rawEmail: string): Promise<InitiateAuthResult> {
    const db = getDb();
    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
    const email = normalizeEmail(rawEmail);

    // 1. Verify user conflicts: prevent changing already-verified phone or email across accounts
    const existingPhoneUser = (
      await db.select().from(users).where(eq(users.phoneNumber, phoneNumber)).limit(1)
    )[0];

    const existingEmailUser = (
      await db.select().from(users).where(eq(users.email, email)).limit(1)
    )[0];

    if (existingPhoneUser && existingEmailUser && existingPhoneUser.id !== existingEmailUser.id) {
      throw new ConflictError(
        'The provided phone number and email address belong to two different registered accounts.'
      );
    }

    const now = new Date();
    const flowExpiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 minutes window

    // 2. Find active in-progress auth flow or create a new one
    const activeFlows = await db
      .select()
      .from(authFlows)
      .where(
        and(
          eq(authFlows.phoneNumber, phoneNumber),
          eq(authFlows.email, email),
          eq(authFlows.status, 'in_progress'),
          gt(authFlows.expiresAt, now)
        )
      )
      .orderBy(desc(authFlows.createdAt))
      .limit(1);

    let flow: AuthFlow;

    if (activeFlows.length > 0 && activeFlows[0]) {
      flow = activeFlows[0];
      logger.info({ authFlowId: flow.id }, 'Reusing existing in-progress authentication flow');
    } else {
      const inserted = await db
        .insert(authFlows)
        .values({
          phoneNumber,
          email,
          userId: existingPhoneUser?.id || existingEmailUser?.id || null,
          phoneVerified: false,
          emailVerified: false,
          status: 'in_progress',
          expiresAt: flowExpiresAt,
        })
        .returning();

      if (!inserted[0]) {
        throw new Error('Failed to initialize authentication flow');
      }
      flow = inserted[0];
      logger.info({ authFlowId: flow.id }, 'Created new dual-channel authentication flow');
    }

    return {
      authFlowId: flow.id,
      phoneNumber: flow.phoneNumber,
      email: flow.email,
      phoneVerified: flow.phoneVerified,
      emailVerified: flow.emailVerified,
      expiresAt: flow.expiresAt,
    };
  }

  /**
   * Dispatches a purpose-bound OTP challenge for phone verification via WhatsApp.
   */
  async sendPhoneChallenge(authFlowId: string): Promise<ChallengeDispatchResult> {
    const db = getDb();
    const config = getConfig();
    const now = new Date();

    const flow = (
      await db.select().from(authFlows).where(eq(authFlows.id, authFlowId)).limit(1)
    )[0];

    if (!flow || flow.status !== 'in_progress' || flow.expiresAt <= now) {
      throw new BadRequestError('Invalid or expired authentication flow session. Please restart auth.');
    }

    if (flow.phoneVerified) {
      return {
        accepted: true,
        channel: 'whatsapp',
        cooldownSeconds: 0,
        expiresAt: flow.expiresAt,
      };
    }

    // Check cooldown on existing challenge
    const existingChallenges = await db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.authFlowId, flow.id),
          eq(authChallenges.purpose, 'phone_verification'),
          eq(authChallenges.status, 'pending')
        )
      )
      .orderBy(desc(authChallenges.createdAt))
      .limit(1);

    const activeChallenge = existingChallenges[0];
    const cooldownMs = config.AUTH_OTP_RESEND_COOLDOWN_SECONDS * 1000;

    if (activeChallenge) {
      const elapsedMs = now.getTime() - activeChallenge.lastSentAt.getTime();
      if (elapsedMs < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        throw new RateLimitError(
          `Please wait ${remainingSeconds} seconds before requesting a new WhatsApp verification code.`
        );
      }

      // Mark older pending challenge as expired
      await db
        .update(authChallenges)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(authChallenges.id, activeChallenge.id));
    }

    // Generate secure OTP and purpose-bound keyed HMAC hash
    const otp = generateSecureOtp();
    const otpHash = computeOtpHash(
      otp,
      'phone_verification',
      flow.phoneNumber,
      config.AUTH_OTP_HMAC_SECRET
    );
    const expiresAt = new Date(now.getTime() + config.AUTH_OTP_EXPIRY_MINUTES * 60 * 1000);

    // Save challenge
    const insertedChallenges = await db
      .insert(authChallenges)
      .values({
        authFlowId: flow.id,
        purpose: 'phone_verification',
        target: flow.phoneNumber,
        otpHash,
        status: 'pending',
        attempts: 0,
        maxAttempts: config.AUTH_OTP_MAX_ATTEMPTS,
        expiresAt,
        lastSentAt: now,
      })
      .returning();

    const challengeId = insertedChallenges[0]?.id;

    // Dispatch OTP via WhatsApp provider
    try {
      const phoneSender = getPhoneOtpSender();
      const sendResult = await phoneSender.sendOtp(flow.phoneNumber, otp);

      return {
        accepted: true,
        channel: 'whatsapp',
        providerMessageId: sendResult.providerMessageId,
        cooldownSeconds: config.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
        expiresAt,
      };
    } catch (err) {
      if (challengeId) {
        await db.delete(authChallenges).where(eq(authChallenges.id, challengeId));
      }
      if (err instanceof ExternalServiceError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ExternalServiceError('WhatsApp Provider', message);
    }
  }

  /**
   * Dispatches a purpose-bound OTP challenge for email verification via transactional email.
   */
  async sendEmailChallenge(authFlowId: string): Promise<ChallengeDispatchResult> {
    const db = getDb();
    const config = getConfig();
    const now = new Date();

    const flow = (
      await db.select().from(authFlows).where(eq(authFlows.id, authFlowId)).limit(1)
    )[0];

    if (!flow || flow.status !== 'in_progress' || flow.expiresAt <= now) {
      throw new BadRequestError('Invalid or expired authentication flow session. Please restart auth.');
    }

    if (flow.emailVerified) {
      return {
        accepted: true,
        channel: 'email',
        cooldownSeconds: 0,
        expiresAt: flow.expiresAt,
      };
    }

    // Check cooldown on existing challenge
    const existingChallenges = await db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.authFlowId, flow.id),
          eq(authChallenges.purpose, 'email_verification'),
          eq(authChallenges.status, 'pending')
        )
      )
      .orderBy(desc(authChallenges.createdAt))
      .limit(1);

    const activeChallenge = existingChallenges[0];
    const cooldownMs = config.AUTH_OTP_RESEND_COOLDOWN_SECONDS * 1000;

    if (activeChallenge) {
      const elapsedMs = now.getTime() - activeChallenge.lastSentAt.getTime();
      if (elapsedMs < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - elapsedMs) / 1000);
        throw new RateLimitError(
          `Please wait ${remainingSeconds} seconds before requesting a new email verification code.`
        );
      }

      // Mark older pending challenge as expired
      await db
        .update(authChallenges)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(authChallenges.id, activeChallenge.id));
    }

    // Generate secure OTP and purpose-bound keyed HMAC hash
    const otp = generateSecureOtp();
    const otpHash = computeOtpHash(
      otp,
      'email_verification',
      flow.email,
      config.AUTH_OTP_HMAC_SECRET
    );
    const expiresAt = new Date(now.getTime() + config.AUTH_OTP_EXPIRY_MINUTES * 60 * 1000);

    // Save challenge
    const insertedChallenges = await db
      .insert(authChallenges)
      .values({
        authFlowId: flow.id,
        purpose: 'email_verification',
        target: flow.email,
        otpHash,
        status: 'pending',
        attempts: 0,
        maxAttempts: config.AUTH_OTP_MAX_ATTEMPTS,
        expiresAt,
        lastSentAt: now,
      })
      .returning();

    const challengeId = insertedChallenges[0]?.id;

    // Dispatch OTP via Email provider
    try {
      const emailSender = getEmailOtpSender();
      const sendResult = await emailSender.sendOtp(flow.email, otp);

      return {
        accepted: true,
        channel: 'email',
        providerMessageId: sendResult.providerMessageId,
        cooldownSeconds: config.AUTH_OTP_RESEND_COOLDOWN_SECONDS,
        expiresAt,
      };
    } catch (err) {
      if (challengeId) {
        await db.delete(authChallenges).where(eq(authChallenges.id, challengeId));
      }
      if (err instanceof ExternalServiceError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ExternalServiceError('Email Provider', message);
    }
  }

  /**
   * Verifies an OTP code for phone verification.
   * If email is also verified, completes the dual-channel flow and issues a session.
   */
  async verifyPhoneChallenge(authFlowId: string, inputCode: string): Promise<VerificationResult> {
    return this.verifyChallenge(authFlowId, 'phone_verification', inputCode);
  }

  /**
   * Verifies an OTP code for email verification.
   * If phone is also verified, completes the dual-channel flow and issues a session.
   */
  async verifyEmailChallenge(authFlowId: string, inputCode: string): Promise<VerificationResult> {
    return this.verifyChallenge(authFlowId, 'email_verification', inputCode);
  }

  private async verifyChallenge(
    authFlowId: string,
    purpose: 'phone_verification' | 'email_verification',
    inputCode: string
  ): Promise<VerificationResult> {
    const db = getDb();
    const config = getConfig();
    const now = new Date();

    const flow = (
      await db.select().from(authFlows).where(eq(authFlows.id, authFlowId)).limit(1)
    )[0];

    if (!flow || flow.status !== 'in_progress' || flow.expiresAt <= now) {
      throw new BadRequestError('Invalid or expired authentication flow session.');
    }

    const target = purpose === 'phone_verification' ? flow.phoneNumber : flow.email;

    // Find the latest challenge for this purpose
    const challenges = await db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.authFlowId, flow.id),
          eq(authChallenges.purpose, purpose)
        )
      )
      .orderBy(desc(authChallenges.createdAt))
      .limit(1);

    const challenge = challenges[0];
    if (!challenge) {
      throw new BadRequestError(
        `No pending ${purpose === 'phone_verification' ? 'phone' : 'email'} verification challenge found. Please request a new code.`
      );
    }

    if (challenge.status === 'verified') {
      throw new BadRequestError(
        `No pending ${purpose === 'phone_verification' ? 'phone' : 'email'} verification challenge found. Challenge has already been verified.`
      );
    }

    if (challenge.status === 'locked' || challenge.attempts >= challenge.maxAttempts) {
      throw new BadRequestError('Maximum verification attempts exceeded. Please request a new code.');
    }

    // Check expiry
    if (challenge.status === 'expired' || challenge.expiresAt <= now) {
      if (challenge.status !== 'expired') {
        await db
          .update(authChallenges)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(authChallenges.id, challenge.id));
      }
      throw new BadRequestError('Verification code has expired. Please request a new code.');
    }

    // Verify OTP using constant-time keyed HMAC comparison
    const isValid = verifyOtpHash(
      inputCode,
      purpose,
      target,
      challenge.otpHash,
      config.AUTH_OTP_HMAC_SECRET
    );

    if (!isValid) {
      const newAttempts = challenge.attempts + 1;
      const isLocked = newAttempts >= challenge.maxAttempts;

      await db
        .update(authChallenges)
        .set({
          attempts: newAttempts,
          status: isLocked ? 'locked' : 'pending',
          updatedAt: now,
        })
        .where(eq(authChallenges.id, challenge.id));

      const remaining = challenge.maxAttempts - newAttempts;
      throw new BadRequestError(
        isLocked
          ? 'Incorrect verification code. Maximum attempts reached; challenge is locked.'
          : `Incorrect verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      );
    }

    // Mark challenge verified atomically (Replay protection)
    await db
      .update(authChallenges)
      .set({
        status: 'verified',
        verifiedAt: now,
        updatedAt: now,
      })
      .where(eq(authChallenges.id, challenge.id));

    // Update flow verification flag
    const updatedFlowValues =
      purpose === 'phone_verification'
        ? { phoneVerified: true, updatedAt: now }
        : { emailVerified: true, updatedAt: now };

    await db.update(authFlows).set(updatedFlowValues).where(eq(authFlows.id, flow.id));

    const phoneVerified = purpose === 'phone_verification' ? true : flow.phoneVerified;
    const emailVerified = purpose === 'email_verification' ? true : flow.emailVerified;
    const isFullyVerified = phoneVerified && emailVerified;

    if (!isFullyVerified) {
      // Partial verification: retain status safely and allow other channel completion
      logger.info(
        { authFlowId: flow.id, verifiedChannel: purpose },
        'Partial verification successful; awaiting completion of second channel'
      );
      return {
        authFlowId: flow.id,
        phoneVerified,
        emailVerified,
        isFullyVerified: false,
      };
    }

    // Both channels are verified! Finalize user and create session
    return await this.completeAuthAndIssueSession(flow.id, flow.phoneNumber, flow.email);
  }

  /**
   * Finalizes user record and issues session token after both channels are verified.
   */
  private async completeAuthAndIssueSession(
    authFlowId: string,
    phoneNumber: string,
    email: string
  ): Promise<VerificationResult> {
    const db = getDb();
    const config = getConfig();
    const now = new Date();

    // 1. Resolve or create user with both verified channels
    let user = (
      await db.select().from(users).where(eq(users.phoneNumber, phoneNumber)).limit(1)
    )[0];

    if (!user) {
      const inserted = await db
        .insert(users)
        .values({
          phoneNumber,
          email,
          phoneVerifiedAt: now,
          emailVerifiedAt: now,
          metadata: {},
        })
        .returning();
      user = inserted[0];
    } else {
      // Prevent changing already verified phone or email without re-verification
      await db
        .update(users)
        .set({
          email,
          phoneVerifiedAt: now,
          emailVerifiedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      user.email = email;
      user.phoneVerifiedAt = now;
      user.emailVerifiedAt = now;
    }

    if (!user) {
      throw new Error('Failed to resolve or persist user account');
    }

    // 2. Mark auth flow as completed
    await db
      .update(authFlows)
      .set({
        status: 'completed',
        userId: user.id,
        phoneVerified: true,
        emailVerified: true,
        updatedAt: now,
      })
      .where(eq(authFlows.id, authFlowId));

    // 3. Issue secure session token (only after BOTH channels are verified)
    const sessionToken = generateSessionToken(32);
    const tokenHash = hashSessionToken(sessionToken);
    const sessionExpiresAt = new Date(
      now.getTime() + config.AUTH_SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );

    await db.insert(sessions).values({
      userId: user.id,
      tokenHash,
      expiresAt: sessionExpiresAt,
      lastActiveAt: now,
    });

    logger.info(
      { userId: user.id, authFlowId },
      'Dual-channel passwordless authentication successful; session issued'
    );

    return {
      authFlowId,
      phoneVerified: true,
      emailVerified: true,
      isFullyVerified: true,
      user: {
        id: user.id,
        phoneNumber: user.phoneNumber,
        email: user.email,
        displayName: user.displayName,
      },
      session: {
        sessionToken,
        expiresAt: sessionExpiresAt,
      },
    };
  }

  /**
   * Validates a session bearer token, verifies account full verification, and updates lastActiveAt.
   */
  async validateSession(rawToken: string): Promise<{ user: User; session: Session }> {
    const db = getDb();
    const now = new Date();

    if (!rawToken || typeof rawToken !== 'string') {
      throw new UnauthorizedError('Authentication token missing or invalid');
    }

    const tokenHash = hashSessionToken(rawToken.trim());

    const activeSessions = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          gt(sessions.expiresAt, now),
          isNull(sessions.revokedAt)
        )
      )
      .limit(1);

    const session = activeSessions[0];
    if (!session) {
      throw new UnauthorizedError('Session is invalid or has expired');
    }

    const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
    const user = userRows[0];

    if (!user) {
      throw new UnauthorizedError('User account not found');
    }

    // Require both phone and email verified for fully authenticated session
    if (!user.phoneVerifiedAt || !user.emailVerifiedAt) {
      throw new ForbiddenError(
        'Dual-channel verification incomplete: both verified phone and email are required.'
      );
    }

    // Update lastActiveAt
    await db.update(sessions).set({ lastActiveAt: now }).where(eq(sessions.id, session.id));

    return { user, session };
  }

  /**
   * Revokes an active session token (Logout).
   */
  async revokeSession(rawToken: string): Promise<boolean> {
    const db = getDb();
    const tokenHash = hashSessionToken(rawToken.trim());

    const updated = await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .returning();

    return updated.length > 0;
  }
}

let activeAuthService: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!activeAuthService) {
    activeAuthService = new AuthService();
  }
  return activeAuthService;
}

export function setAuthServiceForTesting(service: AuthService | null): void {
  activeAuthService = service;
}
