// Loop URLs bound to a workspace. A link, not a crawl. Stored beside
// client_bindings because that table's type CHECK cannot grow in place.

import { appendAudit } from "../lib/audit";
import type { UserRecord } from "../lib/rbac";
import { isRepositoryAudience } from "../lib/repository-audience";

export interface LoopBinding {
  id: string;
  client_id: string;
  url: string;
  label: string;
  added_by: string;
  added_at: string;
}

export function validateLoopUrl(value: string): string | undefined {
  const url = value.trim();
  if (!url) return "URL is required";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "Loop URL must be https://";
  } catch {
    return "Loop URL must be a valid https:// URL";
  }
  return undefined;
}

export async function listLoopBindings(env: Env, clientId: string): Promise<LoopBinding[]> {
  const rows = await env.DB.prepare(
    `SELECT id, client_id, url, label, added_by, added_at
       FROM client_loop_bindings WHERE client_id = ?1 ORDER BY added_at`
  )
    .bind(clientId)
    .all<LoopBinding>();
  return rows.results;
}

/** Temporary audience (27 September 2026): superadmin only. */
export async function addLoopBinding(
  env: Env,
  user: UserRecord,
  input: { clientId: string; url: string; label: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isRepositoryAudience(user)) {
    return { ok: false, reason: "Loop bindings are limited to superadmin for now" };
  }
  const invalid = validateLoopUrl(input.url);
  if (invalid) return { ok: false, reason: invalid };
  const client = await env.DB.prepare(`SELECT id FROM clients WHERE id = ?1`).bind(input.clientId).first();
  if (!client) return { ok: false, reason: "client not found" };
  const label = input.label.trim() || input.url.trim();
  await env.DB.prepare(
    `INSERT INTO client_loop_bindings (id, client_id, url, label, added_by) VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(crypto.randomUUID(), input.clientId, input.url.trim(), label, user.email)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "client_loop_bound",
    subject: input.clientId,
    detail: label,
  });
  return { ok: true };
}
