// Procedural memory promotion / retirement (EXECUTION-PLAN §Phase 4 item 1).
//
// A procedural memory is a learned "when X, do Y". Migration 0004 added
// use_count / success_count / promoted counters so the PROCEDURE_* config
// thresholds finally have something to act on:
//
//   recordOutcome()      append an evidence row to procedure_events and bump
//                        the memory's counters (use_count for every outcome,
//                        success_count only for 'success').
//   scoreProcedure()     success_count / max(1, use_count) — the hit rate.
//   promoteAndRetire()   for procedures with enough evidence (use_count >=
//                        procedureMinUses): promote (promoted=1) the reliable
//                        ones, retire (promoted=-1) the unreliable ones, and
//                        reset everything in between to normal (promoted=0).
//   promotedProcedures() the promoted set, for prompt injection.
//   injectProcedures()   prepend the promoted set to a system prompt, mirroring
//                        charter/inject.ts so learned procedures ride into the
//                        model context the same way ground truth does.
//
// Retired procedures are NEVER deleted — they stay for audit and can be
// re-promoted later if their score recovers — but promoted=-1 excludes them
// from recall/injection.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { config } from "../lib/config";
import type { Scope } from "./types";

export type Outcome = "used" | "success" | "failure";

/** The two counters that feed scoreProcedure(). */
export interface ProcedureCounters {
  use_count: number;
  success_count: number;
}

export interface ProcedureScope {
  scopeType: Scope;
  scopeId: string;
}

export interface PromotedProcedure {
  id: string;
  content: string;
  scopeType: Scope;
  scopeId: string;
  confidence: number;
  useCount: number;
  successCount: number;
}

export interface PromoteRetireResult {
  scanned: number;
  promoted: number;
  retired: number;
  normal: number;
}

interface ProcedureRow {
  id: string;
  use_count: number;
  success_count: number;
  promoted: number;
}

interface PromotedRow {
  id: string;
  content: string;
  scope_type: string;
  scope_id: string;
  confidence: number;
  use_count: number;
  success_count: number;
}

export class ProcedureStore {
  constructor(private readonly env: Env) {}

  /**
   * Append a procedure_events row and bump the memory's counters. Every
   * outcome increments use_count; only 'success' increments success_count.
   * Silently no-ops on an unknown memory id (the FK is intentionally loose in
   * 0004 so an outcome can be logged even mid-migration).
   */
  async recordOutcome(
    memoryId: string,
    outcome: Outcome,
    source?: string,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO procedure_events (memory_id, outcome, source)
       VALUES (?, ?, ?)`,
    )
      .bind(memoryId, outcome, source ?? null)
      .run();

    const successInc = outcome === "success" ? 1 : 0;
    await this.env.ARCADIA_DB.prepare(
      `UPDATE memories
          SET use_count = use_count + 1,
              success_count = success_count + ?,
              updated_at = ?
        WHERE id = ?`,
    )
      .bind(successInc, new Date().toISOString(), memoryId)
      .run();
  }

  /** Hit rate in [0,1]. max(1, use_count) guards the zero-use case. */
  static scoreProcedure(row: ProcedureCounters): number {
    return row.success_count / Math.max(1, row.use_count);
  }

  /**
   * Evaluate every procedural memory with enough evidence and set `promoted`:
   *   score >= procedurePromoteThreshold → 1  (promoted, injected)
   *   score <= procedureRetireThreshold  → -1 (retired, excluded)
   *   otherwise                          → 0  (normal)
   * Re-evaluates already-promoted / already-retired rows too, so a procedure
   * can recover or degrade over time. Returns per-state counts.
   */
  async promoteAndRetire(log: Logger): Promise<PromoteRetireResult> {
    const cfg = config(this.env);
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT id, use_count, success_count, promoted
         FROM memories
        WHERE kind = 'procedural'
          AND use_count >= ?
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
      .bind(cfg.procedureMinUses, new Date().toISOString())
      .all<ProcedureRow>();

    const out: PromoteRetireResult = {
      scanned: 0,
      promoted: 0,
      retired: 0,
      normal: 0,
    };
    const now = new Date().toISOString();

    for (const r of rows.results) {
      out.scanned += 1;
      const score = ProcedureStore.scoreProcedure(r);
      let target: number;
      if (score >= cfg.procedurePromoteThreshold) {
        target = 1;
        out.promoted += 1;
      } else if (score <= cfg.procedureRetireThreshold) {
        target = -1;
        out.retired += 1;
      } else {
        target = 0;
        out.normal += 1;
      }
      if (target !== r.promoted) {
        await this.env.ARCADIA_DB.prepare(
          `UPDATE memories SET promoted = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(target, now, r.id)
          .run();
      }
    }

    log.info("procedure_promote_retire", { ...out });
    return out;
  }

  /** The promoted (promoted=1) procedural memories, optionally scoped. */
  async promotedProcedures(
    scope?: ProcedureScope,
  ): Promise<PromotedProcedure[]> {
    const now = new Date().toISOString();
    const rows = scope
      ? await this.env.ARCADIA_DB.prepare(
          `SELECT id, content, scope_type, scope_id, confidence,
                  use_count, success_count
             FROM memories
            WHERE kind = 'procedural' AND promoted = 1
              AND scope_type = ? AND scope_id = ?
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY success_count DESC, use_count DESC`,
        )
          .bind(scope.scopeType, scope.scopeId, now)
          .all<PromotedRow>()
      : await this.env.ARCADIA_DB.prepare(
          `SELECT id, content, scope_type, scope_id, confidence,
                  use_count, success_count
             FROM memories
            WHERE kind = 'procedural' AND promoted = 1
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY success_count DESC, use_count DESC`,
        )
          .bind(now)
          .all<PromotedRow>();

    return rows.results.map((r) => ({
      id: r.id,
      content: r.content,
      scopeType: r.scope_type as Scope,
      scopeId: r.scope_id,
      confidence: r.confidence,
      useCount: r.use_count,
      successCount: r.success_count,
    }));
  }

  /**
   * Return `base` with the promoted procedures prepended as a block, mirroring
   * injectCharter()'s shape. When there are none (the common case) `base` is
   * returned unchanged. Defensive: a DB error degrades to `base` rather than
   * failing the caller's hot path.
   */
  async injectProcedures(
    base: string,
    scope?: ProcedureScope,
  ): Promise<string> {
    let procs: PromotedProcedure[];
    try {
      procs = await this.promotedProcedures(scope);
    } catch {
      return base;
    }
    if (procs.length === 0) return base;
    return `${proceduresPreamble(procs)}\n\n${base}`;
  }
}

function proceduresPreamble(procs: PromotedProcedure[]): string {
  const lines = procs.map((p) => `- ${p.content.trim()}`).join("\n");
  return `Learned procedures — promoted from repeated success (apply when relevant):\n${lines}`;
}
