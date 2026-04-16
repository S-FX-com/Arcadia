// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Unified conversation message fetcher (app token)
//
// Single entry point for bot/summarize/qa paths. Routes by conversationType:
//   - personal   → KV cache only (Graph cannot read 1:1 bot DMs)
//   - groupChat  → /chats/{chatId}/messages, write-through cache
//   - channel    → /teams/{teamId}/channels/{channelId}/messages, write-through cache
//
// On Graph failure, falls back to KV cache when useCacheFallback is true.
//
// NOTE: webapp/context/teams.ts intentionally uses the user's delegated token
// (userGraphGet) and is NOT routed through here — different auth model.
// ─────────────────────────────────────────────────────────────────────────────

import { getChannelMessages, getChatMessages } from "./messages.js";
import { loadCachedMessages, cacheMessages } from "../memory/kv.js";
import type { ChannelMessage, Env } from "../types.js";

export type ConversationType = "personal" | "groupChat" | "channel";

export interface FetchConversationOptions {
  teamId?: string | undefined;
  channelId?: string | undefined;
  chatId?: string | undefined;
  conversationType: ConversationType;
  limit?: number | undefined;
  useCacheFallback?: boolean | undefined;
}

/**
 * Fetch recent messages for a Teams conversation using the app (bot) token.
 * Returns [] on error when useCacheFallback is false.
 */
export async function fetchConversationMessages(
  env: Env,
  opts: FetchConversationOptions
): Promise<ChannelMessage[]> {
  const {
    teamId,
    channelId,
    chatId,
    conversationType,
    limit = 50,
    useCacheFallback = true,
  } = opts;

  if (conversationType === "personal") {
    if (!teamId || !channelId) return [];
    return loadCachedMessages(teamId, channelId, env);
  }

  try {
    if (conversationType === "groupChat") {
      const id = chatId ?? channelId;
      if (!id) return [];
      const fresh = await getChatMessages(id, env, limit);
      if (teamId && channelId) {
        await cacheMessages(teamId, channelId, fresh, env);
      }
      return fresh;
    }

    // channel
    if (!teamId || !channelId) return [];
    const fresh = await getChannelMessages(teamId, channelId, env, limit);
    await cacheMessages(teamId, channelId, fresh, env);
    return fresh;
  } catch (err) {
    console.error("[Arcadia] fetchConversationMessages error:", err);
    if (useCacheFallback && teamId && channelId) {
      return loadCachedMessages(teamId, channelId, env);
    }
    return [];
  }
}
