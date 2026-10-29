import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_APP_SECRET',
      'AI_API_KEY',
      'DATABASE_URL',
      'AUTH_OTP_HMAC_SECRET',
      'SMTP_PASS',
      'headers.authorization',
      'password',
      'token',
      'secret',
      'otp',
      'code',
      'otpHash',
      'sessionToken',
      'session_token',
      'tokenHash',
      'refreshToken',
      'refresh_token',
      'access_token',
      'accessToken',
      'encryptedRefreshToken',
      'GMAIL_CLIENT_SECRET',
      'GMAIL_ENCRYPTION_KEY',
    ],
    censor: '[REDACTED]',
  },
  transport:
    !isProduction && !isTest
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

/**
 * Creates a child logger with contextual bindings such as requestId, userId, or eventId.
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
