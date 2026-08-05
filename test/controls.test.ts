import { describe, expect, it } from "vitest";
import { nextPublishWindowStart, withinPublishWindow } from "../src/lib/controls";

const env = {
  PUBLISH_TZ: "America/New_York",
  PUBLISH_WINDOW: "09:00-17:00",
} as Parameters<typeof withinPublishWindow>[0];

describe("withinPublishWindow", () => {
  it("is true mid-morning on a weekday (EDT)", () => {
    // Wed 2026-08-05 14:30 UTC = 10:30 EDT
    expect(withinPublishWindow(env, new Date("2026-08-05T14:30:00Z"))).toBe(true);
  });

  it("is false before opening", () => {
    // Wed 2026-08-05 12:00 UTC = 08:00 EDT
    expect(withinPublishWindow(env, new Date("2026-08-05T12:00:00Z"))).toBe(false);
  });

  it("is false after closing", () => {
    // Wed 2026-08-05 22:00 UTC = 18:00 EDT
    expect(withinPublishWindow(env, new Date("2026-08-05T22:00:00Z"))).toBe(false);
  });

  it("is false on weekends even during business hours", () => {
    // Sat 2026-08-08 15:00 UTC = 11:00 EDT
    expect(withinPublishWindow(env, new Date("2026-08-08T15:00:00Z"))).toBe(false);
  });

  it("handles EST (winter) offsets", () => {
    // Mon 2026-01-05 15:00 UTC = 10:00 EST
    expect(withinPublishWindow(env, new Date("2026-01-05T15:00:00Z"))).toBe(true);
    // Mon 2026-01-05 13:30 UTC = 08:30 EST
    expect(withinPublishWindow(env, new Date("2026-01-05T13:30:00Z"))).toBe(false);
  });
});

describe("nextPublishWindowStart", () => {
  it("lands inside the window", () => {
    const from = new Date("2026-08-07T22:00:00Z"); // Fri 18:00 EDT — after close
    const next = nextPublishWindowStart(env, from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(withinPublishWindow(env, next)).toBe(true);
  });

  it("skips the weekend from Friday evening", () => {
    const from = new Date("2026-08-07T22:00:00Z"); // Fri evening
    const next = nextPublishWindowStart(env, from);
    // Next window is Monday 2026-08-10 — at least 2 days out.
    expect(next.getTime() - from.getTime()).toBeGreaterThan(2 * 24 * 3600 * 1000);
  });
});
