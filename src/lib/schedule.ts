// Calendar shaping for the Schedule surface (Teams Shifts). Pure date math and
// grouping, free of Cloudflare imports so every rule here is directly
// testable — the same discipline src/lib/planner.ts uses, for the same
// reason: a calendar that puts a shift on the wrong day is worse than no
// calendar, because it looks authoritative.
//
// Calendar days are computed on the UTC calendar, matching planner.ts's
// calendarDaysUntil — Graph datetimes are UTC, and comparing on the same
// calendar the data was written in is the comparison a human reading a date
// actually means.

export type CalendarView = "week" | "month";

export interface DateRange {
  start: Date;
  end: Date;
}

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

/** YYYY-MM-DD, UTC. The one param format every Schedule route uses. */
export function formatDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parses YYYY-MM-DD as a UTC midnight instant; anything else falls back to now. */
export function parseDateParam(value: string | null | undefined, fallback: Date): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** Monday–Sunday, the week containing `date`. */
export function weekRange(date: Date): DateRange {
  const day = date.getUTCDay(); // 0 = Sunday
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset);
  const end = utcDate(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6);
  return { start, end };
}

/** The full calendar month containing `date`. */
export function monthRange(date: Date): DateRange {
  const start = utcDate(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
  return { start, end };
}

export function rangeFor(view: CalendarView, date: Date): DateRange {
  return view === "month" ? monthRange(date) : weekRange(date);
}

/** One step forward or back, sized to the view — a week for week view, a full month for month view. */
export function shiftPeriod(view: CalendarView, date: Date, direction: 1 | -1): Date {
  return view === "month"
    ? utcDate(date.getUTCFullYear(), date.getUTCMonth() + direction, 1)
    : utcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 7 * direction);
}

/** Every calendar day in the range, inclusive, for laying out a grid. */
export function daysInRange(range: DateRange): Date[] {
  const days: Date[] = [];
  let cursor = range.start;
  while (cursor.getTime() <= range.end.getTime()) {
    days.push(cursor);
    cursor = utcDate(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1);
  }
  return days;
}

/** True when an ISO datetime's calendar day falls inside the range (inclusive), UTC. */
export function isoWithinRange(iso: string | undefined, range: DateRange): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  const day = utcDate(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return day.getTime() >= range.start.getTime() && day.getTime() <= range.end.getTime();
}

/** Groups items onto the calendar day their start time falls on. Undated or out-of-range items are dropped by the caller before this runs. */
export function groupByDay<T>(items: T[], startOf: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const iso = startOf(item);
    if (!iso) continue;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) continue;
    const key = formatDateParam(utcDate(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/** Calendar days spanned by a date range, inclusive — the count a time-off total is built from. */
export function daySpan(startDate: string, endDate: string): number {
  const start = parseDateParam(startDate, new Date(NaN));
  const end = parseDateParam(endDate, new Date(NaN));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
}

export interface TimeOffLike {
  requested_by: string;
  start_date: string;
  end_date: string;
  status: string;
}

/** Approved days off per person — the only status that counts toward a total a human should read as real. */
export function approvedDaysByPerson(requests: TimeOffLike[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const r of requests) {
    if (r.status !== "approved") continue;
    const email = r.requested_by.toLowerCase();
    totals.set(email, (totals.get(email) ?? 0) + daySpan(r.start_date, r.end_date));
  }
  return totals;
}

/** Short, human day label — "Mon 9/1" — the grid header format. */
export function dayLabel(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

/** HH:MM from an ISO datetime, UTC — shift times render in the tenant's own clock upstream of this module if ever needed; UTC keeps the math this module owns simple and honest about what it knows. */
export function timeLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toISOString().slice(11, 16);
}
