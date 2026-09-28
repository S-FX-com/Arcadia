// Shift patterns post real instances. Graph has no recurrence on a shift
// (verified 27 September 2026 against the v1.0 shift resource). The horizon
// and the time-off skip live here, where they can be tested without Graph.
//
// A shift is at least 1 minute and at most 24 hours. Confirmed time off
// wins: a date that overlaps a confirmed instance is not posted. Pending
// requests are not time off. Availability is not an input.

export const DEFAULT_HORIZON_WEEKS = 8;
export const MAX_HORIZON_WEEKS = 16;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ConfirmedTimeOff {
  userId?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface ShiftInterval {
  start: Date;
  end: Date;
  /** Whole minutes. Always 1..1440 when this object exists. */
  minutes: number;
}

function utcMidnight(date: string): Date | undefined {
  if (!DATE.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 1..16, else the default of eight. A bad config must not post a year of shifts. */
export function clampHorizonWeeks(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HORIZON_WEEKS;
  const weeks = Math.floor(value);
  if (weeks < 1 || weeks > MAX_HORIZON_WEEKS) return DEFAULT_HORIZON_WEEKS;
  return weeks;
}

/**
 * Dates in a rolling window of `weeks` × 7 days starting at `from` (UTC),
 * inclusive, whose weekday is in `weekdays` (0 = Sunday … 6 = Saturday, UTC).
 */
export function horizonDates(from: Date, weeks: number, weekdays: number[]): string[] {
  const window = clampHorizonWeeks(weeks);
  const wanted = new Set(weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dates: string[] = [];
  for (let i = 0; i < window * 7; i++) {
    const day = addUtcDays(start, i);
    if (wanted.has(day.getUTCDay())) dates.push(formatUtcDate(day));
  }
  return dates;
}

/**
 * One shift instance on a calendar date. End time earlier than start time
 * is an overnight shift ending the next UTC day. Equal clock times are
 * refused — that is not a 24-hour shift anyone asked for.
 */
export function shiftInterval(date: string, startTime: string, endTime: string): ShiftInterval | undefined {
  const day = utcMidnight(date);
  const startMatch = CLOCK.exec(startTime);
  const endMatch = CLOCK.exec(endTime);
  if (!day || !startMatch || !endMatch) return undefined;
  const startMin = Number(startMatch[1]) * 60 + Number(startMatch[2]);
  const endMin = Number(endMatch[1]) * 60 + Number(endMatch[2]);
  if (endMin === startMin) return undefined;
  const start = new Date(day.getTime() + startMin * 60_000);
  const end = new Date(day.getTime() + endMin * 60_000 + (endMin < startMin ? 86_400_000 : 0));
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes < 1 || minutes > 24 * 60) return undefined;
  return { start, end, minutes };
}

function parseInstant(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * Split horizon dates into ones to post and ones confirmed time off covers.
 * Time off for a different user does not skip. A time-off row with no
 * parseable range does not skip either — absence of a range is not a day off.
 */
export function skipConfirmedTimeOff(
  userId: string,
  dates: string[],
  startTime: string,
  endTime: string,
  timeOff: ConfirmedTimeOff[]
): { post: string[]; skipped: string[] } {
  const mine = timeOff.filter((row) => row.userId === userId);
  const post: string[] = [];
  const skipped: string[] = [];
  for (const date of dates) {
    const interval = shiftInterval(date, startTime, endTime);
    if (!interval) continue;
    const covered = mine.some((row) => {
      const start = parseInstant(row.startDateTime);
      const end = parseInstant(row.endDateTime);
      if (!start || !end) return false;
      return overlaps(interval.start, interval.end, start, end);
    });
    if (covered) skipped.push(date);
    else post.push(date);
  }
  return { post, skipped };
}

/** Weekday numbers from a form. Drops anything that is not 0–6. */
export function parseWeekdays(values: string[]): number[] {
  const days = new Set<number>();
  for (const value of values) {
    const day = Number(value);
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}
