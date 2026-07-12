import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { ProcedureStore } from "../../src/memory/procedures";
import { logger } from "../../src/lib/logger";

// P4 procedural promotion / retirement (EXECUTION-PLAN §Phase 4 item 1).
// Runs against the real migrated D1 (0004 counters) — no Vectorize needed,
// promotion is pure counter arithmetic. Config thresholds under test:
//   procedureMinUses=5, promote>=0.65, retire<=0.35.

const testEnv = env as unknown as Env;
const log = logger();

const SCOPE_ID = "chan-procedures";

async function seedProcedure(opts: {
  id: string;
  content: string;
  useCount: number;
  successCount: number;
  scopeId?: string;
  kind?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO memories
       (id, kind, scope_type, scope_id, content, confidence,
        use_count, success_count, promoted, created_at, updated_at)
     VALUES (?, ?, 'channel', ?, ?, 1.0, ?, ?, 0, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.kind ?? "procedural",
      opts.scopeId ?? SCOPE_ID,
      opts.content,
      opts.useCount,
      opts.successCount,
      now,
      now,
    )
    .run();
}

beforeAll(async () => {
  // High score, enough uses → should promote (8/10 = 0.8 >= 0.65).
  await seedProcedure({
    id: "proc-promote",
    content: "When a deadline slips, post a heads-up in the channel first.",
    useCount: 10,
    successCount: 8,
  });
  // Low score, enough uses → should retire (2/10 = 0.2 <= 0.35).
  await seedProcedure({
    id: "proc-retire",
    content: "Always @-mention everyone on every status update.",
    useCount: 10,
    successCount: 2,
  });
  // Middling score → stays normal (5/10 = 0.5).
  await seedProcedure({
    id: "proc-normal",
    content: "Summarise long threads before replying.",
    useCount: 10,
    successCount: 5,
  });
  // High score but too few uses → not eligible, stays normal (below minUses).
  await seedProcedure({
    id: "proc-thin",
    content: "Prefer bullet points for multi-part answers.",
    useCount: 3,
    successCount: 3,
  });
  // A non-procedural memory that would score high — must be ignored entirely.
  await seedProcedure({
    id: "sem-ignore",
    content: "The Q3 roadmap ships in September.",
    useCount: 10,
    successCount: 10,
    kind: "semantic",
  });
});

describe("scoreProcedure", () => {
  it("is success/max(1,use) and safe at zero uses", () => {
    expect(ProcedureStore.scoreProcedure({ use_count: 10, success_count: 8 })).toBeCloseTo(0.8);
    expect(ProcedureStore.scoreProcedure({ use_count: 0, success_count: 0 })).toBe(0);
  });
});

describe("recordOutcome", () => {
  it("appends a procedure_events row and bumps counters", async () => {
    await seedProcedure({
      id: "proc-counters",
      content: "Test outcome counters.",
      useCount: 0,
      successCount: 0,
    });
    const store = new ProcedureStore(testEnv);

    await store.recordOutcome("proc-counters", "used", "digest");
    await store.recordOutcome("proc-counters", "success", "digest");
    await store.recordOutcome("proc-counters", "failure", "nudge");

    const mem = await testEnv.ARCADIA_DB.prepare(
      `SELECT use_count, success_count FROM memories WHERE id = ?`,
    )
      .bind("proc-counters")
      .first<{ use_count: number; success_count: number }>();
    // All three outcomes bump use_count; only 'success' bumps success_count.
    expect(mem?.use_count).toBe(3);
    expect(mem?.success_count).toBe(1);

    const events = await testEnv.ARCADIA_DB.prepare(
      `SELECT outcome, source FROM procedure_events
        WHERE memory_id = ? ORDER BY id ASC`,
    )
      .bind("proc-counters")
      .all<{ outcome: string; source: string | null }>();
    expect(events.results.map((e) => e.outcome)).toEqual([
      "used",
      "success",
      "failure",
    ]);
    expect(events.results[0]?.source).toBe("digest");
  });
});

describe("promoteAndRetire", () => {
  it("promotes reliable, retires unreliable, respects minUses and kind", async () => {
    const store = new ProcedureStore(testEnv);
    const result = await store.promoteAndRetire(log);

    // proc-promote, proc-retire, proc-normal are eligible (use_count >= 5);
    // proc-thin (3 uses) and sem-ignore (not procedural) are excluded, as is
    // proc-counters which after recordOutcome has only 3 uses.
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    expect(result.retired).toBeGreaterThanOrEqual(1);

    const flag = async (id: string): Promise<number | undefined> =>
      (
        await testEnv.ARCADIA_DB.prepare(
          `SELECT promoted FROM memories WHERE id = ?`,
        )
          .bind(id)
          .first<{ promoted: number }>()
      )?.promoted;

    expect(await flag("proc-promote")).toBe(1);
    expect(await flag("proc-retire")).toBe(-1);
    expect(await flag("proc-normal")).toBe(0);
    expect(await flag("proc-thin")).toBe(0); // below minUses → untouched
    expect(await flag("sem-ignore")).toBe(0); // wrong kind → untouched
  });
});

describe("promotedProcedures / injectProcedures", () => {
  it("returns promoted only and excludes retired", async () => {
    const store = new ProcedureStore(testEnv);
    await store.promoteAndRetire(log);

    const promoted = await store.promotedProcedures({
      scopeType: "channel",
      scopeId: SCOPE_ID,
    });
    const ids = promoted.map((p) => p.id);
    expect(ids).toContain("proc-promote");
    expect(ids).not.toContain("proc-retire");
    expect(ids).not.toContain("proc-normal");
  });

  it("prepends a Learned procedures block, or returns base when none", async () => {
    const store = new ProcedureStore(testEnv);
    await store.promoteAndRetire(log);
    const base = "SYSTEM-BASE-PROMPT";

    const injected = await store.injectProcedures(base, {
      scopeType: "channel",
      scopeId: SCOPE_ID,
    });
    expect(injected).toContain("Learned procedures");
    expect(injected).toContain("heads-up in the channel");
    expect(injected.endsWith(base)).toBe(true);

    // An empty scope yields no promoted procedures → base unchanged.
    const untouched = await store.injectProcedures(base, {
      scopeType: "channel",
      scopeId: "chan-with-no-procedures",
    });
    expect(untouched).toBe(base);
  });
});
