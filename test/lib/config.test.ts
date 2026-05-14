import { describe, expect, it } from "vitest";
import { config } from "../../src/lib/config";
import type { Env } from "../../src/env";

function mockEnv(overrides: Partial<Env> = {}): Env {
  // Cast-free: spread only the fields config() reads.
  return overrides as Env;
}

describe("config", () => {
  it("falls back to defaults when env is empty", () => {
    const c = config(mockEnv());
    expect(c.staleThreadHours).toBe(48);
    expect(c.nudgeCooldownHours).toBe(8);
    expect(c.nudgeMaxPerRun).toBe(5);
    expect(c.cfAiDefaultModel).toBe("@cf/google/gemma-4-26b-a4b-it");
  });

  it("parses numeric overrides", () => {
    const c = config(
      mockEnv({
        STALE_THREAD_HOURS: "72",
        NUDGE_MAX_PER_RUN: "12",
      } as Partial<Env>),
    );
    expect(c.staleThreadHours).toBe(72);
    expect(c.nudgeMaxPerRun).toBe(12);
  });

  it("ignores junk values and uses defaults", () => {
    const c = config(mockEnv({ STALE_THREAD_HOURS: "abc" } as Partial<Env>));
    expect(c.staleThreadHours).toBe(48);
  });
});
