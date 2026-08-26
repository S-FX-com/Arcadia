// Calendar math for the Schedule surface. Date-range bugs are the ones that
// look right until the boundary — every test here targets an edge: the
// Sunday that must wrap back to Monday, the inclusive end of a range, the
// year rollover a month-view "next" has to cross.

import { describe, expect, it } from "vitest";
import {
  approvedDaysByPerson,
  daySpan,
  daysInRange,
  formatDateParam,
  groupByDay,
  isoWithinRange,
  monthRange,
  parseDateParam,
  shiftPeriod,
  weekRange,
} from "../src/lib/schedule";

describe("weekRange", () => {
  it("is Monday–Sunday for a date that falls mid-week", () => {
    const r = weekRange(new Date("2026-08-27T10:00:00Z")); // Thursday
    expect(formatDateParam(r.start)).toBe("2026-08-24"); // Monday
    expect(formatDateParam(r.end)).toBe("2026-08-30"); // Sunday
  });

  it("wraps a Sunday back to its own Monday, not forward", () => {
    const r = weekRange(new Date("2026-08-30T10:00:00Z")); // Sunday
    expect(formatDateParam(r.start)).toBe("2026-08-24");
    expect(formatDateParam(r.end)).toBe("2026-08-30");
  });

  it("is idempotent on the Monday itself", () => {
    const r = weekRange(new Date("2026-08-24T00:00:00Z"));
    expect(formatDateParam(r.start)).toBe("2026-08-24");
  });
});

describe("monthRange", () => {
  it("spans the full calendar month, short months included", () => {
    const feb = monthRange(new Date("2026-02-15T00:00:00Z"));
    expect(formatDateParam(feb.start)).toBe("2026-02-01");
    expect(formatDateParam(feb.end)).toBe("2026-02-28"); // 2026 is not a leap year
  });

  it("handles a 31-day month", () => {
    const aug = monthRange(new Date("2026-08-01T00:00:00Z"));
    expect(formatDateParam(aug.end)).toBe("2026-08-31");
  });
});

describe("shiftPeriod", () => {
  it("steps a week view by 7 days either direction", () => {
    const start = new Date("2026-08-24T00:00:00Z");
    expect(formatDateParam(shiftPeriod("week", start, 1))).toBe("2026-08-31");
    expect(formatDateParam(shiftPeriod("week", start, -1))).toBe("2026-08-17");
  });

  it("steps a month view by a calendar month, crossing a year boundary", () => {
    const dec = new Date("2026-12-15T00:00:00Z");
    expect(formatDateParam(shiftPeriod("month", dec, 1))).toBe("2027-01-01");
    const jan = new Date("2027-01-10T00:00:00Z");
    expect(formatDateParam(shiftPeriod("month", jan, -1))).toBe("2026-12-01");
  });
});

describe("daysInRange", () => {
  it("counts every calendar day inclusive", () => {
    const days = daysInRange(weekRange(new Date("2026-08-27T00:00:00Z")));
    expect(days).toHaveLength(7);
    expect(formatDateParam(days[0]!)).toBe("2026-08-24");
    expect(formatDateParam(days[6]!)).toBe("2026-08-30");
  });
});

describe("parseDateParam / formatDateParam", () => {
  it("round-trips a valid date", () => {
    const fallback = new Date("2000-01-01T00:00:00Z");
    expect(formatDateParam(parseDateParam("2026-08-27", fallback))).toBe("2026-08-27");
  });

  it("falls back on anything malformed, missing, or absent — never throws", () => {
    const fallback = new Date("2000-01-01T00:00:00Z");
    for (const bad of [null, undefined, "", "not-a-date", "2026-13-40", "08/27/2026"]) {
      expect(parseDateParam(bad, fallback).getTime()).toBe(fallback.getTime());
    }
  });
});

describe("isoWithinRange", () => {
  const range = weekRange(new Date("2026-08-27T00:00:00Z")); // Mon 24 – Sun 30

  it("includes both boundary days", () => {
    expect(isoWithinRange("2026-08-24T00:00:00Z", range)).toBe(true);
    expect(isoWithinRange("2026-08-30T23:59:00Z", range)).toBe(true);
  });

  it("excludes the day immediately outside either edge", () => {
    expect(isoWithinRange("2026-08-23T23:59:00Z", range)).toBe(false);
    expect(isoWithinRange("2026-08-31T00:00:00Z", range)).toBe(false);
  });

  it("treats undefined or unparseable input as out of range, not a crash", () => {
    expect(isoWithinRange(undefined, range)).toBe(false);
    expect(isoWithinRange("not a date", range)).toBe(false);
  });
});

describe("groupByDay", () => {
  it("buckets items onto their calendar day and drops undated ones", () => {
    const items = [
      { id: "a", at: "2026-08-24T09:00:00Z" },
      { id: "b", at: "2026-08-24T17:00:00Z" },
      { id: "c", at: "2026-08-25T09:00:00Z" },
      { id: "d", at: undefined },
    ];
    const groups = groupByDay(items, (i) => i.at);
    expect(groups.get("2026-08-24")?.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups.get("2026-08-25")?.map((i) => i.id)).toEqual(["c"]);
    expect([...groups.values()].flat().find((i) => i.id === "d")).toBeUndefined();
  });
});

describe("daySpan", () => {
  it("counts a single day as 1, inclusive of both ends", () => {
    expect(daySpan("2026-08-24", "2026-08-24")).toBe(1);
    expect(daySpan("2026-08-24", "2026-08-25")).toBe(2);
    expect(daySpan("2026-08-24", "2026-08-30")).toBe(7);
  });

  it("returns 0 rather than a negative or NaN on bad input", () => {
    expect(daySpan("not-a-date", "2026-08-24")).toBe(0);
  });
});

describe("approvedDaysByPerson", () => {
  it("sums only approved requests, case-insensitive on email", () => {
    const totals = approvedDaysByPerson([
      { requested_by: "Vicky@S-FX.com", start_date: "2026-08-24", end_date: "2026-08-25", status: "approved" },
      { requested_by: "vicky@s-fx.com", start_date: "2026-09-01", end_date: "2026-09-01", status: "approved" },
      { requested_by: "vicky@s-fx.com", start_date: "2026-09-10", end_date: "2026-09-12", status: "pending" },
      { requested_by: "diego@s-fx.com", start_date: "2026-08-01", end_date: "2026-08-01", status: "declined" },
    ]);
    expect(totals.get("vicky@s-fx.com")).toBe(3); // 2 + 1, pending excluded
    expect(totals.has("diego@s-fx.com")).toBe(false); // declined contributes nothing, not a zero row
  });
});
