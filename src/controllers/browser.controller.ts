import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getConfig } from '../config/env';
import { getBrowserService } from '../services/browser';
import { getHandoffService } from '../services/browser/handoff';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../utils/errors';

const idSchema = z.string().uuid('A valid id is required');

const connectSchema = z.object({
  origin: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(80).optional(),
  // A Playwright storageState export: { cookies: [...], origins: [...] }
  storageState: z.object({
    cookies: z.array(z.record(z.unknown())).max(500).default([]),
    origins: z.array(z.record(z.unknown())).max(50).default([]),
  }),
});

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError('Invalid input payload', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** Identity comes exclusively from the session resolved by requireAuth, never from the request body. */
function authenticatedUserId(req: Request): string {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  return req.user.id;
}

/** Responses never contain cookies, tokens or any stored session data. */
export class BrowserController {
  /** GET /api/browser/connections */
  static async listConnections(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const connections = await getBrowserService().connections.list(authenticatedUserId(req));
      res.status(200).json({ connections });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/browser/connections: authorize a website with a session the user exported themselves. */
  static async connect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const body = parseOrThrow(connectSchema, req.body);
      const connection = await getBrowserService().connections.connect(
        userId,
        { origin: body.origin, label: body.label, storageState: body.storageState },
        { allowHttp: getConfig().BROWSER_ALLOW_PRIVATE_NETWORK }
      );
      res.status(201).json({ connection });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/browser/connections/:id: erases the stored session and ends any live browser using it. */
  static async disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const id = parseOrThrow(idSchema, req.params['id']);
      await getBrowserService().disconnect(userId, id);
      res.status(200).json({ disconnected: true });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/browser/handoffs: the caller's own sign-in requests and their status (never any link or token). */
  static async listHandoffs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const handoffs = (await getHandoffService()?.list(userId)) ?? [];
      res.status(200).json({ handoffs });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/browser/handoffs/:id/cancel */
  static async cancelHandoff(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const service = getHandoffService();
      if (!service) throw new NotFoundError('Sign-in not found');
      await service.cancel(userId, parseOrThrow(idSchema, req.params['id']));
      res.status(200).json({ cancelled: true });
    } catch (err) {
      next(err instanceof Error && err.name === 'HandoffError' ? new NotFoundError('Sign-in not found') : err);
    }
  }

  /** GET /api/browser/runs/:id */
  static async getRun(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const run = await getBrowserService().getRun(userId, parseOrThrow(idSchema, req.params['id']));
      if (!run) throw new NotFoundError('Browser run not found');
      res.status(200).json({
        run: {
          id: run.id,
          status: run.status,
          waitReason: run.waitReason,
          url: (run.checkpoint as { url?: string } | null)?.url ?? run.startUrl,
          steps: run.stepCount,
          navigations: run.navigationCount,
          recoveries: run.recoveryCount,
          errorCode: run.errorCode,
          deadlineAt: run.deadlineAt,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/browser/runs/:id/cancel */
  static async cancelRun(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const run = await getBrowserService().endRun(userId, parseOrThrow(idSchema, req.params['id']), 'cancelled');
      if (!run) throw new NotFoundError('Browser run not found');
      res.status(200).json({ run: { id: run.id, status: run.status } });
    } catch (err) {
      next(err);
    }
  }
}
