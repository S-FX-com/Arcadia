// Feedback consumption (EXECUTION-PLAN §Phase 4 item 2).
//
// The `feedback` table (0001) has been write-only: surfaces record a
// user's thumbs-up / thumbs-down / correction, but nothing ever read it.
// This closes the loop. runFeedbackConsolidation() is called from the deep
// consolidation cycle (nightly); it reads the feedback rows it hasn't seen
// yet and acts on them, then advances a KV high-water-mark so a re-run is a
// no-op.
//
// Progress marker: rather than add a `processed` column, we keep the id of
// the highest feedback row processed in KV under `feedback:cursor`. feedback
// ids are a monotonic AUTOINCREMENT, so "unprocessed" == id > cursor.
//
// Signal → action mapping (deliberately conservative — Arcadia proposes,
// the operator ratifies; nothing here silently deletes memory or edits
// behaviour):
//
//   correction  on a memory target  → halve that memory's confidence and the
//                                      confidence of siblings sharing its
//                                      source_resource_id. If confidence falls
//                                      below CONFIDENCE_FLOOR, file a
//                                      memory_correction PROPOSAL (origin
//                                      'feedback') instead of hard-deleting.
//   negative    on a procedure       → record a 'failure' procedure outcome.
//               on anything else     → aggregate; once a single target has
//                                      accrued >= NEGATIVE_AGGREGATE_THRESHOLD
//                                      negatives, file one summary proposal.
//   positive    on a procedure       → record a 'success' procedure outcome.
//               on anything else     → no-op (nothing actionable yet).
//
// A "procedure target" is a feedback row whose target is a procedural memory:
// target_kind === 'procedure', or target_kind === 'memory' pointing at a
// memory whose kind is 'procedural'.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { ProposalStore, type ProposalKind } from "../learning/proposals";
import { ProcedureStore } from "./procedures";

const CURSOR_KEY = "feedback:cursor";
const BATCH = 200;

/** Confidence below this after a correction → propose removal, don't delete. */
export const CONFIDENCE_FLOOR = 0.2;
/** Negatives on one non-procedure target before a summary proposal is filed. */
export const NEGATIVE_AGGREGATE_THRESHOLD = 3;

export interface FeedbackConsolidationResult {
  processed: number;
  corrections: number;
  outcomesRecorded: number;
  proposalsCreated: number;
  cursor: number;
}

interface FeedbackRow {
  id: number;
  user_aad_id: string | null;
  surface: string;
  target_kind: string;
  target_id: string | null;
  signal: "positive" | "negative" | "correction";
  note: string | null;
}

interface MemoryConfRow {
  id: string;
  confidence: number;
  content: string;
  source_resource_id: string | null;
}

export async function runFeedbackConsolidation(
  env: Env,
  log: Logger,
): Promise<FeedbackConsolidationResult> {
  const out: FeedbackConsolidationResult = {
    processed: 0,
    corrections: 0,
    outcomesRecorded: 0,
    proposalsCreated: 0,
    cursor: 0,
  };

  const cursor = await readCursor(env);
  out.cursor = cursor;

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT id, user_aad_id, surface, target_kind, target_id, signal, note
       FROM feedback
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?`,
  )
    .bind(cursor, BATCH)
    .all<FeedbackRow>();

  if (rows.results.length === 0) return out;

  const proposals = new ProposalStore(env);
  const procedures = new ProcedureStore(env);

  let maxId = cursor;
  for (const row of rows.results) {
    maxId = Math.max(maxId, row.id);
    try {
      if (row.signal === "correction") {
        const applied = await applyCorrection(env, proposals, row);
        out.corrections += applied.corrected ? 1 : 0;
        out.proposalsCreated += applied.proposed ? 1 : 0;
      } else if (row.signal === "negative") {
        const procId = await procedureTargetId(env, row);
        if (procId) {
          await procedures.recordOutcome(procId, "failure", row.surface);
          out.outcomesRecorded += 1;
        } else {
          const proposed = await maybeAggregateNegatives(env, proposals, row);
          out.proposalsCreated += proposed ? 1 : 0;
        }
      } else if (row.signal === "positive") {
        const procId = await procedureTargetId(env, row);
        if (procId) {
          await procedures.recordOutcome(procId, "success", row.surface);
          out.outcomesRecorded += 1;
        }
      }
      out.processed += 1;
    } catch (e) {
      // A single malformed row must never stall the cursor for the batch.
      log.warn("feedback_row_failed", { id: row.id, error: String(e) });
    }
  }

  await writeCursor(env, maxId);
  out.cursor = maxId;
  log.info("feedback_consolidation", { ...out });
  return out;
}

/**
 * Halve the confidence of the corrected memory and its siblings (same
 * source_resource_id). When the corrected memory drops below the floor, file a
 * memory_correction proposal rather than deleting. Returns what happened.
 */
async function applyCorrection(
  env: Env,
  proposals: ProposalStore,
  row: FeedbackRow,
): Promise<{ corrected: boolean; proposed: boolean }> {
  if (row.target_kind !== "memory" || !row.target_id) {
    return { corrected: false, proposed: false };
  }

  const mem = await env.ARCADIA_DB.prepare(
    `SELECT id, confidence, content, source_resource_id
       FROM memories WHERE id = ?`,
  )
    .bind(row.target_id)
    .first<MemoryConfRow>();
  if (!mem) return { corrected: false, proposed: false };

  const now = new Date().toISOString();
  const newConf = mem.confidence * 0.5;

  await env.ARCADIA_DB.prepare(
    `UPDATE memories SET confidence = confidence * 0.5, updated_at = ?
      WHERE id = ?`,
  )
    .bind(now, mem.id)
    .run();

  // Siblings from the same source resource are corrected together — a bad
  // extraction usually taints every memory it produced.
  if (mem.source_resource_id) {
    await env.ARCADIA_DB.prepare(
      `UPDATE memories SET confidence = confidence * 0.5, updated_at = ?
        WHERE source_resource_id = ? AND id != ?`,
    )
      .bind(now, mem.source_resource_id, mem.id)
      .run();
  }

  let proposed = false;
  if (newConf < CONFIDENCE_FLOOR) {
    await proposals.create({
      kind: "memory_correction",
      origin: "feedback",
      title: `Retract low-confidence memory ${mem.id}`,
      rationale: row.note
        ? `User correction: ${row.note}`
        : `Confidence fell to ${newConf.toFixed(3)} after correction.`,
      payload: {
        memoryId: mem.id,
        content: mem.content,
        confidence: newConf,
        ...(row.note ? { note: row.note } : {}),
      },
      dedupeKey: `memcorr:${mem.id}`,
    });
    proposed = true;
  }

  return { corrected: true, proposed };
}

/**
 * File one summary proposal once a single (target_kind, target_id) has accrued
 * NEGATIVE_AGGREGATE_THRESHOLD negatives. dedupeKey keeps a nightly re-run from
 * piling up duplicates while the proposal stays pending.
 */
async function maybeAggregateNegatives(
  env: Env,
  proposals: ProposalStore,
  row: FeedbackRow,
): Promise<boolean> {
  if (!row.target_id) return false;

  const agg = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback
      WHERE target_kind = ? AND target_id = ? AND signal = 'negative'`,
  )
    .bind(row.target_kind, row.target_id)
    .first<{ n: number }>();
  const n = agg?.n ?? 0;
  if (n < NEGATIVE_AGGREGATE_THRESHOLD) return false;

  await proposals.create({
    kind: proposalKindForTarget(row.target_kind),
    origin: "feedback",
    title: `Repeated negative feedback on ${row.target_kind} ${row.target_id}`,
    rationale: `${n} negative signals accrued on this ${row.target_kind} (surface: ${row.surface}).`,
    payload: {
      targetKind: row.target_kind,
      targetId: row.target_id,
      negatives: n,
      surface: row.surface,
    },
    dedupeKey: `negagg:${row.target_kind}:${row.target_id}`,
  });
  return true;
}

/** Memory targets → memory_correction; behavioural surfaces → charter_amendment. */
function proposalKindForTarget(targetKind: string): ProposalKind {
  return targetKind === "memory" ? "memory_correction" : "charter_amendment";
}

/**
 * The procedural-memory id a feedback row maps to, or null. A target_kind of
 * 'procedure' is trusted directly; a 'memory' target is resolved and only
 * accepted if it is actually a procedural memory.
 */
async function procedureTargetId(
  env: Env,
  row: FeedbackRow,
): Promise<string | null> {
  if (!row.target_id) return null;
  if (row.target_kind === "procedure") return row.target_id;
  if (row.target_kind === "memory") {
    const m = await env.ARCADIA_DB.prepare(
      `SELECT kind FROM memories WHERE id = ?`,
    )
      .bind(row.target_id)
      .first<{ kind: string }>();
    if (m?.kind === "procedural") return row.target_id;
  }
  return null;
}

async function readCursor(env: Env): Promise<number> {
  const raw = await env.ARCADIA_CACHE.get(CURSOR_KEY);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function writeCursor(env: Env, id: number): Promise<void> {
  await env.ARCADIA_CACHE.put(CURSOR_KEY, String(id));
}
