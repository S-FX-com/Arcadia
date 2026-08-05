// Append-only action audit (§8). Every action, doctrine entry used, and
// escalation lands here. Rows are never updated or deleted.

import type { AuditEntry } from "../schema/types";

export async function appendAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (actor, action, subject, workflow_id, doctrine_entries, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      entry.actor,
      entry.action,
      entry.subject ?? null,
      entry.workflowId ?? null,
      JSON.stringify(entry.doctrineEntries ?? []),
      entry.detail ?? null
    )
    .run();
}

export interface AuditRow {
  seq: number;
  actor: string;
  action: string;
  subject: string | null;
  workflow_id: string | null;
  doctrine_entries: string;
  detail: string | null;
  created_at: string;
}

export async function recentAudit(db: D1Database, limit = 50): Promise<AuditRow[]> {
  const res = await db
    .prepare(`SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?1`)
    .bind(limit)
    .all<AuditRow>();
  return res.results;
}
