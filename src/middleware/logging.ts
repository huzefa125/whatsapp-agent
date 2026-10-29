import pinoHttp from 'pino-http';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { redactPath } from '../utils/redact-path';

/** Built from a logger so tests can capture exactly what would be written. */
export const createHttpLogger = (log: typeof logger) =>
  pinoHttp({
  logger: log,
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
    return `${req.method} ${redactPath(req.url)} completed with status ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${redactPath(req.url)} failed with status ${res.statusCode}: ${err.message}`;
  },
  // Handoff links carry a bearer token in the path and a session secret in a cookie: neither may reach the logs.
  serializers: {
    // The parsed query/params objects are dropped too: they would repeat the very values redacted from the URL.
    req: ({ query: _query, params: _params, ...req }: { url?: string; query?: unknown; params?: unknown; [k: string]: unknown }) => ({
      ...req,
      url: redactPath(req.url),
    }),
  },
  // Redact authorization, webhook signatures, cookies and CSRF tokens
  redact: [
    'req.headers.authorization',
    'req.headers["x-hub-signature-256"]',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
  ],
  });

export const httpLogger = createHttpLogger(logger);
