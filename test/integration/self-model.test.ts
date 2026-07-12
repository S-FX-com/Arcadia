// Integration tests for the weekly self-model (EXECUTION-PLAN §Phase 4):
// src/memory/self-model.ts.
//
// Seed the week's high-signal memories, run SelfModel.regenerate with an
// injected fake Router (Vectorize + Workers AI are not simulatable under
// miniflare), and assert:
//   1. the seeded memories reach the model (the input read feeds the router),
//   2. an active self-model is persisted (kind='procedural', scope tenant,
//      source_resource_type='self_model'),
//   3. a second regenerate supersedes the first — exactly one active row,
//      history retained,
//   4. current() / inject() reflect the active model.
//
// A dedicated tenant id isolates these rows from anything else in the shared
// miniflare D1.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import type { CompleteRequest, CompleteResponse } from "../../src/ai/types";
import { SelfModel } from "../../src/memory/self-model";

const testEnv = env as unknown as Env;
const log = logger();

const TENANT = "sm-tenant";
const FACT_A = "sm: Dana leads the launch workstream and drives Tuesday decisions.";
const OBS_B = "sm: Mike goes quiet when overloaded; silence signals blocked work.";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
}

async function seedMemories(): Promise<void> {
  const db = testEnv.ARCADIA_DB;
  await db
    .prepare(
      `INSERT INTO memories (id, kind, scope_type, scope_id, content, confidence, created_at, updated_at)
       VALUES (?, 'semantic', 'channel', 'sm-ch', ?, 0.95, ?, ?),
              (?, 'observation', 'user', 'sm-user', ?, 0.8, ?, ?)`,
    )
    .bind(
      "sm-mem-a",
      FACT_A,
      daysAgo(1),
      daysAgo(1),
      "sm-mem-b",
      OBS_B,
      daysAgo(2),
      daysAgo(2),
    )
    .run();
}

interface FakeRouter {
  complete: (req: CompleteRequest) => Promise<CompleteResponse>;
  lastPrompt: () => string;
}

function fakeRouter(text: string): FakeRouter {
  let captured = "";
  return {
    complete: async (req: CompleteRequest): Promise<CompleteResponse> => {
      captured =
        (req.system ?? "") +
        "\n" +
        req.messages.map((m) => m.content).join("\n");
      return { text, model: "fake", tier: "deep" };
    },
    lastPrompt: () => captured,
  };
}

async function activeRows(): Promise<{ count: number; content: string | null }> {
  const rows = await testEnv.ARCADIA_DB.prepare(
    `SELECT content FROM memories
      WHERE scope_type = 'tenant' AND scope_id = ?
        AND kind = 'procedural'
        AND source_resource_type = 'self_model'`,
  )
    .bind(TENANT)
    .all<{ content: string }>();
  return {
    count: rows.results.length,
    content: rows.results[0]?.content ?? null,
  };
}

describe("SelfModel.regenerate", () => {
  it("persists an active self-model and feeds seeded memories to the router", async () => {
    await seedMemories();
    const router = fakeRouter("This team ships on a weekly cadence; I should focus on launch follow-through.");

    const res = await SelfModel.regenerate(testEnv, log, {
      router,
      tenantId: TENANT,
    });

    expect(res.regenerated).toBe(true);
    expect(res.supersededCount).toBe(0);

    // Seeded memories reached the model.
    const prompt = router.lastPrompt();
    expect(prompt).toContain(FACT_A);
    expect(prompt).toContain(OBS_B);

    // Active row persisted with the model's text.
    const active = await activeRows();
    expect(active.count).toBe(1);
    expect(active.content).toContain("weekly cadence");

    // current() / inject() reflect it.
    const current = await SelfModel.current(testEnv, { tenantId: TENANT });
    expect(current).toContain("weekly cadence");
    const injected = await SelfModel.inject(testEnv, "BASE_PROMPT", {
      tenantId: TENANT,
    });
    expect(injected).toContain("What I've learned about this team:");
    expect(injected).toContain("weekly cadence");
    expect(injected).toContain("BASE_PROMPT");
  });

  it("supersedes the previous self-model — one active, history retained", async () => {
    // Storage is isolated per test, so seed + generate a first model here.
    await seedMemories();
    const first = await SelfModel.regenerate(testEnv, log, {
      router: fakeRouter("First self-model."),
      tenantId: TENANT,
    });
    expect(first.regenerated).toBe(true);
    expect(first.supersededCount).toBe(0);

    const res = await SelfModel.regenerate(testEnv, log, {
      router: fakeRouter(
        "Refined self-model: prioritize unowned high-priority tasks.",
      ),
      tenantId: TENANT,
    });

    expect(res.regenerated).toBe(true);
    expect(res.supersededCount).toBe(1);

    // Exactly one active row, and it is the refined one.
    const active = await activeRows();
    expect(active.count).toBe(1);
    expect(active.content).toContain("Refined self-model");

    // The previous row is retained as history (re-tagged, not deleted).
    const superseded = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM memories
        WHERE scope_type = 'tenant' AND scope_id = ?
          AND source_resource_type = 'self_model_superseded'`,
    )
      .bind(TENANT)
      .first<{ n: number }>();
    expect(superseded?.n).toBe(1);

    // current() shows the refined model.
    const current = await SelfModel.current(testEnv, { tenantId: TENANT });
    expect(current).toContain("Refined self-model");
  });
});
