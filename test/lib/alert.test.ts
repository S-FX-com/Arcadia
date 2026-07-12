import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alert } from "../../src/lib/alert";
import type { Env } from "../../src/env";

// Unit test (node env): fetch is stubbed. Verifies alert() always logs at
// error level, POSTs when ALERT_WEBHOOK_URL is set, and never throws — whether
// the URL is unset or the webhook fetch rejects.

function env(url?: string): Pick<Env, "ALERT_WEBHOOK_URL" | "LOG_LEVEL"> {
  return url ? { ALERT_WEBHOOK_URL: url } : {};
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("alert", () => {
  it("logs at error level and POSTs when a webhook URL is set", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response("ok", { status: 200 });
      }),
    );

    await alert(env("https://hooks.example/alert"), "cron_unhandled", {
      cron: "0 8 * * *",
      error: "boom",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example/alert");
    const payload = calls[0]!.body as { event: string; detail: { error: string } };
    expect(payload.event).toBe("cron_unhandled");
    expect(payload.detail.error).toBe("boom");

    // Error-level log line emitted.
    const errLine = consoleSpy.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((l) => l.event === "cron_unhandled");
    expect(errLine.level).toBe("error");
  });

  it("does not POST and does not throw when no webhook URL is set", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(alert(env(), "queue_unhandled", { queue: "q" })).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw when the webhook fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      alert(env("https://hooks.example/alert"), "cron_step_failed", { step: "digest" }),
    ).resolves.toBeUndefined();
  });
});
