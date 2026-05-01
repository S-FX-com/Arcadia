// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — User Presence Context Provider
//
// Fetches the authenticated user's current presence/availability via the
// delegated Presence.Read scope. Returns a single UserPresence object.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { UserPresence } from "../types.js";

interface GraphPresence {
  availability: string;
  activity: string;
}

/**
 * Returns the authenticated user's current Teams presence status.
 * Requires Presence.Read delegated scope.
 */
export async function getUserPresence(accessToken: string): Promise<UserPresence> {
  const res = await userGraphGet<GraphPresence>(
    "/me/presence?$select=availability,activity",
    accessToken,
  );
  return {
    availability: (res.availability as UserPresence["availability"]) ?? "PresenceUnknown",
    activity: res.activity ?? "Unknown",
  };
}
