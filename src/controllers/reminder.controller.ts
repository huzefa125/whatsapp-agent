import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getReminderService } from '../services/reminders/reminder-service';
import { scheduleSpecSchema } from '../services/reminders/time';
import { BadRequestError, UnauthorizedError } from '../utils/errors';

const STATUSES = ['scheduled', 'processing', 'sent', 'failed', 'cancelled', 'completed'] as const;

const createSchema = z
  .object({
    title: z.string().min(1, 'title is required'),
    when: scheduleSpecSchema,
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strip();

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    when: scheduleSpecSchema.optional(),
    status: z.enum(['completed', 'cancelled']).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.when !== undefined || v.status !== undefined, {
    message: 'Provide at least one of title, when, status',
  })
  .refine((v) => v.status === undefined || (v.title === undefined && v.when === undefined), {
    message: 'status cannot be combined with title or when',
  });

const idSchema = z.string().uuid('Valid reminder id is required');

const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  upcoming: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const timezoneSchema = z.object({ timezone: z.string().trim().min(1).max(64) }).strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestError('Invalid input payload', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** Identity comes only from the verified session, never from the body, query or path. */
function userId(req: Request): string {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  return req.user.id;
}

export class ReminderController {
  /** POST /api/reminders */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = parse(createSchema, req.body);
      const headerKey = req.header('idempotency-key')?.trim();
      const { reminder, created } = await getReminderService().create(userId(req), {
        title: body.title,
        when: body.when,
        idempotencyKey: body.idempotencyKey ?? (headerKey || undefined),
      });
      res.status(created ? 201 : 200).json({ status: 'success', data: reminder });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/reminders */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = parse(listSchema, req.query);
      const data = await getReminderService().list(userId(req), q);
      res.status(200).json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/reminders/:id */
  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await getReminderService().get(userId(req), parse(idSchema, req.params.id));
      res.status(200).json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /api/reminders/:id — reschedule / retitle, or mark completed */
  static async patch(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parse(idSchema, req.params.id);
      const body = parse(patchSchema, req.body);
      const service = getReminderService();
      const data =
        body.status === 'completed'
          ? await service.complete(userId(req), id)
          : body.status === 'cancelled'
            ? await service.cancel(userId(req), id)
            : await service.update(userId(req), id, { title: body.title, when: body.when });
      res.status(200).json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/reminders/:id — cancels (the record is kept for history) */
  static async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await getReminderService().cancel(userId(req), parse(idSchema, req.params.id));
      res.status(200).json({ status: 'success', data });
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /api/users/me — set the IANA timezone used to interpret reminder times */
  static async setTimezone(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { timezone } = parse(timezoneSchema, req.body);
      const saved = await getReminderService().setTimezone(userId(req), timezone);
      res.status(200).json({ status: 'success', data: { timezone: saved } });
    } catch (err) {
      next(err);
    }
  }
}
