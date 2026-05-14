// Teams channel + chat message producer.
//
// For each registered channel/chat, walks the delta API and enqueues
// new or modified messages into the ingest queue. The delta cursor
// lives in the delta_state table keyed by (resource, scope_key).
//
// Cron-driven: a "delta tick" cron fires this; the queue consumer
// handles the actual indexing.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { graph } from "../../graph/client";
import type { IngestMessage } from "../types";

interface ChannelRow {
  channel_id: string;
  team_id: string;
  display_name: string | null;
}

interface ChatRow {
  chat_id: string;
}

interface MessagePage {
  value: {
    id: string;
    createdDateTime: string;
    lastModifiedDateTime?: string;
    from?: { user?: { id?: string; displayName?: string } };
    body?: { content?: string; contentType?: "text" | "html" };
    channelIdentity?: { teamId?: string; channelId?: string };
  }[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const RESOURCE_CHANNEL = "teams_channel_messages";
const RESOURCE_CHAT = "chat_messages";

export interface ProducerResult {
  enqueued: number;
  channels: number;
  chats: number;
  failures: number;
}

export async function produceMessages(
  env: Env,
  log: Logger,
): Promise<ProducerResult> {
  const result: ProducerResult = {
    enqueued: 0,
    channels: 0,
    chats: 0,
    failures: 0,
  };

  const channels = await env.ARCADIA_DB.prepare(
    `SELECT channel_id, team_id, display_name FROM channels WHERE enabled = 1`,
  ).all<ChannelRow>();

  for (const channel of channels.results) {
    try {
      const enqueued = await walkChannel(env, channel, log);
      result.enqueued += enqueued;
      result.channels += 1;
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_channel_walk_failed", {
        channelId: channel.channel_id,
        error: String(e),
      });
    }
  }

  const chats = await env.ARCADIA_DB.prepare(
    `SELECT chat_id FROM chats`,
  ).all<ChatRow>();
  for (const chat of chats.results) {
    try {
      const enqueued = await walkChat(env, chat, log);
      result.enqueued += enqueued;
      result.chats += 1;
    } catch (e) {
      result.failures += 1;
      log.warn("ingest_chat_walk_failed", {
        chatId: chat.chat_id,
        error: String(e),
      });
    }
  }

  log.info("ingest_produced_messages", result);
  return result;
}

async function walkChannel(
  env: Env,
  channel: ChannelRow,
  log: Logger,
): Promise<number> {
  const scopeKey = `${channel.team_id}|${channel.channel_id}`;
  const cursor = await readCursor(env, RESOURCE_CHANNEL, scopeKey);

  let url: string | undefined;
  let count = 0;
  let lastLink: string | undefined;

  do {
    const page: MessagePage = url
      ? await graph<MessagePage>(env, { path: url })
      : await graph<MessagePage>(env, {
          path: `/teams/${channel.team_id}/channels/${channel.channel_id}/messages/delta`,
          query: { $top: 50, ...(cursor ? { $deltatoken: cursor } : {}) },
        });

    for (const m of page.value) {
      if (!m.body?.content) continue;
      const msg: IngestMessage = {
        source: "teams_channel_message",
        resourceId: m.id,
        body: {
          content: m.body.content,
          contentType: m.body.contentType === "text" ? "text" : "html",
        },
        scope: {
          resourceType: "channel",
          resourceId: channel.channel_id,
        },
        ...(m.from?.user?.displayName ? { title: m.from.user.displayName } : {}),
        ...(m.from?.user?.id ? { ownerAadId: m.from.user.id } : {}),
        ...(m.lastModifiedDateTime
          ? { lastModifiedAt: m.lastModifiedDateTime }
          : m.createdDateTime
            ? { lastModifiedAt: m.createdDateTime }
            : {}),
      };
      await env.INGEST_QUEUE.send(msg);
      count += 1;
    }

    url = page["@odata.nextLink"];
    if (page["@odata.deltaLink"]) lastLink = page["@odata.deltaLink"];
  } while (url);

  if (lastLink) {
    const newToken = extractDeltaToken(lastLink);
    if (newToken) await writeCursor(env, RESOURCE_CHANNEL, scopeKey, newToken);
  }

  log.info("ingest_channel_walked", {
    channelId: channel.channel_id,
    enqueued: count,
  });
  return count;
}

async function walkChat(
  env: Env,
  chat: ChatRow,
  log: Logger,
): Promise<number> {
  const scopeKey = chat.chat_id;
  const cursor = await readCursor(env, RESOURCE_CHAT, scopeKey);

  let url: string | undefined;
  let count = 0;
  let lastLink: string | undefined;

  do {
    const page: MessagePage = url
      ? await graph<MessagePage>(env, { path: url })
      : await graph<MessagePage>(env, {
          path: `/chats/${chat.chat_id}/messages`,
          query: { $top: 50, ...(cursor ? { $deltatoken: cursor } : {}) },
        });

    for (const m of page.value) {
      if (!m.body?.content) continue;
      const msg: IngestMessage = {
        source: "chat_message",
        resourceId: m.id,
        body: {
          content: m.body.content,
          contentType: m.body.contentType === "text" ? "text" : "html",
        },
        scope: { resourceType: "chat", resourceId: chat.chat_id },
        ...(m.from?.user?.id ? { ownerAadId: m.from.user.id } : {}),
        ...(m.lastModifiedDateTime
          ? { lastModifiedAt: m.lastModifiedDateTime }
          : m.createdDateTime
            ? { lastModifiedAt: m.createdDateTime }
            : {}),
      };
      await env.INGEST_QUEUE.send(msg);
      count += 1;
    }

    url = page["@odata.nextLink"];
    if (page["@odata.deltaLink"]) lastLink = page["@odata.deltaLink"];
  } while (url);

  if (lastLink) {
    const newToken = extractDeltaToken(lastLink);
    if (newToken) await writeCursor(env, RESOURCE_CHAT, scopeKey, newToken);
  }

  log.info("ingest_chat_walked", { chatId: chat.chat_id, enqueued: count });
  return count;
}

async function readCursor(
  env: Env,
  resource: string,
  scopeKey: string,
): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT delta_token FROM delta_state WHERE resource = ? AND scope_key = ?`,
  )
    .bind(resource, scopeKey)
    .first<{ delta_token: string }>();
  return row?.delta_token ?? null;
}

async function writeCursor(
  env: Env,
  resource: string,
  scopeKey: string,
  token: string,
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT OR REPLACE INTO delta_state
       (resource, scope_key, delta_token, last_run_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(resource, scopeKey, token, new Date().toISOString())
    .run();
}

function extractDeltaToken(deltaLink: string): string | null {
  const m = deltaLink.match(/[?&]\$deltatoken=([^&]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
