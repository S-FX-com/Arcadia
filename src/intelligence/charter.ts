// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — User Operating Charter (Phase 17)
//
// Read/write helpers for the user_charter table. Sibling pattern to
// profiles.ts: a single resolveUserCharter() the pipeline calls before every
// conversational turn, plus thin CRUD used by the webapp API.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, UserCharter, UserCharterRow } from "../types.js";

/** Hard upper bound on charter content size, enforced on write. */
export const CHARTER_MAX_BYTES = 2048;

/** Days after which the charter UI nudges the user to review. */
export const CHARTER_REVIEW_INTERVAL_DAYS = 90;

function rowToCharter(row: UserCharterRow): UserCharter {
  return {
    content: row.content,
    version: row.version,
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    lastReviewedAt:
      row.last_reviewed_at != null
        ? new Date(row.last_reviewed_at * 1000).toISOString()
        : null,
  };
}

/**
 * Load the charter for a user, or null if none has been authored yet.
 * Called on every conversational turn — must stay fast.
 */
export async function resolveUserCharter(
  userAadId: string,
  env: Env,
): Promise<UserCharter | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT user_aad_id, content, version, updated_at, last_reviewed_at
       FROM user_charter WHERE user_aad_id = ?`,
  )
    .bind(userAadId)
    .first<UserCharterRow>();

  if (!row) return null;
  return rowToCharter(row);
}

export type CharterWriteResult =
  | { ok: true; charter: UserCharter }
  | { ok: false; reason: "too_large"; bytes: number };

/**
 * Upsert the charter for a user. Increments `version` on every write,
 * sets `last_reviewed_at = updated_at` so saving counts as a review.
 *
 * Rejects content over CHARTER_MAX_BYTES — determinism is the point of
 * the cap, so callers must surface the error rather than truncating.
 */
export async function upsertUserCharter(
  userAadId: string,
  content: string,
  env: Env,
): Promise<CharterWriteResult> {
  const trimmed = content.replace(/\r\n/g, "\n");
  const byteLength = new TextEncoder().encode(trimmed).byteLength;
  if (byteLength > CHARTER_MAX_BYTES) {
    return { ok: false, reason: "too_large", bytes: byteLength };
  }

  const now = Math.floor(Date.now() / 1000);

  await env.ARCADIA_DB.prepare(
    `INSERT INTO user_charter (user_aad_id, content, version, updated_at, last_reviewed_at)
       VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(user_aad_id) DO UPDATE SET
       content          = excluded.content,
       version          = user_charter.version + 1,
       updated_at       = excluded.updated_at,
       last_reviewed_at = excluded.last_reviewed_at`,
  )
    .bind(userAadId, trimmed, now, now)
    .run();

  const charter = await resolveUserCharter(userAadId, env);
  if (!charter) {
    // Should be unreachable — INSERT ... ON CONFLICT just succeeded.
    throw new Error("Charter upsert succeeded but row not found on read-back");
  }
  return { ok: true, charter };
}

/**
 * Bump only `last_reviewed_at` — used when the user has read the charter
 * and confirmed it is still accurate without making edits.
 * No-op (returns null) when the user has no charter yet.
 */
export async function markCharterReviewed(
  userAadId: string,
  env: Env,
): Promise<UserCharter | null> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE user_charter SET last_reviewed_at = ? WHERE user_aad_id = ?`,
  )
    .bind(now, userAadId)
    .run();

  // UPDATE with no matching row is a no-op; read-back returns null in that case.
  return resolveUserCharter(userAadId, env);
}
