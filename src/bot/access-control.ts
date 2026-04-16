// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Access Control
//
// Centralized admin/owner checks shared by the Teams bot and the webapp.
// Cross-user / cross-channel queries are restricted to ADMIN_USER_AAD_ID.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, TeamsActivity } from "../types.js";

export function getUserIdFromActivity(activity: TeamsActivity): string {
  return activity.from.aadObjectId ?? activity.from.id;
}

export function isAdminUserId(userId: string | undefined | null, env: Env): boolean {
  if (!env.ADMIN_USER_AAD_ID || !userId) return false;
  return userId === env.ADMIN_USER_AAD_ID;
}

export function isAdminActivity(activity: TeamsActivity, env: Env): boolean {
  return isAdminUserId(getUserIdFromActivity(activity), env);
}

const CROSS_SCOPE_PATTERN =
  /\b(other\s+user|all\s+user|someone\s+else|everyone|all\s+staff|all\s+people|cross.channel|other\s+channel|all\s+channel|entire\s+tenant|across\s+the\s+org|other\s+team|tell\s+me\s+about\s+[A-Z]|what\s+is\s+\w+\s+working|habits\s+of|profile\s+of|patterns\s+of)\b/i;

export function requiresAdminAccess(rawText: string): boolean {
  return CROSS_SCOPE_PATTERN.test(rawText);
}
