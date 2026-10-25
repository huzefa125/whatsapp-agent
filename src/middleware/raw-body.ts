import { Request, Response } from 'express';

// Augment Express Request interface to include rawBody
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/**
 * Verification callback for express.json middleware that stores the raw buffer on req.rawBody.
 * Critical for cryptographic HMAC-SHA256 signature verification.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  if (buf && buf.length > 0) {
    req.rawBody = buf;
  }
}
