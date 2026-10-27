import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAgentTaskService } from '../services/agent/engine/task-service';
import { TASK_STATUSES } from '../services/agent/engine/task-state';
import { BadRequestError, UnauthorizedError } from '../utils/errors';

const createTaskSchema = z.object({
  request: z.string().trim().min(1, 'request is required'),
  conversationId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});

const taskIdSchema = z.string().uuid('Valid task id is required');

const listQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const confirmSchema = z.object({
  callId: z.string().trim().min(1).max(64),
  decision: z.enum(['approve', 'reject']),
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

/** Identity comes exclusively from the session resolved by requireAuth. */
function authenticatedUserId(req: Request): string {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  return req.user.id;
}

export class AgentTaskController {
  /** POST /api/agent/tasks */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const body = parseOrThrow(createTaskSchema, req.body);
      const headerKey = req.header('idempotency-key')?.trim();
      const { task, created } = await getAgentTaskService().createTask(userId, {
        request: body.request,
        conversationId: body.conversationId,
        idempotencyKey: body.idempotencyKey ?? (headerKey || undefined),
      });
      res.status(created ? 202 : 200).json({ status: 'success', data: task });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/agent/tasks */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const query = parseOrThrow(listQuerySchema, req.query);
      const tasks = await getAgentTaskService().listTasks(userId, query);
      res.status(200).json({ status: 'success', data: tasks });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/agent/tasks/:id */
  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const id = parseOrThrow(taskIdSchema, req.params.id);
      const task = await getAgentTaskService().getTask(userId, id);
      res.status(200).json({ status: 'success', data: task });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/agent/tasks/:id/cancel */
  static async cancel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const id = parseOrThrow(taskIdSchema, req.params.id);
      const task = await getAgentTaskService().cancelTask(userId, id);
      res.status(200).json({ status: 'success', data: task });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/agent/tasks/:id/confirm */
  static async confirm(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = authenticatedUserId(req);
      const id = parseOrThrow(taskIdSchema, req.params.id);
      const body = parseOrThrow(confirmSchema, req.body);
      const task = await getAgentTaskService().confirmTask(userId, id, body.callId, body.decision);
      res.status(200).json({ status: 'success', data: task });
    } catch (err) {
      next(err);
    }
  }
}
