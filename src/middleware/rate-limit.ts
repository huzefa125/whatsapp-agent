import rateLimit from 'express-rate-limit';
import { getConfig } from '../config/env';

export function createRateLimiter() {
  const config = getConfig();

  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      status: 'error',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests from this IP, please try again later.',
    },
    // Bypass rate limiting in test environment or dev test runners
    skip: (req) =>
      config.NODE_ENV === 'test' ||
      (config.NODE_ENV !== 'production' && req.headers['x-test-bypass-rate-limit'] === 'true'),
  });
}
