import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import {
  runFeedbackConsolidation,
  CONFIDENCE_FLOOR,
  NEGATIVE_AGGREGATE_THRESHOLD,
} from "../../src/memory/feedback";
import { logger } from "../../src/lib/logger";

// P4 feedback consumption (EXECUTION-PLAN §Phase 4 item 2). Runs against the
// real migrated D1 + KV. The feedback table (0001) is finally read; signals
// lower confidence, record procedure outcomes, and file proposals. A KV
// high-water-mark (`feedback:cursor`) makes a re-run a no-op.

const testEnv = env as unknown as Env;
const log = logger();

async function seedMemory(opts: {
  id: string;
  kind: string;
  content: string;
  confidence: number;
  sourceResourceId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO memories
       (id, kind, scope_type, scope_id, content, confidence,
        source_resource_id, created_at, updated_at)
     VALUES (?, ?, 'channel', 'chan-fb', ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.kind,
      opts.content,
      opts.confidence,
      opts.sourceResourceId ?? null,
      now,
      now,
    )
    .run();
}

async function seedFeedback(opts: {
  surface: string;
  targetKind: string;
  targetId: string;
  signal: "positive" | "negative" | "correction";
  note?: string;
}): Promise<void> {
  await testEnv.ARCADIA_DB.prepare(
    `INSERT INTO feedback (surface, target_kind, target_id, signal, note)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.surface,
      opts.targetKind,
      opts.targetId,
      opts.signal,
      opts.note ?? null,
    )
    .run();
}

beforeAll(async () => {
  // Correction target: 0.3 * 0.5 = 0.15 < floor → should also propose retract.
  await seedMemory({
    id: "mem-correct-low",
    kind: "semantic",
    content: "The launch date is May 1.",
    confidence: 0.3,
    sourceResourceId: "res-shared",
  });
  // Sibling from the same source — corrected together, but well above floor.
  await seedMemory({
    id: "mem-sibling",
    kind: "semantic",
    content: "The launch owner is Dana.",
    confidence: 1.0,
    sourceResourceId: "res-shared",
  });
  // Procedural memory receiving a positive then a negative signal.
  await seedMemory({
    id: "proc-fb",
    kind: "procedural",
    content: "Post a recap after every meeting.",
    confidence: 1.0,
  });

  // --- feedback rows ---
  await seedFeedback({
    surface: "chat",
    targetKind: "memory",
    targetId: "mem-correct-low",
    signal: "correction",
    note: "That date is wrong.",
  });
  await seedFeedback({
    surface: "digest",
    targetKind: "memory",
    targetId: "proc-fb",
    signal: "positive",
  });
  await seedFeedback({
    surface: "nudge",
    targetKind: "memory",
    targetId: "proc-fb",
    signal: "negative",
  });
  // Three negatives on a non-procedure surface → aggregation proposal.
  for (let i = 0; i < NEGATIVE_AGGREGATE_THRESHOLD; i++) {
    await seedFeedback({
      surface: "digest",
      targetKind: "digest",
      targetId: "digest-1",
      signal: "negative",
    });
  }
});

describe("runFeedbackConsolidation", () => {
  it("applies corrections, records outcomes, aggregates, and is idempotent", async () => {
    const first = await runFeedbackConsolidation(testEnv, log);
    expect(first.processed).toBeGreaterThanOrEqual(6);

    // Correction halved the target and its sibling.
    const low = await testEnv.ARCADIA_DB.prepare(
      `SELECT confidence FROM memories WHERE id = ?`,
    )
      .bind("mem-correct-low")
      .first<{ confidence: number }>();
    expect(low?.confidence).toBeCloseTo(0.15);
    expect(low?.confidence).toBeLessThan(CONFIDENCE_FLOOR);

    const sib = await testEnv.ARCADIA_DB.prepare(
      `SELECT confidence FROM memories WHERE id = ?`,
    )
      .bind("mem-sibling")
      .first<{ confidence: number }>();
    expect(sib?.confidence).toBeCloseTo(0.5);

    // Below-floor correction filed a memory_correction proposal.
    const memProp = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM improvement_proposals
        WHERE kind = 'memory_correction' AND origin = 'feedback'
          AND json_extract(payload_json, '$.memoryId') = ?`,
    )
      .bind("mem-correct-low")
      .first<{ n: number }>();
    expect(memProp?.n).toBe(1);

    // Procedure signals recorded as outcomes (positive→success, negative→failure).
    const proc = await testEnv.ARCADIA_DB.prepare(
      `SELECT use_count, success_count FROM memories WHERE id = ?`,
    )
      .bind("proc-fb")
      .first<{ use_count: number; success_count: number }>();
    expect(proc?.use_count).toBe(2);
    expect(proc?.success_count).toBe(1);

    const events = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM procedure_events WHERE memory_id = ?`,
    )
      .bind("proc-fb")
      .first<{ n: number }>();
    expect(events?.n).toBe(2);

    // Negative aggregation past threshold filed exactly one summary proposal.
    const aggProp = await testEnv.ARCADIA_DB.prepare(
      `SELECT COUNT(*) AS n FROM improvement_proposals
        WHERE origin = 'feedback'
          AND json_extract(payload_json, '$.targetId') = ?`,
    )
      .bind("digest-1")
      .first<{ n: number }>();
    expect(aggProp?.n).toBe(1);

    // Cursor advanced → a re-run processes nothing.
    const cursor = await testEnv.ARCADIA_CACHE.get("feedback:cursor");
    expect(cursor).toBeTruthy();
    const second = await runFeedbackConsolidation(testEnv, log);
    expect(second.processed).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });
});
