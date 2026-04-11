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
    "/me/joinedTeams?$select=id,displayName,description&$top=50",
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
    "/me/chats?$select=id,topic,chatType,lastUpdatedDateTime&$orderby=lastUpdatedDateTime desc&$top=25",
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
