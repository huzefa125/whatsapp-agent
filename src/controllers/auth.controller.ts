import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuthService } from '../services/auth/auth.service';
import { BadRequestError } from '../utils/errors';

const startAuthSchema = z.object({
  phoneNumber: z.string().trim().min(1, 'phoneNumber is required'),
  email: z.string().trim().email('Valid email is required'),
});

const sendChallengeSchema = z.object({
  authFlowId: z.string().uuid('Valid authFlowId is required'),
});

const verifyChallengeSchema = z.object({
  authFlowId: z.string().uuid('Valid authFlowId is required'),
  code: z.string().min(4, 'Verification code is required').max(10),
});

export class AuthController {
  /**
   * POST /api/auth/start
   * Initiates dual-channel passwordless authentication.
   */
  static async start(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = startAuthSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid input payload', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const authService = getAuthService();
      const result = await authService.initiateAuthFlow(
        parsed.data.phoneNumber,
        parsed.data.email
      );

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/auth/challenge/phone/send
   * Dispatches WhatsApp phone OTP challenge.
   */
  static async sendPhoneOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = sendChallengeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid input payload', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const authService = getAuthService();
      const result = await authService.sendPhoneChallenge(parsed.data.authFlowId);

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/auth/challenge/phone/verify
   * Verifies WhatsApp phone OTP challenge.
   */
  static async verifyPhoneOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = verifyChallengeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid input payload', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const authService = getAuthService();
      const result = await authService.verifyPhoneChallenge(
        parsed.data.authFlowId,
        parsed.data.code
      );

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/auth/challenge/email/send
   * Dispatches transactional email OTP challenge.
   */
  static async sendEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = sendChallengeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid input payload', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const authService = getAuthService();
      const result = await authService.sendEmailChallenge(parsed.data.authFlowId);

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/auth/challenge/email/verify
   * Verifies email OTP challenge.
   */
  static async verifyEmailOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = verifyChallengeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Invalid input payload', {
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const authService = getAuthService();
      const result = await authService.verifyEmailChallenge(
        parsed.data.authFlowId,
        parsed.data.code
      );

      res.status(200).json({
        status: 'success',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/auth/me
   * Returns current authenticated user and session information.
   */
  static async me(req: Request, res: Response): Promise<void> {
    const user = req.user!;
    const session = req.session!;

    res.status(200).json({
      status: 'success',
      data: {
        user: {
          id: user.id,
          phoneNumber: user.phoneNumber,
          email: user.email,
          displayName: user.displayName,
          phoneVerifiedAt: user.phoneVerifiedAt,
          emailVerifiedAt: user.emailVerifiedAt,
          createdAt: user.createdAt,
        },
        session: {
          id: session.id,
          expiresAt: session.expiresAt,
          lastActiveAt: session.lastActiveAt,
        },
      },
    });
  }

  /**
   * POST /api/auth/logout
   * Revokes the current session token.
   */
  static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        const authService = getAuthService();
        await authService.revokeSession(token);
      }

      res.status(200).json({
        status: 'success',
        message: 'Session revoked successfully',
      });
    } catch (err) {
      next(err);
    }
  }
}
