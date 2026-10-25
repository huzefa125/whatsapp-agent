import { Request, Response } from 'express';
import { checkDatabaseConnection } from '../db/client';

export class HealthController {
  /**
   * Liveness probe: returns 200 OK if server process is running.
   */
  static getLiveness(_req: Request, res: Response): void {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Readiness probe: checks critical dependencies (PostgreSQL) before routing traffic.
   * Does not expose secrets, credentials, or internal IPs.
   */
  static async getReadiness(_req: Request, res: Response): Promise<void> {
    const dbCheck = await checkDatabaseConnection();

    if (!dbCheck.healthy) {
      res.status(503).json({
        status: 'unavailable',
        checks: {
          database: {
            status: 'disconnected',
            error: 'Failed to communicate with primary database',
          },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.status(200).json({
      status: 'ready',
      checks: {
        database: {
          status: 'connected',
          latencyMs: dbCheck.latencyMs,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }
}
