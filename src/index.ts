import { startServer } from './server';
import { logger } from './utils/logger';

startServer().catch((err) => {
  logger.fatal({ err }, 'Fatal error during server bootstrap');
  process.exit(1);
});
