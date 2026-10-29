import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { getConfig } from '../config/env';
import { redactPath } from '../utils/redact-path';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const config = getConfig();
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(
        {
          requestId,
          err,
          code: err.code,
          details: err.details,
          path: redactPath(req.originalUrl),
          method: req.method,
        },
        'Operational error occurred'
      );
    } else {
      logger.warn(
        {
          requestId,
          code: err.code,
          message: err.message,
          path: redactPath(req.originalUrl),
          method: req.method,
        },
        'Client request error'
      );
    }

    res.status(err.statusCode).json({
      status: 'error',
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
      requestId,
    });
    return;
  }

  // Handle malformed JSON body parser error
  if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_JSON_PAYLOAD',
      message: 'The request body could not be parsed as valid JSON.',
      requestId,
    });
    return;
  }

  // Unhandled / Unexpected Server Errors
  logger.error(
    {
      requestId,
      err,
      path: redactPath(req.originalUrl),
      method: req.method,
    },
    'Unhandled server error occurred'
  );

  const isDevOrTest = config.NODE_ENV !== 'production';

  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: isDevOrTest ? err.message : 'An unexpected internal server error occurred.',
    ...(isDevOrTest && { stack: err.stack }),
    requestId,
  });
}
