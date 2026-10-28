import { suggestTimezoneFromPhone } from './phone-timezone';
import { getConfig } from '../../config/env';
import { Reminder } from '../../db/schema';
import { BadRequestError, ConflictError } from '../../utils/errors';
import { Clock, systemClock } from '../../utils/clock';
import { logger } from '../../utils/logger';
import type { ParsedStatusEvent } from '../whatsapp/types';
import { ReminderRepository, ReminderStatus } from './reminder-repository';
import {
  formatInZone,
  isValidTimeZone,
  ReminderError,
  resolveSchedule,
  ResolvedSchedule,
  ScheduleSpec,
} from './time';

export interface ReminderConfig {
  maxTitleChars: number;
  maxHorizonDays: number;
  minLeadSeconds: number;
  maxActivePerUser: number;
  maxCreatesPerHour: number;
  maxAttempts: number;
  confirmBeyondDays: number;
}

export function reminderConfigFromEnv(): ReminderConfig {
  const c = getConfig();
  return {
    maxTitleChars: c.REMINDER_MAX_TITLE_CHARS,
    maxHorizonDays: c.REMINDER_MAX_HORIZON_DAYS,
    minLeadSeconds: c.REMINDER_MIN_LEAD_SECONDS,
    maxActivePerUser: c.REMINDER_MAX_ACTIVE_PER_USER,
    maxCreatesPerHour: c.REMINDER_MAX_CREATES_PER_HOUR,
    maxAttempts: c.REMINDER_MAX_ATTEMPTS,
    confirmBeyondDays: c.REMINDER_CONFIRM_BEYOND_DAYS,
  };
}

export type DeliveryState = 'not_sent' | 'accepted_by_provider' | 'delivered' | 'failed';

/** Public shape of a reminder. Internal lease/locking fields are never exposed. */
export interface ReminderView {
  id: string;
  title: string;
  status: ReminderStatus;
  remindAt: string;
  remindAtLocal: string;
  timezone: string;
  delivery: {
    state: DeliveryState;
    /** true when the provider was the mock: nothing was actually sent to WhatsApp. */
    simulated: boolean;
    provider: string | null;
    acceptedAt: string | null;
    deliveredAt: string | null;
  };
  attempts: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export function toReminderView(r: Reminder): ReminderView {
  const state: DeliveryState = r.deliveredAt
    ? 'delivered'
    : r.status === 'failed'
      ? 'failed'
      : r.acceptedAt
        ? 'accepted_by_provider'
        : 'not_sent';
  return {
    id: r.id,
    title: r.title,
    status: r.status as ReminderStatus,
    remindAt: r.remindAt.toISOString(),
    remindAtLocal: formatInZone(r.remindAt, r.timezone),
    timezone: r.timezone,
    delivery: {
      state,
      simulated: r.deliveryProvider === 'mock',
      provider: r.deliveryProvider,
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    },
    attempts: r.attempts,
    error: r.lastErrorCode ? { code: r.lastErrorCode, message: r.lastErrorMessage ?? '' } : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]+/g;

export function normalizeTitle(raw: string, maxChars: number): string {
  const title = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!title) throw new ReminderError('INVALID_TITLE', 'A reminder needs some text.');
  if (title.length > maxChars) {
    // Never truncate silently: the user would receive a different reminder than they wrote.
    throw new ReminderError('TITLE_TOO_LONG', `Reminder text must be at most ${maxChars} characters.`);
  }
  return title;
}

export interface ServiceDeps {
  repo?: ReminderRepository;
  clock?: Clock;
  config?: Partial<ReminderConfig>;
}

export class ReminderService {
  readonly repo: ReminderRepository;
  readonly clock: Clock;
  readonly cfg: ReminderConfig;

  constructor(deps: ServiceDeps = {}) {
    this.repo = deps.repo ?? new ReminderRepository();
    this.clock = deps.clock ?? systemClock;
    this.cfg = { ...reminderConfigFromEnv(), ...deps.config };
  }

  // ---------------------------------------------------------------- timezone

  /** The user's configured timezone. Never falls back to the server's. */
  async getTimezone(userId: string): Promise<string | null> {
    const user = await this.repo.getUser(userId);
    return user?.timezone ?? null;
  }

  async setTimezone(userId: string, timezone: string): Promise<string> {
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestError('timezone must be a valid IANA timezone such as "Asia/Kolkata"');
    }
    await this.repo.setUserTimezone(userId, timezone);
    return timezone;
  }

  private async requireTimezone(userId: string): Promise<string> {
    const tz = await this.getTimezone(userId);
    if (!tz) {
      throw new ReminderError(
        'TIMEZONE_REQUIRED',
        'The user has not set a timezone, so times cannot be interpreted. They must set one first (ask them, then use set_timezone).'
      );
    }
    return tz;
  }

  // ---------------------------------------------------------------- operations

  /** Validates and interprets a schedule without creating anything. */
  async previewSchedule(userId: string, when: ScheduleSpec): Promise<ResolvedSchedule> {
    const tz = await this.requireTimezone(userId);
    return resolveSchedule(when, tz, this.clock.now(), {
      minLeadSeconds: this.cfg.minLeadSeconds,
      maxHorizonDays: this.cfg.maxHorizonDays,
    });
  }

  async create(
    userId: string,
    input: { title: string; when: ScheduleSpec; idempotencyKey?: string | undefined }
  ): Promise<{ reminder: ReminderView; created: boolean }> {
    const title = normalizeTitle(input.title, this.cfg.maxTitleChars);
    const schedule = await this.previewSchedule(userId, input.when);

    const { reminder, created } = await this.repo.create({
      userId,
      title,
      remindAt: schedule.instant,
      timezone: schedule.timezone,
      idempotencyKey: input.idempotencyKey ?? null,
      maxAttempts: this.cfg.maxAttempts,
      maxActive: this.cfg.maxActivePerUser,
      maxCreatesPerHour: this.cfg.maxCreatesPerHour,
    });

    if (!created && (reminder.title !== title || reminder.remindAt.getTime() !== schedule.instant.getTime())) {
      // A replay with relative times legitimately computes a slightly different instant; only reject
      // when the caller pinned an absolute time and it differs.
      if (input.when.kind !== 'relative' || reminder.title !== title) {
        throw new ConflictError('Idempotency key was already used with a different reminder');
      }
    }
    if (created) logger.info({ reminderId: reminder.id, userId }, 'Reminder created');
    return { reminder: toReminderView(reminder), created };
  }

  async get(userId: string, id: string): Promise<ReminderView> {
    const r = await this.repo.get(userId, id);
    if (!r) throw new ReminderError('REMINDER_NOT_FOUND', 'Reminder not found.', 404);
    return toReminderView(r);
  }

  async list(
    userId: string,
    p: { status?: ReminderStatus | undefined; upcoming?: boolean | undefined; limit: number; offset: number }
  ): Promise<ReminderView[]> {
    const rows = await this.repo.list(userId, {
      status: p.status,
      upcomingFrom: p.upcoming ? this.clock.now() : undefined,
      limit: p.limit,
      offset: p.offset,
    });
    return rows.map(toReminderView);
  }

  async update(
    userId: string,
    id: string,
    patch: { title?: string | undefined; when?: ScheduleSpec | undefined }
  ): Promise<ReminderView> {
    if (patch.title === undefined && patch.when === undefined) {
      throw new BadRequestError('Provide a new title and/or a new schedule');
    }
    const title = patch.title === undefined ? undefined : normalizeTitle(patch.title, this.cfg.maxTitleChars);
    await this.assertExists(userId, id);

    if (patch.when) {
      const schedule = await this.previewSchedule(userId, patch.when);
      const r = await this.repo.reschedule(userId, id, { remindAt: schedule.instant, timezone: schedule.timezone, title });
      logger.info({ reminderId: id, userId }, 'Reminder rescheduled');
      return toReminderView(r);
    }
    return toReminderView(await this.repo.updateTitle(userId, id, title as string));
  }

  async cancel(userId: string, id: string): Promise<ReminderView> {
    await this.assertExists(userId, id);
    const r = await this.repo.cancel(userId, id, this.clock.now());
    logger.info({ reminderId: id, userId }, 'Reminder cancelled');
    return toReminderView(r);
  }

  async complete(userId: string, id: string): Promise<ReminderView> {
    await this.assertExists(userId, id);
    const r = await this.repo.complete(userId, id, this.clock.now());
    logger.info({ reminderId: id, userId }, 'Reminder completed');
    return toReminderView(r);
  }

  private async assertExists(userId: string, id: string): Promise<void> {
    // Same 404 for "missing" and "someone else's", so IDs cannot be probed.
    if (!(await this.repo.get(userId, id))) throw new ReminderError('REMINDER_NOT_FOUND', 'Reminder not found.', 404);
  }

  // ---------------------------------------------------------------- provider webhooks

  /** Applies a WhatsApp status webhook. Only touches reminders we sent through the real provider. */
  async recordProviderStatus(event: ParsedStatusEvent): Promise<number> {
    const updated = await this.repo.recordProviderStatus(
      event.providerMessageId,
      event.status,
      event.timestamp,
      event.errors?.[0]?.code
    );
    if (updated > 0) {
      logger.info({ status: event.status, updated }, 'Applied WhatsApp status to reminder');
    }
    return updated;
  }

  // ---------------------------------------------------------------- agent prompt context

  /** Extra system-prompt text so the model resolves "tomorrow" etc. against the user's real local date. */
  async buildAgentContext(userId: string): Promise<string> {
    const now = this.clock.now();
    const user = await this.repo.getUser(userId);
    const tz = user?.timezone ?? null;
    const guess = !tz && user ? suggestTimezoneFromPhone(user.phoneNumber) : null;
    const askHint = guess
      ? `Their phone number suggests ${guess}, but that is only a guess: ask ONE short question to confirm it (e.g. "Are you on ${guess} time?"). Call set_timezone only after they say yes (or give a different place).`
      : 'Ask which city or timezone they are in, then call set_timezone with the matching IANA name.';
    const header = tz
      ? `Reminder context:\n- Current time (UTC): ${now.toISOString()}\n- The user's timezone: ${tz}. Their local time now: ${formatInZone(now, tz)}.`
      : `Reminder context:\n- The user has NOT set a timezone. Do not schedule reminders yet. ${askHint} Then continue with their request.`;
    return `${header}
- To schedule, call create_reminder. Use when.kind="relative" for "in 30 minutes"; use when.kind="local" with the user's LOCAL date (YYYY-MM-DD, derived from their local date above) and a 24-hour HH:mm time for things like "tomorrow at 10 AM".
- NEVER guess a missing date, time or AM/PM. If anything is unclear, ask one short clarification question instead of calling a tool.
- After a reminder tool succeeds, tell the user the exact local date, time and timezone the tool returned.
- To change or cancel a reminder, first call list_reminders to find its id. If several could match, ask which one.`;
  }
}

let active: ReminderService | null = null;

export function getReminderService(): ReminderService {
  if (!active) active = new ReminderService();
  return active;
}

export function setReminderServiceForTesting(service: ReminderService | null): void {
  active = service;
}
