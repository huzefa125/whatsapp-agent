import { Request, Response, NextFunction } from 'express';
import { getAuthService } from '../services/auth/auth.service';
import { UnauthorizedError } from '../utils/errors';
import { User, Session } from '../db/schema';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      session?: Session;
    }
  }
}

/**
 * Middleware requiring a valid, active session token with both phone and email verified.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Authorization bearer token is missing'));
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return next(new UnauthorizedError('Authorization bearer token is empty'));
  }

  try {
    const authService = getAuthService();
    const { user, session } = await authService.validateSession(token);
    req.user = user;
    req.session = session;
    next();
  } catch (err) {
    next(err);
  }
}
