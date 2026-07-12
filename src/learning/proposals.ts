// Improvement-proposal store — the operator review queue.
//
// The learning loop (EXECUTION-PLAN §Phase 4) never edits Arcadia's
// behaviour silently. Eval failures, feedback signals, consolidation,
// and curiosity all write PROPOSALS here; the operator approves or
// rejects them, and only on approval does a proposal take effect
// (a charter version is published, a memory corrected, a procedure
// promoted, a routine activated). Arcadia proposes; Shane ratifies.
//
// This module is deliberately thin and dependency-free so every
// producer (eval, consolidation, curiosity) and the webapp reader can
// share one code path against the improvement_proposals table (0004).

import type { Env } from "../env";

export type ProposalKind =
  | "charter_amendment"
  | "memory_correction"
  | "procedure"
  | "routine";

export type ProposalOrigin =
  | "eval"
  | "feedback"
  | "consolidation"
  | "curiosity";

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  origin: ProposalOrigin;
  title: string;
  rationale: string | null;
  payload: unknown;
  status: ProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface NewProposal {
  kind: ProposalKind;
  origin: ProposalOrigin;
  title: string;
  rationale?: string;
  payload: unknown;
  /**
   * Optional idempotency key. When set, a pending proposal with the same
   * (kind, dedupeKey) is not created twice — producers on a cron can call
   * create() every cycle without piling up duplicates.
   */
  dedupeKey?: string;
}

interface ProposalRow {
  id: string;
  kind: ProposalKind;
  origin: ProposalOrigin;
  title: string;
  rationale: string | null;
  payload_json: string;
  status: ProposalStatus;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function fromRow(row: ProposalRow): Proposal {
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    title: row.title,
    rationale: row.rationale,
    payload,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export class ProposalStore {
  constructor(private readonly env: Env) {}

  /**
   * Create a proposal. Returns the new id, or the existing pending id when
   * dedupeKey matches an open proposal of the same kind (no duplicate row).
   */
  async create(p: NewProposal): Promise<string> {
    if (p.dedupeKey) {
      const existing = await this.env.ARCADIA_DB.prepare(
        `SELECT id FROM improvement_proposals
          WHERE kind = ? AND status = 'pending'
            AND json_extract(payload_json, '$._dedupeKey') = ?
          LIMIT 1`,
      )
        .bind(p.kind, p.dedupeKey)
        .first<{ id: string }>();
      if (existing) return existing.id;
    }

    const id = crypto.randomUUID();
    const payload =
      p.dedupeKey && p.payload && typeof p.payload === "object"
        ? { ...(p.payload as Record<string, unknown>), _dedupeKey: p.dedupeKey }
        : p.payload;

    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO improvement_proposals
         (id, kind, origin, title, rationale, payload_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    )
      .bind(
        id,
        p.kind,
        p.origin,
        p.title,
        p.rationale ?? null,
        JSON.stringify(payload ?? null),
      )
      .run();
    return id;
  }

  async byId(id: string): Promise<Proposal | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM improvement_proposals WHERE id = ?`,
    )
      .bind(id)
      .first<ProposalRow>();
    return row ? fromRow(row) : null;
  }

  async list(status?: ProposalStatus, limit = 50): Promise<Proposal[]> {
    const rows = status
      ? await this.env.ARCADIA_DB.prepare(
          `SELECT * FROM improvement_proposals WHERE status = ?
            ORDER BY created_at DESC LIMIT ?`,
        )
          .bind(status, limit)
          .all<ProposalRow>()
      : await this.env.ARCADIA_DB.prepare(
          `SELECT * FROM improvement_proposals
            ORDER BY created_at DESC LIMIT ?`,
        )
          .bind(limit)
          .all<ProposalRow>();
    return rows.results.map(fromRow);
  }

  /** Mark a proposal resolved. Does not apply the change — callers do that. */
  async resolve(
    id: string,
    status: Extract<ProposalStatus, "approved" | "rejected" | "applied">,
    resolvedBy: string,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `UPDATE improvement_proposals
          SET status = ?, resolved_at = datetime('now'), resolved_by = ?
        WHERE id = ?`,
    )
      .bind(status, resolvedBy, id)
      .run();
  }
}
