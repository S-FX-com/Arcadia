// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — KV Store Helpers
//
// Rolling message cache and summary storage.
// Keys:
//   msg:{teamId}:{channelId}         → last N ChannelMessage[]
//   summary:{teamId}:{channelId}:{date} → cached ParsedSummary text
//   botmsgids:{teamId}:{channelId}   → last 50 Arcadia proactive message IDs
//   token:graph                      → MS Graph access token (managed by graph/client.ts)
//   user:{userId}                    → display name (managed by graph/users.ts)
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelMessage, ConversationTurn, Env, UserProfile } from "../types.js";

const SUMMARY_TTL = 3600; // 1 hour

function msgKey(teamId: string, channelId: string): string {
  return `msg:${teamId}:${channelId}`;
}

function summaryKey(teamId: string, channelId: string, date: string): string {
  return `summary:${teamId}:${channelId}:${date}`;
}

function botMsgIdsKey(teamId: string, channelId: string): string {
  return `botmsgids:${teamId}:${channelId}`;
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

// ─── Arcadia proactive message ID tracking ────────────────────────────────────

const BOT_MSG_IDS_TTL = 86400 * 2; // 48 hours
const BOT_MSG_IDS_MAX = 50;

/**
 * Record a message ID posted by Arcadia so that threaded replies to it
 * can be identified and excluded from channel summaries.
 */
export async function storeBotMessageId(
  teamId: string,
  channelId: string,
  messageId: string,
  env: Env
): Promise<void> {
  const raw = await env.ARCADIA_CACHE.get(botMsgIdsKey(teamId, channelId));
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(messageId)) ids.push(messageId);
  const trimmed = ids.slice(-BOT_MSG_IDS_MAX);
  await env.ARCADIA_CACHE.put(
    botMsgIdsKey(teamId, channelId),
    JSON.stringify(trimmed),
    { expirationTtl: BOT_MSG_IDS_TTL }
  );
}

/**
 * Return true if the given message ID belongs to a proactive Arcadia post.
 */
export async function isBotMessageId(
  teamId: string,
  channelId: string,
  messageId: string,
  env: Env
): Promise<boolean> {
  const raw = await env.ARCADIA_CACHE.get(botMsgIdsKey(teamId, channelId));
  if (!raw) return false;
  try {
    const ids: string[] = JSON.parse(raw);
    return ids.includes(messageId);
  } catch {
    return false;
  }
}

// ─── Phase 3: DM conversation history ────────────────────────────────────────

const DM_HISTORY_TTL = 86400 * 2; // 48 hours
const DM_HISTORY_MAX_TURNS = 20;  // keep last 20 turns (10 exchanges)

function dmHistoryKey(userId: string): string {
  return `dm:history:${userId}`;
}

// ─── Group chat conversation history ─────────────────────────────────────────

const GROUP_HISTORY_TTL = 86400 * 2;  // 48 hours
const GROUP_HISTORY_MAX_TURNS = 30;   // keep last 30 turns (15 exchanges)

function groupChatHistoryKey(conversationId: string): string {
  return `groupchat:history:${conversationId}`;
}

/**
 * Load conversation history for a group chat.
 * Keyed by conversation ID (shared across all participants).
 */
export async function loadGroupChatHistory(conversationId: string, env: Env): Promise<ConversationTurn[]> {
  const raw = await env.ARCADIA_CACHE.get(groupChatHistoryKey(conversationId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ConversationTurn[];
  } catch {
    return [];
  }
}

/**
 * Persist updated group chat history, trimmed to GROUP_HISTORY_MAX_TURNS.
 */
export async function saveGroupChatHistory(
  conversationId: string,
  turns: ConversationTurn[],
  env: Env
): Promise<void> {
  const trimmed = turns.slice(-GROUP_HISTORY_MAX_TURNS);
  await env.ARCADIA_CACHE.put(
    groupChatHistoryKey(conversationId),
    JSON.stringify(trimmed),
    { expirationTtl: GROUP_HISTORY_TTL }
  );
}

/**
 * Load a user's DM conversation history.
 * Returns empty array if no history exists.
 */
export async function loadDMHistory(userId: string, env: Env): Promise<ConversationTurn[]> {
  const raw = await env.ARCADIA_CACHE.get(dmHistoryKey(userId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ConversationTurn[];
  } catch {
    return [];
  }
}

/**
 * Persist updated DM conversation history.
 * Trims to the most recent DM_HISTORY_MAX_TURNS turns.
 */
export async function saveDMHistory(
  userId: string,
  turns: ConversationTurn[],
  env: Env
): Promise<void> {
  const trimmed = turns.slice(-DM_HISTORY_MAX_TURNS);
  await env.ARCADIA_CACHE.put(
    dmHistoryKey(userId),
    JSON.stringify(trimmed),
    { expirationTtl: DM_HISTORY_TTL }
  );
}

// ─── Phase 3: User profile cache ─────────────────────────────────────────────

const PROFILE_TTL = 86400 * 30; // 30 days

function profileKey(userId: string): string {
  return `profile:user:${userId}`;
}

/**
 * Load a cached user profile.
 * Returns null if no profile exists.
 */
export async function loadUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
  const raw = await env.ARCADIA_CACHE.get(profileKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

/**
 * Write a user profile to KV cache.
 */
export async function saveUserProfile(profile: UserProfile, env: Env): Promise<void> {
  await env.ARCADIA_CACHE.put(
    profileKey(profile.userId),
    JSON.stringify(profile),
    { expirationTtl: PROFILE_TTL }
  );
}
