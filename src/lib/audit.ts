// Append-only action audit (governing rule 3). Every mutation lands here with
// the actor, the action, the subject and a summary. Rows are never updated or
// deleted.

import type { AuditEntry } from "../schema/types";

export async function appendAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(`INSERT INTO audit_log (actor, action, subject, detail) VALUES (?1, ?2, ?3, ?4)`)
    .bind(entry.actor, entry.action, entry.subject ?? null, entry.detail ?? null)
    .run();
}
