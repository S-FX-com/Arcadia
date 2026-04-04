// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Graph API: User Resolution
//
// Resolves AAD user IDs to display names with KV caching.
// ─────────────────────────────────────────────────────────────────────────────

import { graphGet } from "./client.js";
import type { Env, GraphUser } from "../types.js";

const USER_CACHE_TTL = 86400; // 24 hours

function userCacheKey(userId: string): string {
  return `user:${userId}`;
}

/**
 * Resolve an AAD user ID to a display name.
 * Results are cached in KV for 24 hours.
 * Returns null if the user cannot be resolved.
 */
export async function resolveUser(userId: string, env: Env): Promise<string | null> {
  const cacheKey = userCacheKey(userId);

  // Check KV cache
  const cached = await env.ARCADIA_CACHE.get(cacheKey);
  if (cached) return cached;

  // Fetch from Graph
  try {
    const user = await graphGet<GraphUser>(`/users/${userId}`, env);
    const displayName = user.displayName;
    await env.ARCADIA_CACHE.put(cacheKey, displayName, {
      expirationTtl: USER_CACHE_TTL,
    });
    return displayName;
  } catch {
    // User may be a service account or deleted — return null gracefully
    return null;
  }
}

/**
 * Resolve multiple user IDs in parallel, returning a map of id → displayName.
 */
export async function resolveUsers(
  userIds: string[],
  env: Env
): Promise<Map<string, string>> {
  const results = await Promise.all(
    userIds.map(async (id) => {
      const name = await resolveUser(id, env);
      return [id, name ?? id] as [string, string];
    })
  );
  return new Map(results);
}
