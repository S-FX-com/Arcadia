// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Middleware (Phase 7)
//
// Authentication guard and common response helpers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import type { WebappSession } from "./types.js";
import { validateSession } from "./auth.js";
import { isAdminUserId } from "../bot/access-control.js";
import { jsonResponse, errorResponse, unauthorizedResponse } from "../responses/formatter.js";

export { jsonResponse, errorResponse };

/** Result of requireAuth — either a valid session or a 401 Response. */
export type AuthResult =
  | { ok: true; session: WebappSession }
  | { ok: false; response: Response };

/**
 * Auth guard: validates the session cookie and returns the session or a 401.
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<AuthResult> {
  const session = await validateSession(request, env);
  if (!session) {
    return {
      ok: false,
      response: unauthorizedResponse("Not authenticated"),
    };
  }
  return { ok: true, session };
}

/**
 * Checks if the user is the admin (ADMIN_USER_AAD_ID).
 */
export function isAdmin(userId: string, env: Env): boolean {
  return isAdminUserId(userId, env);
}
