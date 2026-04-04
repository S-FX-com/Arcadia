// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — KV Store Helpers
//
// Rolling message cache and summary storage.
// Keys:
//   msg:{teamId}:{channelId}         → last N ChannelMessage[]
//   summary:{teamId}:{channelId}:{date} → cached ParsedSummary text
//   token:graph                      → MS Graph access token (managed by graph/client.ts)
//   user:{userId}                    → display name (managed by graph/users.ts)
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelMessage, Env } from "../types.js";

const SUMMARY_TTL = 3600; // 1 hour

function msgKey(teamId: string, channelId: string): string {
  return `msg:${teamId}:${channelId}`;
}

function summaryKey(teamId: string, channelId: string, date: string): string {
  return `summary:${teamId}:${channelId}:${date}`;
}

/**
 * Load the cached messages for a channel.
 * Returns empty array if no cache exists.
 */
export async function loadCachedMessages(
  teamId: string,
  channelId: string,
  env: Env
): Promise<ChannelMessage[]> {
  const raw = await env.ARCADIA_CACHE.get(msgKey(teamId, channelId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ChannelMessage[];
  } catch {
    return [];
  }
}

/**
 * Persist a rolling window of messages to KV.
 * Merges incoming messages with cached ones and trims to maxMessages.
 * Messages are stored newest-first; duplicates are deduplicated by id.
 */
export async function cacheMessages(
  teamId: string,
  channelId: string,
  incoming: ChannelMessage[],
  env: Env,
  maxMessages = 100
): Promise<void> {
  const existing = await loadCachedMessages(teamId, channelId, env);

  // Merge + deduplicate by id
  const byId = new Map<string, ChannelMessage>();
  for (const m of [...existing, ...incoming]) {
    byId.set(m.id, m);
  }

  // Sort newest first, trim to max
  const sorted = Array.from(byId.values())
    .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
    .slice(0, maxMessages);

  await env.ARCADIA_CACHE.put(
    msgKey(teamId, channelId),
    JSON.stringify(sorted),
    { expirationTtl: 86400 * 7 } // 7 days
  );
}

/**
 * Load a cached daily summary string.
 * Returns null if not cached.
 */
export async function loadCachedSummary(
  teamId: string,
  channelId: string,
  date: string,
  env: Env
): Promise<string | null> {
  return env.ARCADIA_CACHE.get(summaryKey(teamId, channelId, date));
}

/**
 * Cache a daily summary string for 1 hour.
 */
export async function cacheSummary(
  teamId: string,
  channelId: string,
  date: string,
  content: string,
  env: Env
): Promise<void> {
  await env.ARCADIA_CACHE.put(
    summaryKey(teamId, channelId, date),
    content,
    { expirationTtl: SUMMARY_TTL }
  );
}

/**
 * Return today's date string in YYYY-MM-DD (UTC).
 */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
