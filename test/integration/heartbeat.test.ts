// Integration tests for the daily heartbeat (EXECUTION-PLAN §Phase 4):
// src/intelligence/heartbeat.ts.
//
// Seed tasks / users into a dedicated tenant, run runHeartbeat, and assert:
//   1. a structured report is persisted (observation memory,
//      source_resource_type='heartbeat', scope tenant),
//   2. the report records the seeded at-risk conditions — an unowned
//      high-priority task, an approaching deadline, and a silent user.
//
// The heartbeat records opportunities (it does not act / propose); the
// org-pulse surfaces them. A dedicated tenant + channel isolate the seeded
// rows from the shared miniflare D1.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { runHeartbeat } from "../../src/intelligence/heartbeat";

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = "hb-tenant";
const CH = "hb-channel";
const SILENT_USER = "hb-user-silent";
const OWNER = "hb-user-owner";

const UNOWNED_TITLE = "hb: Approve the vendor SOW";
const DEADLINE_TITLE = "hb: Ship the release notes";

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
      `INSERT INTO users (aad_id, tenant_id, display_name, last_seen_at)
       VALUES (?, ?, 'Sam Quiet', ?), (?, ?, 'Olive Owner', ?)`,
    )
    .bind(SILENT_USER, TENANT, daysAgo(30), OWNER, TENANT, daysAgo(1))
    .run();

  await db
    .prepare(
      `INSERT INTO channels
         (channel_id, team_id, tenant_id, service_url, display_name, enabled)
       VALUES (?, 'hb-team', ?, 'https://svc', 'HB Room', 1)`,
    )
    .bind(CH, TENANT)
    .run();

  // Unowned high-priority task.
  await db
    .prepare(
      `INSERT INTO tasks (id, channel_id, title, owner_aad_id, priority, status)
       VALUES (?, ?, ?, NULL, 'high', 'open')`,
    )
    .bind("hb-task-unowned", CH, UNOWNED_TITLE)
    .run();

  // Owned task with a deadline inside the near window.
  await db
    .prepare(
      `INSERT INTO tasks
         (id, channel_id, title, owner_aad_id, deadline_at, priority, status)
       VALUES (?, ?, ?, ?, ?, 'normal', 'open')`,
    )
    .bind("hb-task-deadline", CH, DEADLINE_TITLE, OWNER, hoursFromNow(6))
    .run();
}

describe("runHeartbeat", () => {
  it("persists a report and records seeded at-risk conditions", async () => {
    await seed();

    const report = await runHeartbeat(testEnv, log, { tenantId: TENANT });

    // A report memory row is persisted with the exact id returned.
    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT kind, scope_type, scope_id, source_resource_type, content
         FROM memories WHERE id = ?`,
    )
      .bind(report.memoryId)
      .first<{
        kind: string;
        scope_type: string;
        scope_id: string;
        source_resource_type: string;
        content: string;
      }>();
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("observation");
    expect(row?.scope_type).toBe("tenant");
    expect(row?.scope_id).toBe(TENANT);
    expect(row?.source_resource_type).toBe("heartbeat");

    // Opportunities cover the seeded conditions.
    const unowned = report.opportunities.find(
      (o) => o.kind === "unowned_high_priority" && o.ref === "hb-task-unowned",
    );
    expect(unowned).toBeDefined();
    expect(unowned?.detail).toContain(UNOWNED_TITLE);

    const deadline = report.opportunities.find(
      (o) => o.kind === "approaching_deadline" && o.ref === "hb-task-deadline",
    );
    expect(deadline).toBeDefined();

    const silent = report.opportunities.find(
      (o) => o.kind === "silent_user" && o.ref === SILENT_USER,
    );
    expect(silent).toBeDefined();
    expect(silent?.detail.toLowerCase()).toContain("inference");

    // The persisted payload carries the same opportunities.
    const payload = JSON.parse(row?.content ?? "{}") as {
      opportunities?: unknown[];
    };
    expect(Array.isArray(payload.opportunities)).toBe(true);
    expect((payload.opportunities ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
