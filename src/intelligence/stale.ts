// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Stale Thread Detection
//
// Identifies threads that have been inactive beyond a threshold and surfaces
// them for intervention.
// ─────────────────────────────────────────────────────────────────────────────

import { getChannelMessages } from "../graph/messages.js";
import { getStaleThreads, markThreadStale, upsertThread } from "../memory/d1.js";
import { callAI } from "../ai/router.js";
import { buildStalePrompt } from "../ai/prompts.js";
import { detectConversationLanguage } from "./context.js";
import type { ChannelMessage, Env, StaleThread } from "../types.js";

/**
 * Group a flat list of messages into thread chains by replyToId.
 * Returns a map of root message ID → all messages in that thread.
 */
function groupIntoThreads(
  messages: ChannelMessage[]
): Map<string, ChannelMessage[]> {
  const threads = new Map<string, ChannelMessage[]>();

  for (const msg of messages) {
    const rootId = msg.replyToId ?? msg.id;
    const thread = threads.get(rootId) ?? [];
    thread.push(msg);
    threads.set(rootId, thread);
  }

  return threads;
}

/**
 * Detect stale threads in a channel and return them with context.
 *
 * @param teamId      - Teams group ID
 * @param channelId   - Teams channel ID
 * @param staleHours  - Hours of inactivity to consider a thread stale
 * @param env         - Cloudflare Worker env bindings
 */
export async function detectStaleThreads(
  teamId: string,
  channelId: string,
  staleHours: number,
  env: Env
): Promise<StaleThread[]> {
  // Fetch recent messages (last 100)
  let messages: ChannelMessage[] = [];
  try {
    messages = await getChannelMessages(teamId, channelId, env, 100);
  } catch (err) {
    console.error("Failed to fetch messages for stale detection:", err);
    return [];
  }

  // Update thread activity in D1
  const threads = groupIntoThreads(messages);
  for (const [rootId, threadMessages] of threads) {
    const lastMsg = threadMessages
      .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))[0];
    if (!lastMsg) continue;

    const lastActivity = Math.floor(new Date(lastMsg.timestamp).getTime() / 1000);
    const participants = [...new Set(threadMessages.map((m) => m.authorName))];
    const owner = participants[0] ?? null;

    await upsertThread(rootId, teamId, channelId, lastActivity, owner, env);
  }

  // Query D1 for stale threads
  const staleRows = await getStaleThreads(teamId, channelId, staleHours, env);

  const staleThreads: StaleThread[] = [];

  for (const row of staleRows) {
    const threadMessages = threads.get(row.id) ?? [];
    const lastParticipants = [
      ...new Set(threadMessages.map((m) => m.authorName)),
    ];
    const hoursSince =
      (Math.floor(Date.now() / 1000) - row.last_activity) / 3600;

    staleThreads.push({
      messageId: row.id,
      channelId: row.channel_id,
      teamId: row.team_id,
      lastActivityAt: new Date(row.last_activity * 1000).toISOString(),
      hoursSinceActivity: Math.floor(hoursSince),
      lastParticipants,
    });

    // Mark as stale in D1
    await markThreadStale(row.id, env);
  }

  return staleThreads;
}

/**
 * Generate a natural-language stale thread notice for posting in Teams.
 */
export async function buildStaleNotice(
  stale: StaleThread,
  messages: ChannelMessage[],
  env: Env
): Promise<string> {
  const language = detectConversationLanguage(messages);
  const { system, user } = buildStalePrompt(messages, stale.hoursSinceActivity, language);
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Format a simple stale thread alert (no AI — just metadata).
 * Used as a fallback or when AI is not needed.
 */
export function formatStaleAlert(stale: StaleThread): string {
  const participants =
    stale.lastParticipants.length > 0
      ? stale.lastParticipants.join(", ")
      : "unknown participants";

  return [
    `**Thread inactive for ${stale.hoursSinceActivity}h**`,
    `Last participants: ${participants}`,
    `Last activity: ${stale.lastActivityAt.slice(0, 10)}`,
    "",
    "No assigned owner. Consider assigning ownership and setting a deadline.",
  ].join("\n");
}
