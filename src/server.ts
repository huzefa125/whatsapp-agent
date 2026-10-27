import http from 'http';
import { createApp } from './app';
import { getConfig, getSafeConfig } from './config/env';
import { checkDatabaseConnection, closeDatabaseConnection } from './db/client';
import { getOutboxService } from './services/queue/outbox';
import { getAgentTaskService } from './services/agent/engine/task-service';
import { logger } from './utils/logger';

export async function startServer(): Promise<http.Server> {
  const config = getConfig();
  logger.info({ config: getSafeConfig(config) }, 'Initializing WhatsApp AI Agent service');

  // Verify database connectivity
  const dbHealth = await checkDatabaseConnection();
  if (!dbHealth.healthy) {
    if (config.NODE_ENV === 'production') {
      logger.fatal({ error: dbHealth.error }, 'Cannot start in production without a reachable PostgreSQL database');
      process.exit(1);
    } else {
      logger.warn(
        { error: dbHealth.error },
        'PostgreSQL connection not reachable at startup; running in degraded/dev mode'
      );
    }
  } else {
    logger.info({ latencyMs: dbHealth.latencyMs }, 'PostgreSQL connection verified');
  }

  // Start background outbox queue worker
  const outboxService = getOutboxService();
  outboxService.startWorker();

  // Start durable agent task worker (leases + SKIP LOCKED make multiple instances safe)
  const agentTasks = getAgentTaskService();
  if (config.AGENT_WORKER_ENABLED) {
    agentTasks.startWorker();
  } else {
    logger.info('Agent task worker disabled via AGENT_WORKER_ENABLED=false');
  }

  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        aiProvider: config.AI_PROVIDER,
      },
      `Server successfully listening on port ${config.PORT}`
    );
  });

  // Graceful Shutdown Handler
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    const forceExitTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 10s; forcing exit');
      process.exit(1);
    }, 10000);

    try {
      // 1. Stop background worker
      outboxService.stopWorker();
      await agentTasks.stopWorker();

      // 2. Close HTTP server
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      logger.info('HTTP server closed');

      // 3. Close database connection pool
      await closeDatabaseConnection();

      clearTimeout(forceExitTimeout);
      logger.info('Graceful shutdown completed successfully');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled Promise Rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught Exception');
    process.exit(1);
  });

  return server;
}
