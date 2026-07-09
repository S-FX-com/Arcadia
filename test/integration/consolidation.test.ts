import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { logger } from "../../src/lib/logger";
import { consolidate } from "../../src/memory/consolidation";
import { Router } from "../../src/ai/router";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
} from "../../src/ai/types";

// P6 item 4: memory consolidation cycles against the real migrated D1.
//   - The light cycle (prune + dedupe) needs no AI and runs entirely for real.
//     Every seeded memory uses embedding_id = NULL so prune() never reaches the
//     Vectorize deleteByIds path (Vectorize is not simulatable under the pool).
//   - The deep cycle's distillation calls the AI router; we inject a Router
//     built from a stub "deep" provider (via the RouterProviders seam) so no
//     network call happens, then assert the feedback + promote/retire stages
//     ran for real by their ConsolidationResult counters.

const testEnv = env as unknown as Env;
const db = testEnv.ARCADIA_DB;
const log = logger();

async function seedMemory(o: {
  id: string;
  kind: string;
  scopeType: string;
  scopeId: string;
  content: string;
  createdAt?: string;
  expiresAt?: string | null;
  useCount?: number;
  successCount?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO memories
         (id, kind, scope_type, scope_id, content, confidence,
          use_count, success_count, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?)`,
    )
    .bind(
      o.id,
      o.kind,
      o.scopeType,
      o.scopeId,
      o.content,
      o.useCount ?? 0,
      o.successCount ?? 0,
      o.createdAt ?? now,
      now,
      o.expiresAt ?? null,
    )
    .run();
}

async function expiresAtOf(id: string): Promise<string | null | undefined> {
  const r = await db
    .prepare(`SELECT expires_at FROM memories WHERE id = ?`)
    .bind(id)
    .first<{ expires_at: string | null }>();
  return r === null ? undefined : r.expires_at;
}

describe("consolidation — light cycle prune", () => {
  it("prunes an expired memory and keeps a fresh one", async () => {
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    await seedMemory({
      id: "cons-expired",
      kind: "semantic",
      scopeType: "channel",
      scopeId: "cons-prune",
      content: "this memory expired an hour ago and should be pruned",
      expiresAt: past,
    });
    await seedMemory({
      id: "cons-fresh",
      kind: "semantic",
      scopeType: "channel",
      scopeId: "cons-prune",
      content: "this memory has no expiry and must survive the prune",
    });

    const result = await consolidate(testEnv, "light", log);

    expect(result.cycle).toBe("light");
    expect(result.expiredPruned).toBeGreaterThanOrEqual(1);
    // Expired row hard-deleted; fresh row still present.
    expect(await expiresAtOf("cons-expired")).toBeUndefined();
    expect(await expiresAtOf("cons-fresh")).toBeNull();
  });
});

describe("consolidation — light cycle dedupe", () => {
  it("collapses near-identical recent memories in the same scope", async () => {
    const older = new Date(Date.now() - 5000).toISOString();
    const newer = new Date(Date.now() - 1000).toISOString();
    // Same content modulo case/whitespace → normalise() collides them.
    await seedMemory({
      id: "cons-dup-keep",
      kind: "episodic",
      scopeType: "channel",
      scopeId: "cons-dedupe",
      content: "The launch is scheduled for next Friday afternoon",
      createdAt: older,
    });
    await seedMemory({
      id: "cons-dup-drop",
      kind: "episodic",
      scopeType: "channel",
      scopeId: "cons-dedupe",
      content: "the launch   is scheduled for next friday afternoon",
      createdAt: newer,
    });

    const result = await consolidate(testEnv, "light", log);

    expect(result.duplicatesMerged).toBeGreaterThanOrEqual(1);
    // Earliest occurrence kept; the later duplicate is soft-deleted (forget()).
    expect(await expiresAtOf("cons-dup-keep")).toBeNull();
    expect(await expiresAtOf("cons-dup-drop")).toBeTruthy();
  });
});

describe("consolidation — deep cycle", () => {
  it("invokes feedback consolidation + promote/retire and uses the injected router", async () => {
    // A hot episodic scope forces distillScope → router.complete. The stub
    // returns an empty fact set so no memory is written (which would require
    // the un-simulatable embed path) — we only need to prove the router ran.
    let deepCalls = 0;
    const deepStub: Provider = {
      name: "stub:deep",
      async complete(_req: CompleteRequest): Promise<CompleteResponse> {
        deepCalls += 1;
        return { text: '{"facts":[]}', model: "stub:deep", tier: "deep" };
      },
    };
    const router = new Router(testEnv, { deep: deepStub });

    for (let i = 0; i < 5; i += 1) {
      await seedMemory({
        id: `cons-hot-${i}`,
        kind: "episodic",
        scopeType: "channel",
        scopeId: "cons-deep-hot",
        content: `Episodic note number ${i} about the ongoing migration effort.`,
      });
    }

    // Feedback rows for runFeedbackConsolidation to process.
    await db
      .prepare(
        `INSERT INTO feedback (user_aad_id, surface, target_kind, target_id, signal, note)
         VALUES (?, 'task_card', 'task', 'cons-fb-task', 'positive', 'good')`,
      )
      .bind("cons-fb-user")
      .run();
    await db
      .prepare(
        `INSERT INTO feedback (user_aad_id, surface, target_kind, target_id, signal, note)
         VALUES (?, 'digest_card', 'digest', 'cons-fb-digest', 'negative', 'meh')`,
      )
      .bind("cons-fb-user")
      .run();

    // A reliable procedure (promote) and an unreliable one (retire); both have
    // enough evidence (use_count >= procedureMinUses = 5).
    await seedMemory({
      id: "cons-proc-promote",
      kind: "procedural",
      scopeType: "channel",
      scopeId: "cons-deep-proc",
      content: "When a release lands, post a summary to the release channel.",
      useCount: 10,
      successCount: 9,
    });
    await seedMemory({
      id: "cons-proc-retire",
      kind: "procedural",
      scopeType: "channel",
      scopeId: "cons-deep-proc",
      content: "When someone says thanks, always open a follow-up task.",
      useCount: 10,
      successCount: 1,
    });

    const result = await consolidate(testEnv, "deep", log, router);

    expect(result.cycle).toBe("deep");
    // Router ran for the hot scope, no semantic memories written (empty facts).
    expect(deepCalls).toBeGreaterThanOrEqual(1);
    expect(result.semanticDerived).toBe(0);
    // Feedback stage processed our fresh rows.
    expect(result.feedbackProcessed).toBeGreaterThanOrEqual(1);
    // Promote/retire stage acted on the two procedures.
    expect(result.proceduresPromoted).toBeGreaterThanOrEqual(1);
    expect(result.proceduresRetired).toBeGreaterThanOrEqual(1);

    const promoted = await db
      .prepare(`SELECT promoted FROM memories WHERE id = 'cons-proc-promote'`)
      .first<{ promoted: number }>();
    const retired = await db
      .prepare(`SELECT promoted FROM memories WHERE id = 'cons-proc-retire'`)
      .first<{ promoted: number }>();
    expect(promoted?.promoted).toBe(1);
    expect(retired?.promoted).toBe(-1);
  });
});
