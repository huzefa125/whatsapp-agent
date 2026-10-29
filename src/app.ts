import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { swaggerDocument } from './config/swagger';
import { captureRawBody } from './middleware/raw-body';
import { httpLogger } from './middleware/logging';
import { createRateLimiter } from './middleware/rate-limit';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import routes from './routes';
import { getConfig } from './config/env';

export function createApp(): Application {
  const app = express();
  const config = getConfig();

  // Behind a reverse proxy: trust its X-Forwarded-* headers so client IPs (rate limiting) and HTTPS are correct.
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  // 1. Security Headers with CSP compatible with Swagger UI
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // 2. CORS configuration (restricted)
  if (config.CORS_ALLOWED_ORIGINS) {
    const allowedOrigins = config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    app.use(
      cors({
        origin: allowedOrigins,
        credentials: true,
      })
    );
  } else {
    // In absence of explicit frontend origins, allow local dev or disable cross-origin credentials
    app.use(cors({ origin: false }));
  }

  // 3. Request Logging with correlation ID
  app.use(httpLogger);

  // 4. Rate Limiting
  app.use(createRateLimiter());

  // 5. Body Parsers with Raw Body Capture (strictly needed for HMAC signature checks)
  app.use(
    express.json({
      limit: '1mb',
      verify: captureRawBody,
    })
  );
  app.use(
    express.urlencoded({
      extended: true,
      limit: '1mb',
      verify: captureRawBody,
    })
  );

  // 6. Interactive OpenAPI / Swagger Documentation
  app.get('/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerDocument);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  // 7. Routes
  app.use('/', routes);

  // 7. 404 Fallthrough
  app.use(notFoundHandler);

  // 8. Centralized Error Handler
  app.use(errorHandler);

  return app;
}
