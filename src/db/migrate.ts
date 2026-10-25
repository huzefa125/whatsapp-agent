import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, closeDatabaseConnection } from './client';
import { logger } from '../utils/logger';

export async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations...');
  try {
    const db = getDb();
    await migrate(db, { migrationsFolder: './drizzle' });
    logger.info('Database migrations completed successfully');
  } catch (err) {
    logger.error({ err }, 'Database migration failed');
    throw err;
  }
}

// When run directly as a CLI script
if (require.main === module) {
  runMigrations()
    .catch((err) => {
      logger.fatal({ err }, 'Migration script exited with error');
      process.exit(1);
    })
    .finally(async () => {
      await closeDatabaseConnection();
    });
}
