import { z } from 'zod';
import { AppError } from '../../utils/errors';

/** Domain error for scheduling problems. Messages are safe to show to the user and the model. */
export class ReminderError extends AppError {
  constructor(code: string, message: string, statusCode = 422) {
    super(message, statusCode, code);
    this.name = 'ReminderError';
  }
}

// ---------------------------------------------------------------------------------- time zones

// IANA region names only ("Area/Location") or "UTC". The runtime also accepts abbreviations such as
// "IST" (India? Israel? Ireland?) and fixed offsets, which are ambiguous or ignore daylight saving.
const IANA_NAME = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  if (!IANA_NAME.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 0,
    day: out.day ?? 0,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** UTC offset (minutes east of UTC) in effect in `timeZone` at `instant`. */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - wholeSecond) / 60000);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Every instant at which the wall clock in `timeZone` reads date+time:
 * [] for a time skipped by a DST jump, one entry normally, two for a repeated hour.
 */
export function localToInstants(date: string, time: string, timeZone: string): Date[] {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const localMs = Date.UTC(y, mo - 1, d, h, mi);

  const check = new Date(localMs);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== mi
  ) {
    throw new ReminderError('INVALID_DATE', `${date} is not a real calendar date.`);
  }

  const DAY = 86_400_000;
  const offsets = new Set([
    offsetMinutesAt(new Date(localMs - DAY), timeZone),
    offsetMinutesAt(new Date(localMs), timeZone),
    offsetMinutesAt(new Date(localMs + DAY), timeZone),
  ]);
  const instants = new Map<number, Date>();
  for (const offset of offsets) {
    const instant = new Date(localMs - offset * 60_000);
    if (offsetMinutesAt(instant, timeZone) === offset) instants.set(instant.getTime(), instant);
  }
  return [...instants.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** e.g. "Wed, 28 Oct 2026, 10:00 (Asia/Kolkata, UTC+05:30)" */
export function formatInZone(instant: Date, timeZone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return `${text} (${timeZone}, ${formatOffset(offsetMinutesAt(instant, timeZone))})`;
}

// ---------------------------------------------------------------------------------- schedule specs

/**
 * How a caller (user, API client or model) says WHEN. Deliberately structured: free-form phrases like
 * "tomorrow" are resolved by the caller into one of these, and the backend validates and echoes the
 * result back. Nothing here guesses a missing date or time.
 */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('relative'),
      amount: z.number().int().min(1).max(60 * 24 * 366),
      unit: z.enum(['minutes', 'hours']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('local'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be 24-hour HH:mm'),
      disambiguation: z.enum(['earlier', 'later']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('instant'),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export interface ScheduleLimits {
  minLeadSeconds: number;
  maxHorizonDays: number;
}

export interface ResolvedSchedule {
  instant: Date;
  timezone: string;
  /** Human-readable interpretation in the user's timezone. Always shown back to the user. */
  display: string;
  localHour: number;
  daysAhead: number;
}

export function resolveSchedule(
  spec: ScheduleSpec,
  timezone: string,
  now: Date,
  limits: ScheduleLimits
): ResolvedSchedule {
  if (!isValidTimeZone(timezone)) {
    throw new ReminderError('INVALID_TIMEZONE', `"${timezone}" is not a valid IANA timezone.`);
  }

  let instant: Date;
  switch (spec.kind) {
    case 'relative':
      instant = new Date(now.getTime() + spec.amount * (spec.unit === 'minutes' ? 60_000 : 3_600_000));
      break;
    case 'instant':
      instant = new Date(spec.at);
      break;
    case 'local': {
      const candidates = localToInstants(spec.date, spec.time, timezone);
      if (candidates.length === 0) {
        throw new ReminderError(
          'NONEXISTENT_LOCAL_TIME',
          `${spec.time} does not exist on ${spec.date} in ${timezone} because clocks move forward that day. Ask the user for a different time.`
        );
      }
      if (candidates.length === 2) {
        if (!spec.disambiguation) {
          const [a, b] = candidates as [Date, Date];
          throw new ReminderError(
            'AMBIGUOUS_LOCAL_TIME',
            `${spec.time} happens twice on ${spec.date} in ${timezone} (${formatOffset(offsetMinutesAt(a, timezone))} and ${formatOffset(offsetMinutesAt(b, timezone))}). Ask the user whether they mean the earlier or the later one.`
          );
        }
        instant = spec.disambiguation === 'earlier' ? candidates[0]! : candidates[1]!;
      } else {
        instant = candidates[0]!;
      }
      break;
    }
  }

  if (Number.isNaN(instant.getTime())) {
    throw new ReminderError('INVALID_DATE', 'The date and time could not be understood.');
  }
  const leadMs = instant.getTime() - now.getTime();
  if (leadMs < limits.minLeadSeconds * 1000) {
    throw new ReminderError(
      'TIME_IN_PAST',
      `${formatInZone(instant, timezone)} is not in the future. Ask the user for a later time.`
    );
  }
  if (leadMs > limits.maxHorizonDays * 86_400_000) {
    throw new ReminderError(
      'BEYOND_HORIZON',
      `Reminders can be scheduled at most ${limits.maxHorizonDays} days ahead.`
    );
  }

  return {
    instant,
    timezone,
    display: formatInZone(instant, timezone),
    localHour: localParts(instant, timezone).hour,
    daysAhead: leadMs / 86_400_000,
  };
}
