// Integration tests for the org pulse (EXECUTION-PLAN §Phase 3 item 1):
// src/intelligence/org-pulse.ts via src/webapp/org-pulse-api.ts.
//
// These seed real tenant-wide signal (channels / digests / decisions / stale
// threads / at-risk tasks / memories) into the shared miniflare D1, then drive
// handleOrgPulse with an injected fake Router. The fake Router returns canned
// sections AND captures the prompt it was handed, so we can assert two things:
//   1. an admin caller gets 200 with the composed (canned) sectioned shape,
//   2. the seeded data actually reached the model (the data-fetch fed the
//      router) — proving the federation runs end to end.
// A non-admin caller must be rejected with 403 before any AI hop.
//
// All rows use an "op-" prefix + a dedicated tenant id so the aggregate
// assertions here can't be perturbed by rows other test files write into the
// same shared D1.

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import type { CompleteRequest, CompleteResponse } from "../../src/ai/types";
import type { OrgPulse } from "../../src/intelligence/org-pulse";
import { handleOrgPulse } from "../../src/webapp/org-pulse-api";
import type { Session } from "../../src/webapp/auth";

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = "op-tenant";
const CH_ACTIVE = "op-channel-active";
const CH_QUIET = "op-channel-quiet";
const DRIVER = "op-user-driver";
const OWNER = "op-user-owner";

const DECISION_TEXT = "Ship the onboarding revamp Tuesday";
const TASK_TITLE = "Finalize the Q3 launch checklist";
const STALE_TOPIC = "Vendor contract redlines";
const ACTIVE_NAME = "Launch Room";
const QUIET_NAME = "Ops Standup";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}
function hoursFromNow(n: number): string {
  return new Date(Date.now() + n * 3600 * 1000).toISOString();
}

async function seed(): Promise<void> {
  const db = testEnv.ARCADIA_DB;

  await db
    .prepare(
      `INSERT INTO users (aad_id, tenant_id, display_name, is_admin)
       VALUES (?, ?, ?, 0), (?, ?, ?, 0)`,
    )
    .bind(DRIVER, TENANT, "Dana Rivera", OWNER, TENANT, "Omar Webb")
    .run();

  await db
    .prepare(
      `INSERT INTO channels
         (channel_id, team_id, tenant_id, service_url, display_name, enabled)
       VALUES (?, 'op-team', ?, 'https://svc', ?, 1),
              (?, 'op-team', ?, 'https://svc', ?, 1)`,
    )
    .bind(CH_ACTIVE, TENANT, ACTIVE_NAME, CH_QUIET, TENANT, QUIET_NAME)
    .run();

  // Active channel: several recent digests → an active workstream.
  for (let i = 0; i < 4; i++) {
    await db
      .prepare(
        `INSERT INTO digests (id, channel_id, body, posted_at)
         VALUES (?, ?, '{}', ?)`,
      )
      .bind(`op-digest-active-${i}`, CH_ACTIVE, daysAgo(i))
      .run();
  }
  // Quiet channel: cadence in the PRIOR window (7-14d ago), silent since →
  // flagged as an unusual silence (inference).
  for (let i = 0; i < 3; i++) {
    await db
      .prepare(
        `INSERT INTO digests (id, channel_id, body, posted_at)
         VALUES (?, ?, '{}', ?)`,
      )
      .bind(`op-digest-quiet-${i}`, CH_QUIET, daysAgo(8 + i))
      .run();
  }

  // Decision in flight, authored by the driver in the active channel.
  await db
    .prepare(
      `INSERT INTO decisions
         (id, channel_id, text, decided_at, decided_by_aad_id, confidence)
       VALUES (?, ?, ?, ?, ?, 0.9)`,
    )
    .bind("op-decision-1", CH_ACTIVE, DECISION_TEXT, daysAgo(1), DRIVER)
    .run();

  // Stale thread in the active channel.
  await db
    .prepare(
      `INSERT INTO threads
         (thread_id, channel_id, topic, last_activity_at, stale_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind("op-thread-1", CH_ACTIVE, STALE_TOPIC, daysAgo(5), daysAgo(2))
    .run();

  // At-risk task: open, owned, deadline within the near window.
  await db
    .prepare(
      `INSERT INTO tasks
         (id, channel_id, title, owner_aad_id, deadline_at, priority, status)
       VALUES (?, ?, ?, ?, ?, 'high', 'open')`,
    )
    .bind("op-task-1", CH_ACTIVE, TASK_TITLE, OWNER, hoursFromNow(6))
    .run();

  // A memory row (seeded per spec; longitudinal signal in the same tenant).
  await db
    .prepare(
      `INSERT INTO memories (id, kind, scope_type, scope_id, content, occurred_at)
       VALUES (?, 'observation', 'channel', ?, ?, ?)`,
    )
    .bind(
      "op-memory-1",
      CH_ACTIVE,
      "Dana tends to drive launch decisions late in the week.",
      daysAgo(1),
    )
    .run();
}

interface FakeRouter {
  complete: (req: CompleteRequest) => Promise<CompleteResponse>;
  lastPrompt: () => string;
}

function fakeRouter(): FakeRouter {
  let captured = "";
  const canned = JSON.stringify({
    summary: "Canned org summary.",
    sections: [
      { title: "Active workstreams", bullets: ["canned workstream bullet"] },
      { title: "Decisions in flight", bullets: ["canned decision bullet"] },
    ],
  });
  return {
    complete: async (req: CompleteRequest): Promise<CompleteResponse> => {
      captured = req.messages.map((m) => m.content).join("\n");
      return { text: canned, model: "fake", tier: "deep" };
    },
    lastPrompt: () => captured,
  };
}

function session(aadId: string, isAdmin: boolean): Session {
  const base: Session = {
    aadId,
    tenantId: TENANT,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return isAdmin ? { ...base, isAdmin: true } : base;
}

function pulseRequest(): Request {
  return new Request("https://arcadia.test/api/webapp/org-pulse");
}

describe("GET /api/webapp/org-pulse", () => {
  it("admin: 200 with composed sections, and seeded data reaches the router", async () => {
    await seed();
    const router = fakeRouter();

    const res = await handleOrgPulse(
      pulseRequest(),
      testEnv,
      session("op-admin", true),
      log,
      { router },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgPulse;

    // Composed shape comes from the (fake) router.
    expect(body.summary).toBe("Canned org summary.");
    expect(body.sections.map((s) => s.title)).toEqual([
      "Active workstreams",
      "Decisions in flight",
    ]);

    // Counts reflect the deterministic federation over seeded D1.
    expect(body.counts.activeWorkstreams).toBeGreaterThanOrEqual(1);
    expect(body.counts.decisionsInFlight).toBeGreaterThanOrEqual(1);
    expect(body.counts.stalledThreads).toBeGreaterThanOrEqual(1);
    expect(body.counts.atRiskTasks).toBeGreaterThanOrEqual(1);
    expect(body.counts.unusualSilences).toBeGreaterThanOrEqual(1);

    // The prompt handed to the router carries the seeded signal — proof the
    // data-fetch fed the model.
    const prompt = router.lastPrompt();
    expect(prompt).toContain(ACTIVE_NAME);
    expect(prompt).toContain(DECISION_TEXT);
    expect(prompt).toContain(TASK_TITLE);
    expect(prompt).toContain(STALE_TOPIC);
    expect(prompt).toContain("Dana Rivera"); // workstream driver
    expect(prompt).toContain(QUIET_NAME); // unusual silence (inference)
    expect(prompt.toLowerCase()).toContain("inference");
  });

  it("non-admin: 403, and the router is never called", async () => {
    const router = fakeRouter();
    const spy = vi.spyOn(router, "complete");

    const res = await handleOrgPulse(
      pulseRequest(),
      testEnv,
      session("op-nonadmin", false),
      log,
      { router },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods with 405", async () => {
    const res = await handleOrgPulse(
      new Request("https://arcadia.test/api/webapp/org-pulse", {
        method: "POST",
      }),
      testEnv,
      session("op-admin", true),
      log,
      { router: fakeRouter() },
    );
    expect(res.status).toBe(405);
  });
});
