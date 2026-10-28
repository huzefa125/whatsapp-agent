import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors';
import { ToolError, type ToolDefinition } from '../agent/engine/types';
import { ReminderService, ReminderView } from './reminder-service';
import { ReminderError, scheduleSpecSchema, ScheduleSpec } from './time';

/**
 * Agent tools for reminders. The model proposes structured arguments; the service validates them,
 * and identity is always `ctx.userId` — there is deliberately no userId argument anywhere.
 */

const reminderId = z.string().uuid().describe('Reminder id from list_reminders');

const createInput = z
  .object({
    title: z.string().trim().min(1).max(1000).describe('What to remind the user about, in their words'),
    when: scheduleSpecSchema.describe(
      'When to fire. relative: {kind,amount,unit} for "in 30 minutes". local: {kind,date YYYY-MM-DD,time HH:mm 24h} in the USER\'s timezone. instant: {kind,at ISO-8601 with offset}.'
    ),
  })
  .strict();

const listInput = z
  .object({
    reminderId: reminderId.optional().describe('Return only this reminder, with full details'),
    status: z.enum(['scheduled', 'sent', 'failed', 'cancelled', 'completed']).optional(),
    upcomingOnly: z.boolean().default(true).describe('Only still-scheduled reminders from now on, soonest first'),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

const rescheduleInput = z
  .object({
    reminderId,
    when: scheduleSpecSchema.optional(),
    title: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => v.when !== undefined || v.title !== undefined, { message: 'Provide when and/or title' });

const timezoneInput = z
  .object({ timezone: z.string().trim().min(1).max(64).describe('IANA timezone name, e.g. "Asia/Kolkata" or "America/New_York"') })
  .strict();

const idOnlyInput = z.object({ reminderId }).strict();

/** Domain errors become messages the model may see; anything else stays hidden by the engine. */
function toToolError(err: unknown): never {
  if (err instanceof ReminderError) throw new ToolError(err.code, err.message);
  if (err instanceof NotFoundError) throw new ToolError('REMINDER_NOT_FOUND', 'Reminder not found.');
  if (err instanceof ConflictError) throw new ToolError('INVALID_STATE', err.message);
  throw err;
}

function compact(r: ReminderView) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    scheduledFor: r.remindAtLocal,
    timezone: r.timezone,
    delivery: r.delivery.state,
    ...(r.delivery.simulated ? { simulated: true } : {}),
    ...(r.error ? { error: r.error.code } : {}),
  };
}

export function createReminderTools(service: ReminderService): Array<ToolDefinition<any, any>> {
  /** Surprising interpretations need the user's explicit OK before anything is written. */
  const surprising = async (userId: string, when: ScheduleSpec | undefined): Promise<boolean> => {
    if (!when) return false;
    try {
      const s = await service.previewSchedule(userId, when);
      return s.localHour < 5 || s.daysAhead > service.cfg.confirmBeyondDays;
    } catch {
      return false; // invalid input is reported by execute(); no point asking the user to confirm it
    }
  };
  const describeWhen = async (userId: string, when: ScheduleSpec | undefined): Promise<string> => {
    if (!when) return 'the current time';
    try {
      return (await service.previewSchedule(userId, when)).display;
    } catch {
      return 'the requested time';
    }
  };

  const create: ToolDefinition<z.infer<typeof createInput>, unknown> = {
    name: 'create_reminder',
    description:
      "Schedules a one-time reminder that will be sent to the user on WhatsApp. Requires an exact date and time; never guess a missing one. Returns the interpreted local date, time and timezone to tell the user.",
    inputSchema: createInput,
    permissions: ['reminders:write'],
    sideEffect: 'idempotent', // keyed by the engine's per-call idempotency key
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 0, backoffMs: 0 },
    shouldConfirm: (input, { userId }) => surprising(userId, input.when),
    describeCall: async (input, { userId }) =>
      `Set a reminder "${input.title}" for ${await describeWhen(userId, input.when)}`,
    async execute(input, ctx) {
      try {
        const { reminder, created } = await service.create(ctx.userId, {
          title: input.title,
          when: input.when,
          idempotencyKey: ctx.idempotencyKey,
        });
        return { ...compact(reminder), alreadyExisted: !created };
      } catch (err) {
        return toToolError(err);
      }
    },
  };

  const list: ToolDefinition<z.infer<typeof listInput>, unknown> = {
    name: 'list_reminders',
    description:
      "Lists the user's reminders (upcoming by default) or returns one reminder's details and delivery status when reminderId is given.",
    inputSchema: listInput,
    permissions: ['reminders:read'],
    sideEffect: 'none',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 1, backoffMs: 200 },
    async execute(input, ctx) {
      try {
        if (input.reminderId) {
          return { reminders: [compact(await service.get(ctx.userId, input.reminderId))] };
        }
        const rows = await service.list(ctx.userId, {
          status: input.status,
          upcoming: input.status ? false : input.upcomingOnly,
          limit: input.limit,
          offset: 0,
        });
        return { count: rows.length, reminders: rows.map(compact) };
      } catch (err) {
        return toToolError(err);
      }
    },
  };

  const reschedule: ToolDefinition<z.infer<typeof rescheduleInput>, unknown> = {
    name: 'reschedule_reminder',
    description:
      "Changes the time and/or text of one of the user's scheduled reminders. Find its id with list_reminders first. Never guess a missing date or time.",
    inputSchema: rescheduleInput,
    permissions: ['reminders:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 0, backoffMs: 0 },
    shouldConfirm: (input, { userId }) => surprising(userId, input.when),
    describeCall: async (input, { userId }) =>
      `Move reminder ${input.reminderId.slice(0, 8)} to ${await describeWhen(userId, input.when)}`,
    async execute(input, ctx) {
      try {
        return compact(await service.update(ctx.userId, input.reminderId, { title: input.title, when: input.when }));
      } catch (err) {
        return toToolError(err);
      }
    },
  };

  const cancel: ToolDefinition<z.infer<typeof idOnlyInput>, unknown> = {
    name: 'cancel_reminder',
    description: "Cancels one of the user's reminders so it will not be sent. Find its id with list_reminders first.",
    inputSchema: idOnlyInput,
    permissions: ['reminders:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 0, backoffMs: 0 },
    async execute(input, ctx) {
      try {
        return compact(await service.cancel(ctx.userId, input.reminderId));
      } catch (err) {
        return toToolError(err);
      }
    },
  };

  const complete: ToolDefinition<z.infer<typeof idOnlyInput>, unknown> = {
    name: 'complete_reminder',
    description: "Marks one of the user's reminders as done (e.g. the user says they already did it).",
    inputSchema: idOnlyInput,
    permissions: ['reminders:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 0, backoffMs: 0 },
    async execute(input, ctx) {
      try {
        return compact(await service.complete(ctx.userId, input.reminderId));
      } catch (err) {
        return toToolError(err);
      }
    },
  };

  const setTimezone: ToolDefinition<z.infer<typeof timezoneInput>, unknown> = {
    name: 'set_timezone',
    description:
      "Saves the user's IANA timezone so reminder times can be interpreted. Only call it after the user has told you their city, country or timezone; map it to an IANA name and never guess.",
    inputSchema: timezoneInput,
    permissions: ['reminders:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 8000,
    retry: { maxRetries: 0, backoffMs: 0 },
    async execute(input, ctx) {
      try {
        return { timezone: await service.setTimezone(ctx.userId, input.timezone) };
      } catch (err) {
        if (err instanceof BadRequestError) throw new ToolError('INVALID_TIMEZONE', err.message);
        return toToolError(err);
      }
    },
  };

  return [create, list, reschedule, cancel, complete, setTimezone];
}
