// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Passive message caching
//
// Every incoming channel/group message is appended to a rolling KV-backed
// cache regardless of whether Arcadia responds. Threaded replies to one of
// Arcadia's own posts are marked `isBot: true` so downstream summaries can
// filter them out and avoid feedback loops.
// ─────────────────────────────────────────────────────────────────────────────

import { cacheMessages, isBotMessageId } from "../memory/kv.js";
import type { ChannelMessage, Env, TeamsActivity } from "../types.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "passive-cache" });

export async function passiveCacheMessage(
  activity: TeamsActivity,
  teamId: string,
  channelId: string,
  env: Env,
  cleanText: string
): Promise<void> {
  if (!cleanText.trim()) return;

  let isReplyToBot = false;
  if (activity.replyToId) {
    isReplyToBot = await isBotMessageId(teamId, channelId, activity.replyToId, env).catch(swallow(log, "bot_message_check_failed", false, { teamId, channelId, replyToId: activity.replyToId }));
  }

  const msg: ChannelMessage = {
    id: activity.id,
    timestamp: activity.timestamp ?? new Date().toISOString(),
    authorId: activity.from.id,
    authorName: activity.from.name ?? activity.from.id,
    text: cleanText,
    isBot: isReplyToBot,
    ...(activity.replyToId !== undefined ? { replyToId: activity.replyToId } : {}),
  };

  const max = parseInt(env.MAX_MESSAGES_CACHED ?? "100", 10);
  await cacheMessages(teamId, channelId, [msg], env, max);
}
