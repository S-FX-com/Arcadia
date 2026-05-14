// Per-resource delta-query state.
//
// Graph delta tokens let us walk only what's changed since the last poll.
// Each (resource, scope) pair owns its token, persisted in delta_state.

import type { Env } from "../env";

export async function loadDeltaToken(
  env: Env,
  resource: string,
  scopeKey: string,
): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(resource, scopeKey)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

export async function saveDeltaToken(
  env: Env,
  resource: string,
  scopeKey: string,
  token: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(resource, scopeKey, token, new Date().toISOString())
    .run();
}

export function tokenFromDeltaLink(
  deltaLink: string | undefined,
): string | null {
  if (!deltaLink) return null;
  try {
    return new URL(deltaLink).searchParams.get("$deltatoken");
  } catch {
    return null;
  }
}
