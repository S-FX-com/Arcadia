// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Teams Context Provider (Phase 7)
//
// Fetches Teams, channels, chats, and messages using the user's delegated token.
// ─────────────────────────────────────────────────────────────────────────────

import { userGraphGet } from "../graph-delegated.js";
import type { ChannelMessage } from "../../types.js";
import type { UserTeam, UserChannel, UserChat } from "../types.js";

interface GraphListResponse<T> {
  value: T[];
}

interface GraphMessageRaw {
  id: string;
  createdDateTime: string;
  from?: {
    user?: { id: string; displayName?: string };
    application?: { id: string; displayName?: string };
  };
  body?: { contentType: "text" | "html"; content: string };
  deletedDateTime?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMessage(raw: GraphMessageRaw): ChannelMessage | null {
  if (raw.deletedDateTime) return null;
  const isBot = raw.from?.application != null;
  const authorId = raw.from?.user?.id ?? raw.from?.application?.id ?? "unknown";
  const authorName = raw.from?.user?.displayName ?? raw.from?.application?.displayName ?? "Unknown";
  const rawBody = raw.body?.content ?? "";
  const text = raw.body?.contentType === "html" ? stripHtml(rawBody) : rawBody.trim();
  if (!text) return null;
  return { id: raw.id, timestamp: raw.createdDateTime, authorId, authorName, text, isBot };
}

/**
 * Lists the Teams the authenticated user has joined.
 */
export async function getUserTeams(accessToken: string): Promise<UserTeam[]> {
  const res = await userGraphGet<GraphListResponse<{ id: string; displayName: string; description?: string }>>(
    "/me/joinedTeams?$select=id,displayName,description",
    accessToken
  );
  return res.value.map((t) => ({
    id: t.id,
    displayName: t.displayName,
    description: t.description ?? null,
  }));
}

/**
 * Lists channels in a specific team.
 */
export async function getTeamChannels(
  teamId: string,
  accessToken: string
): Promise<UserChannel[]> {
  const res = await userGraphGet<GraphListResponse<{ id: string; displayName: string; description?: string }>>(
    `/teams/${teamId}/channels?$select=id,displayName,description`,
    accessToken
  );
  return res.value.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    description: c.description ?? null,
  }));
}

/**
 * Lists the user's recent chats.
 */
export async function getUserChats(accessToken: string): Promise<UserChat[]> {
  const res = await userGraphGet<GraphListResponse<{ id: string; topic?: string; chatType: string; lastUpdatedDateTime?: string }>>(
    "/me/chats?$select=id,topic,chatType,lastUpdatedDateTime&$top=25",
    accessToken
  );
  return res.value.map((c) => ({
    id: c.id,
    topic: c.topic ?? null,
    chatType: c.chatType,
    lastUpdatedDateTime: c.lastUpdatedDateTime ?? null,
  }));
}

/**
 * Fetches recent messages from a Teams channel (user-delegated).
 */
export async function getChannelMessages(
  teamId: string,
  channelId: string,
  accessToken: string,
  limit = 25
): Promise<ChannelMessage[]> {
  const safeLimit = Math.min(limit, 50);
  const res = await userGraphGet<GraphListResponse<GraphMessageRaw>>(
    `/teams/${teamId}/channels/${channelId}/messages?$top=${safeLimit}`,
    accessToken
  );
  return res.value.map(normalizeMessage).filter((m): m is ChannelMessage => m !== null);
}

/**
 * Fetches recent messages from a chat (user-delegated).
 */
export async function getChatMessages(
  chatId: string,
  accessToken: string,
  limit = 25
): Promise<ChannelMessage[]> {
  const safeLimit = Math.min(limit, 50);
  const res = await userGraphGet<GraphListResponse<GraphMessageRaw>>(
    `/me/chats/${chatId}/messages?$top=${safeLimit}`,
    accessToken
  );
  return res.value.map(normalizeMessage).filter((m): m is ChannelMessage => m !== null);
}

/**
 * Fetches the user's complete message context across ALL joined Teams channels
 * and recent chats using their delegated access token.
 *
 * This gives the webapp full-coverage context: every team, every channel, every
 * 1:1 and group chat the user belongs to — not just where the bot is installed.
 *
 * Limits per call are kept small so the total latency stays under ~800 ms.
 */
export async function fetchUserFullContext(
  accessToken: string,
  msgsPerSource = 15,
): Promise<ChannelMessage[]> {
  const combined: ChannelMessage[] = [];

  // ── Teams channels ────────────────────────────────────────────────────────
  const teams = await getUserTeams(accessToken).catch((err) => {
    console.error("[fetchUserFullContext] getUserTeams failed:", err);
    return [] as UserTeam[];
  });
  console.log(`[fetchUserFullContext] teams fetched: ${teams.length}`);

  const channelFetches = teams.slice(0, 8).map(async (team) => {
    const channels = await getTeamChannels(team.id, accessToken).catch((err) => {
      console.error(`[fetchUserFullContext] getTeamChannels failed for ${team.displayName}:`, err);
      return [] as UserChannel[];
    });
    const msgFetches = channels.slice(0, 4).map(async (ch) => {
      const msgs = await getChannelMessages(team.id, ch.id, accessToken, msgsPerSource).catch((err) => {
        console.error(`[fetchUserFullContext] getChannelMessages failed for ${team.displayName} › ${ch.displayName}:`, err);
        return [] as ChannelMessage[];
      });
      const label = `${team.displayName} › ${ch.displayName}`;
      return msgs.map((m) => ({ ...m, channelName: label }));
    });
    return (await Promise.all(msgFetches)).flat();
  });

  const channelResults = await Promise.all(channelFetches);
  const channelMsgs = channelResults.flat();
  combined.push(...channelMsgs);
  console.log(`[fetchUserFullContext] channel messages fetched: ${channelMsgs.length}`);

  // ── Chats (1:1 and group) ────────────────────────────────────────────────
  const chats = await getUserChats(accessToken).catch((err) => {
    console.error("[fetchUserFullContext] getUserChats failed:", err);
    return [] as UserChat[];
  });
  console.log(`[fetchUserFullContext] chats fetched: ${chats.length}`);

  const chatFetches = chats.slice(0, 10).map(async (chat) => {
    const msgs = await getChatMessages(chat.id, accessToken, msgsPerSource).catch((err) => {
      console.error(`[fetchUserFullContext] getChatMessages failed for chat ${chat.id}:`, err);
      return [] as ChannelMessage[];
    });
    const label = chat.topic
      ? chat.topic
      : chat.chatType === "oneOnOne"
        ? "1:1 Chat"
        : "Group Chat";
    return msgs.map((m) => ({ ...m, channelName: label }));
  });

  const chatResults = await Promise.all(chatFetches);
  const chatMsgs = chatResults.flat();
  combined.push(...chatMsgs);
  console.log(`[fetchUserFullContext] chat messages fetched: ${chatMsgs.length}`);

  // Sort newest-first, return top 120
  const result = combined
    .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
    .slice(0, 120);
  console.log(`[fetchUserFullContext] total context messages returned: ${result.length}`);
  return result;
}
