// Channel + chat message operations on Microsoft Graph.
//
// Reads delta + non-delta message lists, reads replies, posts new
// messages, posts replies. Used by the digest engine, the activity
// handler, and the ingest pipeline.

import type { Env } from "../env";
import { graph } from "./client";

export interface ChatMessage {
  id: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  from?: {
    user?: { id?: string; displayName?: string };
    application?: { id?: string; displayName?: string };
  };
  body: { content: string; contentType: "html" | "text" };
  channelIdentity?: { teamId: string; channelId: string };
  attachments?: { id: string; name?: string; contentType?: string }[];
  mentions?: { id: number; mentionText?: string; mentioned?: unknown }[];
  replyToId?: string;
}

export interface MessagePage<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export async function listChannelMessages(
  env: Env,
  teamId: string,
  channelId: string,
  opts: { top?: number; expand?: string[]; deltaToken?: string } = {},
): Promise<MessagePage<ChatMessage>> {
  const path = opts.deltaToken
    ? `/teams/${teamId}/channels/${channelId}/messages/delta`
    : `/teams/${teamId}/channels/${channelId}/messages`;
  return graph(env, {
    path,
    query: {
      $top: opts.top ?? 50,
      $expand: opts.expand?.join(","),
      $deltatoken: opts.deltaToken,
    },
  });
}

export async function listChannelReplies(
  env: Env,
  teamId: string,
  channelId: string,
  messageId: string,
  opts: { top?: number } = {},
): Promise<MessagePage<ChatMessage>> {
  return graph(env, {
    path: `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`,
    query: { $top: opts.top ?? 50 },
  });
}

export async function postChannelMessage(
  env: Env,
  teamId: string,
  channelId: string,
  body: {
    content: string;
    contentType?: "html" | "text";
    attachments?: {
      id: string;
      contentType: string;
      content: string;
      name?: string;
    }[];
  },
): Promise<ChatMessage> {
  return graph(env, {
    method: "POST",
    path: `/teams/${teamId}/channels/${channelId}/messages`,
    body: {
      body: { content: body.content, contentType: body.contentType ?? "html" },
      attachments: body.attachments,
    },
  });
}

export async function postChannelReply(
  env: Env,
  teamId: string,
  channelId: string,
  parentMessageId: string,
  body: { content: string; contentType?: "html" | "text" },
): Promise<ChatMessage> {
  return graph(env, {
    method: "POST",
    path: `/teams/${teamId}/channels/${channelId}/messages/${parentMessageId}/replies`,
    body: {
      body: { content: body.content, contentType: body.contentType ?? "html" },
    },
  });
}

export async function listChatMessages(
  env: Env,
  chatId: string,
  opts: { top?: number } = {},
): Promise<MessagePage<ChatMessage>> {
  return graph(env, {
    path: `/chats/${chatId}/messages`,
    query: { $top: opts.top ?? 50 },
  });
}

export async function postChatMessage(
  env: Env,
  chatId: string,
  body: { content: string; contentType?: "html" | "text" },
): Promise<ChatMessage> {
  return graph(env, {
    method: "POST",
    path: `/chats/${chatId}/messages`,
    body: {
      body: { content: body.content, contentType: body.contentType ?? "html" },
    },
  });
}
