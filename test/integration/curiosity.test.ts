// Integration tests for the curiosity budget (EXECUTION-PLAN §Phase 4):
// src/intelligence/curiosity.ts.
//
//   1. Real gap detection: a customer we hold memories about but have no
//      profile for becomes an open research question, stored as an
//      observation memory (source_resource_type='curiosity_question'), NOT
//      an improvement_proposal.
//   2. The per-day cap (RESEARCH_QUESTION_MAX_PER_DAY) is respected: a
//      re-run on the same day once the cap is reached creates nothing.
//
// The per-day counter lives in KV (curiosity:day:<date>); tests pin the
// date via deps so counters don't collide across tests.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import type { CompleteRequest, CompleteResponse } from "../../src/ai/types";
import { runCuriosity, type Gap } from "../../src/intelligence/curiosity";

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = "cur-tenant";
const CUSTOMER = "cur-acme";

function fakeRouter(text: string): {
  complete: (req: CompleteRequest) => Promise<CompleteResponse>;
} {
  return {
    complete: async (_req: CompleteRequest): Promise<CompleteResponse> => ({
      text,
      model: "fake",
      tier: "deep",
    }),
  };
}

describe("runCuriosity", () => {
  it("turns a profile-less customer into a recorded research question", async () => {
    // A customer we hold a memory about, with no profile row → a gap.
    await testEnv.ARCADIA_DB.prepare(
      `INSERT INTO memories (id, kind, scope_type, scope_id, content, confidence, created_at, updated_at)
       VALUES (?, 'semantic', 'customer', ?, ?, 0.9, datetime('now'), datetime('now'))`,
    )
      .bind(
        "cur-mem-acme",
        CUSTOMER,
        "cur: Acme keeps coming up in the launch channel.",
        )
      .run();

    const res = await runCuriosity(testEnv, log, {
      router: fakeRouter("Who is the primary contact and owner for Acme?"),
      today: "2026-01-01",
      tenantId: TENANT,
      // High caps so the real gap scan reaches our seeded customer regardless
      // of other profile-less customers in the shared D1.
      maxPerCycle: 50,
      maxPerDay: 50,
    });

    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(res.questions.some((q) => q.key === `customer:${CUSTOMER}`)).toBe(
      true,
    );

    // Stored as an observation memory tagged curiosity_question, scope tenant.
    const row = await testEnv.ARCADIA_DB.prepare(
      `SELECT kind, scope_type, scope_id, content
         FROM memories
        WHERE source_resource_type = 'curiosity_question'
          AND source_resource_id = ?`,
    )
      .bind(`customer:${CUSTOMER}`)
      .first<{
        kind: string;
        scope_type: string;
        scope_id: string;
        content: string;
      }>();
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("observation");
    expect(row?.scope_type).toBe("tenant");
    expect(row?.scope_id).toBe(TENANT);
    expect(row?.content).toContain("Acme");

    // It is NOT forced into the proposal queue.
    const prop = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM improvement_proposals WHERE origin = 'curiosity'`,
    ).first<{ n: number }>();
    expect(prop?.n).toBe(0);
  });

  it("respects the per-day cap on re-run", async () => {
    const gaps: Gap[] = [
      { key: "cap:g1", kind: "customer_no_profile", subject: "g1", detail: "gap 1" },
      { key: "cap:g2", kind: "customer_no_profile", subject: "g2", detail: "gap 2" },
      { key: "cap:g3", kind: "customer_no_profile", subject: "g3", detail: "gap 3" },
    ];
    const deps = {
      router: fakeRouter("What is the story behind this gap?"),
      findGaps: async (): Promise<Gap[]> => gaps,
      today: "2026-01-02",
      tenantId: TENANT,
      maxPerCycle: 3,
      maxPerDay: 2,
    };

    // First run: capped by the per-day budget (2), not the per-cycle cap (3).
    const first = await runCuriosity(testEnv, log, deps);
    expect(first.created).toBe(2);
    expect(first.dayCount).toBe(2);
    expect(first.capped).toBe(true);

    // Same-day re-run: the day budget is exhausted → nothing created.
    const second = await runCuriosity(testEnv, log, deps);
    expect(second.created).toBe(0);
    expect(second.dayCount).toBe(2);
    expect(second.capped).toBe(true);
  });
});
