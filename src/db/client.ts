import { Pool } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { getConfig } from '../config/env';
import { logger } from '../utils/logger';

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

/**
 * Initializes and returns the PostgreSQL connection pool.
 */
export function getPool(): Pool {
  if (!pool) {
    const config = getConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      min: config.DATABASE_POOL_MIN,
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });

    pool.on('error', (err) => {
      logger.error({ err }, 'Unexpected error on idle PostgreSQL client');
    });
  }
  return pool;
}

/**
 * Returns the Drizzle ORM database instance.
 */
export function getDb(): NodePgDatabase<typeof schema> {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/**
 * Performs a health check ping against PostgreSQL.
 */
export async function checkDatabaseConnection(): Promise<{ healthy: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const currentPool = getPool();
    const client = await currentPool.connect();
    try {
      await client.query('SELECT 1');
      return { healthy: true, latencyMs: Date.now() - start };
    } finally {
      client.release();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ error: message }, 'Database readiness check failed');
    return { healthy: false, error: message };
  }
}

/**
 * Closes the database pool gracefully.
 */
export async function closeDatabaseConnection(): Promise<void> {
  if (pool) {
    logger.info('Closing PostgreSQL connection pool...');
    await pool.end();
    pool = null;
    db = null;
    logger.info('PostgreSQL connection pool closed');
  }
}

/**
 * Allows injecting a custom or mock db instance for testing.
 */
export function setDbForTesting(mockDb: NodePgDatabase<typeof schema> | null): void {
  db = mockDb;
}
