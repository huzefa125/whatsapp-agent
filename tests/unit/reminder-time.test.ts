import { describe, it, expect } from 'vitest';
import {
  formatInZone,
  formatOffset,
  isValidTimeZone,
  localToInstants,
  offsetMinutesAt,
  ReminderError,
  resolveSchedule,
  scheduleSpecSchema,
  type ScheduleSpec,
} from '../../src/services/reminders/time';
import { normalizeTitle } from '../../src/services/reminders/reminder-service';
import { FakeClock } from '../../src/utils/clock';

const limits = { minLeadSeconds: 5, maxHorizonDays: 365 };
// Tue 27 Oct 2026 12:00:00 UTC == 17:30 in Asia/Kolkata
const NOW = new Date('2026-10-27T12:00:00Z');
const resolve = (spec: ScheduleSpec, tz = 'Asia/Kolkata', now = NOW) => resolveSchedule(spec, tz, now, limits);
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ReminderError).code;
  }
  return 'NO_ERROR';
};

describe('time zones', () => {
  it('validates IANA names without trusting the server zone', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    for (const bad of ['', 'Mars/Base', 'IST', 'EST', '+05:30', 'utc', 'Asia/Kolkata; DROP TABLE users', 'x'.repeat(65)]) {
      expect(isValidTimeZone(bad)).toBe(false);
    }
  });

  it('computes offsets including half-hour zones and DST', () => {
    expect(offsetMinutesAt(NOW, 'Asia/Kolkata')).toBe(330);
    expect(offsetMinutesAt(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe(-240);
    expect(offsetMinutesAt(new Date('2026-12-01T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(formatOffset(330)).toBe('UTC+05:30');
    expect(formatOffset(-300)).toBe('UTC-05:00');
  });

  it('converts local wall time to the right UTC instant', () => {
    expect(localToInstants('2026-10-28', '10:00', 'Asia/Kolkata').map((d) => d.toISOString())).toEqual(['2026-10-28T04:30:00.000Z']);
    expect(localToInstants('2026-07-01', '09:00', 'America/New_York').map((d) => d.toISOString())).toEqual(['2026-07-01T13:00:00.000Z']);
  });

  it('finds no instant for a time skipped by a DST jump', () => {
    // US spring-forward: 2026-03-08 02:00 -> 03:00
    expect(localToInstants('2026-03-08', '02:30', 'America/New_York')).toEqual([]);
    expect(localToInstants('2026-03-08', '03:30', 'America/New_York')).toHaveLength(1);
  });

  it('finds two instants for a repeated hour', () => {
    // US fall-back: 2026-11-01 01:00-02:00 happens twice
    const two = localToInstants('2026-11-01', '01:30', 'America/New_York').map((d) => d.toISOString());
    expect(two).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  });

  it('rejects calendar dates that do not exist', () => {
    expect(codeOf(() => localToInstants('2026-02-30', '10:00', 'Asia/Kolkata'))).toBe('INVALID_DATE');
    expect(codeOf(() => localToInstants('2026-13-01', '10:00', 'Asia/Kolkata'))).toBe('INVALID_DATE');
  });

  it('formats in the user zone with the offset, never the server zone', () => {
    expect(formatInZone(new Date('2026-10-28T04:30:00Z'), 'Asia/Kolkata')).toBe('Wed, 28 Oct 2026, 10:00 (Asia/Kolkata, UTC+05:30)');
    expect(formatInZone(new Date('2026-10-28T04:30:00Z'), 'America/New_York')).toContain('00:30');
  });
});

describe('resolveSchedule', () => {
  it('resolves relative times against the injected clock', () => {
    const r = resolve({ kind: 'relative', amount: 30, unit: 'minutes' });
    expect(r.instant.toISOString()).toBe('2026-10-27T12:30:00.000Z');
    expect(r.display).toBe('Tue, 27 Oct 2026, 18:00 (Asia/Kolkata, UTC+05:30)');
    const clock = new FakeClock(NOW);
    clock.advance(3_600_000);
    expect(resolve({ kind: 'relative', amount: 30, unit: 'minutes' }, 'Asia/Kolkata', clock.now()).instant.toISOString()).toBe('2026-10-27T13:30:00.000Z');
    expect(resolve({ kind: 'relative', amount: 2, unit: 'hours' }).instant.toISOString()).toBe('2026-10-27T14:00:00.000Z');
  });

  it('resolves "tomorrow at 10 AM" given the user local date', () => {
    const r = resolve({ kind: 'local', date: '2026-10-28', time: '10:00' });
    expect(r.instant.toISOString()).toBe('2026-10-28T04:30:00.000Z');
    expect(r.localHour).toBe(10);
    expect(r.timezone).toBe('Asia/Kolkata');
  });

  it('interprets the same wall time differently per user timezone', () => {
    const spec: ScheduleSpec = { kind: 'local', date: '2026-10-28', time: '10:00' };
    expect(resolve(spec, 'Asia/Kolkata').instant.toISOString()).not.toBe(resolve(spec, 'America/New_York').instant.toISOString());
    expect(resolve(spec, 'America/New_York').instant.toISOString()).toBe('2026-10-28T14:00:00.000Z');
  });

  it('accepts an absolute instant with an explicit offset', () => {
    expect(resolve({ kind: 'instant', at: '2026-10-28T10:00:00+05:30' }).instant.toISOString()).toBe('2026-10-28T04:30:00.000Z');
  });

  it('rejects past times, including "today at a time that already passed"', () => {
    expect(codeOf(() => resolve({ kind: 'local', date: '2026-10-27', time: '09:00' }))).toBe('TIME_IN_PAST');
    expect(codeOf(() => resolve({ kind: 'instant', at: '2020-01-01T00:00:00Z' }))).toBe('TIME_IN_PAST');
  });

  it('enforces the minimum lead time and the scheduling horizon', () => {
    expect(codeOf(() => resolve({ kind: 'instant', at: '2026-10-27T12:00:03Z' }))).toBe('TIME_IN_PAST');
    expect(codeOf(() => resolve({ kind: 'instant', at: '2026-10-27T12:00:06Z' }))).toBe('NO_ERROR');
    expect(codeOf(() => resolve({ kind: 'local', date: '2028-01-01', time: '10:00' }))).toBe('BEYOND_HORIZON');
  });

  it('refuses nonexistent local times and asks instead of shifting them', () => {
    const now = new Date('2026-03-01T00:00:00Z');
    const spec: ScheduleSpec = { kind: 'local', date: '2026-03-08', time: '02:30' };
    expect(codeOf(() => resolve(spec, 'America/New_York', now))).toBe('NONEXISTENT_LOCAL_TIME');
  });

  it('requires a choice for ambiguous local times, then honours it', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    const base = { kind: 'local', date: '2026-11-01', time: '01:30' } as const;
    expect(codeOf(() => resolve(base, 'America/New_York', now))).toBe('AMBIGUOUS_LOCAL_TIME');
    expect(resolve({ ...base, disambiguation: 'earlier' }, 'America/New_York', now).instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(resolve({ ...base, disambiguation: 'later' }, 'America/New_York', now).instant.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('rejects invalid timezones rather than falling back to the server zone', () => {
    expect(codeOf(() => resolve({ kind: 'relative', amount: 5, unit: 'minutes' }, 'Nowhere/Land'))).toBe('INVALID_TIMEZONE');
  });
});

describe('scheduleSpecSchema', () => {
  it('accepts well-formed specs', () => {
    expect(scheduleSpecSchema.safeParse({ kind: 'relative', amount: 30, unit: 'minutes' }).success).toBe(true);
    expect(scheduleSpecSchema.safeParse({ kind: 'local', date: '2026-10-28', time: '10:00' }).success).toBe(true);
  });

  it.each([
    [{ kind: 'local', date: 'tomorrow', time: '10:00' }],
    [{ kind: 'local', date: '2026-10-28', time: '10 AM' }],
    [{ kind: 'local', date: '2026-10-28' }], // missing time: never invented
    [{ kind: 'local', date: '2026-10-28', time: '24:30' }],
    [{ kind: 'relative', amount: 0, unit: 'minutes' }],
    [{ kind: 'relative', amount: 1.5, unit: 'hours' }],
    [{ kind: 'relative', amount: 5, unit: 'days' }],
    [{ kind: 'instant', at: '2026-10-28T10:00:00' }], // no offset
    [{ kind: 'local', date: '2026-10-28', time: '10:00', timezone: 'UTC' }], // unknown key
    [{}],
  ])('rejects %j', (spec) => {
    expect(scheduleSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe('normalizeTitle', () => {
  it('collapses whitespace/control characters and refuses empty or oversized text', () => {
    expect(normalizeTitle('  call \n the\tclient\u0000  ', 100)).toBe('call the client');
    expect(codeOf(() => normalizeTitle('   \n ', 100))).toBe('INVALID_TITLE');
    expect(codeOf(() => normalizeTitle('x'.repeat(101), 100))).toBe('TITLE_TOO_LONG');
  });
});
