// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Admin Middleware (Phase 12)
//
// Role resolution, role-based auth guards, and audit logging.
// All admin route handlers import from here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import type { WebappSession, UserRole, UserRoleRow } from "./types.js";
import { isAdminUserId } from "../bot/access-control.js";
import { errorResponse } from "../responses/formatter.js";

/** Numeric weight for role comparison. Higher = more privileged. */
function roleLevel(role: UserRole): number {
  return role === "admin" ? 3 : role === "manager" ? 2 : 1;
}

/**
 * Resolves the effective role for a session user.
 *
 * Priority:
 *   1. If userId matches ADMIN_USER_AAD_ID env var → 'admin' (bootstrap)
 *      and auto-provisions a row in user_roles so the UI can list them.
 *   2. user_roles D1 table row
 *   3. Default: 'viewer'
 */
export async function resolveRole(session: WebappSession, env: Env): Promise<UserRole> {
  const isBootstrapAdmin = isAdminUserId(session.userId, env);

  if (isBootstrapAdmin) {
    // Auto-provision admin row if missing so it appears in the Users list
    const now = Math.floor(Date.now() / 1000);
    await env.ARCADIA_DB.prepare(
      `INSERT OR IGNORE INTO user_roles
       (user_id, display_name, email, role, assigned_by, assigned_at, updated_at)
       VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
    )
      .bind(session.userId, session.displayName, session.email ?? null, session.userId, now, now)
      .run();
    return "admin";
  }

  const row = await env.ARCADIA_DB.prepare(
    "SELECT role FROM user_roles WHERE user_id = ?",
  )
    .bind(session.userId)
    .first<Pick<UserRoleRow, "role">>();

  return (row?.role as UserRole) ?? "viewer";
}

/** Result type returned by requireRole. */
export type RoleResult =
  | { ok: true; role: UserRole }
  | { ok: false; response: Response };

/**
 * Auth guard requiring at least the specified role.
 * Returns the resolved role on success, or a 403 Response on failure.
 */
export async function requireRole(
  session: WebappSession,
  minimumRole: UserRole,
  env: Env,
): Promise<RoleResult> {
  const role = await resolveRole(session, env);
  if (roleLevel(role) < roleLevel(minimumRole)) {
    return {
      ok: false,
      response: errorResponse(`Requires ${minimumRole} role`, 403),
    };
  }
  return { ok: true, role };
}

/**
 * Writes a record to admin_audit_log. Fire-and-forget — never throws.
 */
export async function auditLog(
  actor: WebappSession,
  action: string,
  targetType: string | null,
  targetId: string | null,
  payload: unknown,
  env: Env,
): Promise<void> {
  try {
    await env.ARCADIA_DB.prepare(
      `INSERT INTO admin_audit_log
       (actor_id, actor_name, action, target_type, target_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        actor.userId,
        actor.displayName,
        action,
        targetType,
        targetId,
        payload !== undefined ? JSON.stringify(payload) : null,
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch (err) {
    console.error("[Admin] Audit log write failed:", err);
  }
}
