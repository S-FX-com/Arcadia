import { describe, expect, it } from "vitest";
import { daysStalled, type SignalReading } from "../src/radar/signals";
import { isPublicHttpUrl } from "../src/certification/verify";

const NOW = Date.parse("2026-08-05T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("daysStalled", () => {
  it("measures from the freshest available signal", () => {
    const readings: SignalReading[] = [
      { kind: "git", lastActivityAt: daysAgo(9), detail: "", available: true },
      { kind: "planner", lastActivityAt: daysAgo(2), detail: "", available: true },
    ];
    expect(daysStalled(readings, NOW)).toBe(2);
  });

  it("ignores unavailable signals — a missing credential is not a stall", () => {
    const readings: SignalReading[] = [
      { kind: "git", lastActivityAt: daysAgo(8), detail: "", available: true },
      { kind: "planner", lastActivityAt: daysAgo(0), detail: "no Graph creds", available: false },
    ];
    expect(daysStalled(readings, NOW)).toBe(8);
  });

  it("returns undefined when nothing is readable, so silence never reads as progress", () => {
    const readings: SignalReading[] = [
      { kind: "planner", detail: "no Graph creds", available: false },
      { kind: "git", detail: "no repo configured", available: false },
    ];
    expect(daysStalled(readings, NOW)).toBeUndefined();
  });

  it("returns undefined when signals are readable but carry no activity timestamp", () => {
    const readings: SignalReading[] = [
      { kind: "staging_diff", fingerprint: "abc", detail: "unchanged", available: true },
    ];
    expect(daysStalled(readings, NOW)).toBeUndefined();
  });

  it("crosses the day-3, day-5 and day-7 rungs at the right points", () => {
    const at = (d: number) =>
      daysStalled([{ kind: "git", lastActivityAt: daysAgo(d), detail: "", available: true }], NOW);
    expect(at(2)).toBeLessThan(3);
    expect(at(3)).toBe(3);
    expect(at(5)).toBe(5);
    expect(at(7)).toBe(7);
  });
});

describe("isPublicHttpUrl (SSRF guard on verifier targets)", () => {
  it("allows ordinary public URLs", () => {
    expect(isPublicHttpUrl("https://www.s-fx.com/how-do-i/thing")).toBe(true);
    expect(isPublicHttpUrl("http://staging.example.com")).toBe(true);
  });

  it("blocks loopback, link-local and private ranges", () => {
    expect(isPublicHttpUrl("http://localhost:8787")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/")).toBe(false);
    expect(isPublicHttpUrl("http://10.0.0.5/")).toBe(false);
    expect(isPublicHttpUrl("http://172.16.4.1/")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.1.1/")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isPublicHttpUrl("http://[::1]/")).toBe(false);
    expect(isPublicHttpUrl("http://box.internal/")).toBe(false);
  });

  it("blocks non-http schemes and junk", () => {
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("not a url")).toBe(false);
  });
});
