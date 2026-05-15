import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/lib/logger";

interface MockEnv {
  LOG_LEVEL?: string;
}

describe("logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("emits a JSON line at info level by default", () => {
    const log = logger({});
    log.info("hello", { x: 1 });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(line.level).toBe("info");
    expect(line.event).toBe("hello");
    expect(line.x).toBe(1);
    expect(typeof line.ts).toBe("string");
  });

  it("threads requestId through every line", () => {
    const log = logger({ requestId: "rq_abc" });
    log.warn("evt");
    const line = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(line.requestId).toBe("rq_abc");
  });

  it("filters by level threshold", () => {
    const env: MockEnv = { LOG_LEVEL: "warn" };
    const log = logger({ env });
    log.info("skipped");
    log.warn("kept");
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(line.event).toBe("kept");
  });

  it("child inherits base fields", () => {
    const log = logger({ base: { service: "arcadia" } }).child({ tenant: "t1" });
    log.info("e");
    const line = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(line.service).toBe("arcadia");
    expect(line.tenant).toBe("t1");
  });

  it("accepts interface-shaped fields (LogFields union with object)", () => {
    interface Result {
      considered: number;
      ok: boolean;
    }
    const r: Result = { considered: 3, ok: true };
    const log = logger({});
    // Should compile under exactOptionalPropertyTypes via the
    // LogFields = Record<string, unknown> | object union.
    log.info("typed", r);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });
});
