import pinoHttp from 'pino-http';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => {
    const existingId = req.headers['x-request-id'];
    if (typeof existingId === 'string' && existingId.trim() !== '') {
      return existingId;
    }
    return crypto.randomUUID();
  },
  customLogLevel: (_req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} completed with status ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed with status ${res.statusCode}: ${err.message}`;
  },
  // Redact authorization and webhook signatures
  redact: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]'],
});
