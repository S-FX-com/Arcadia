// Teams channel + chat message producer.
//
// Channel messages ride the real delta endpoint
// (/teams/{teamId}/channels/{channelId}/messages/delta) walked via
// graphAllPages, persisting the @odata.deltaLink verbatim in delta_state.
// Channels come from the `channels` table (all enabled, regardless of
// service_url — service_url only matters for proactive posting).
//
// Chat messages have NO delta endpoint. Instead of the old bogus
// $deltatoken on /chats/{id}/messages, freshness rides a
// lastModifiedDateTime watermark stored in delta_state (resource
// 'chat_messages', the delta_token column holds the ISO watermark). Each
// run pulls messages newer than the watermark ($filter + $orderby desc),
// walks until it crosses the watermark, and advances it to the newest seen.

import type { Env } from "../../env";
import type { Logger } from "../../lib/logger";
import { loadDeltaToken, saveDeltaToken } from "../../graph/delta";
import type { GraphRequest } from "../../graph/client";
import type { IngestMessage } from "../types";
import { defaultProducerDeps, type ProducerDeps } from "./deps";

interface ChannelRow {
  channel_id: string;
  team_id: string;
  display_name: string | null;
}

interface ChatDbRow {
  chat_id: string;
}

interface GraphMessage {
  id: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  from?: { user?: { id?: string; displayName?: string } };
  body?: { content?: string; contentType?: "text" | "html" };
}

const RESOURCE_CHANNEL = "channel_messages";
const RESOURCE_CHAT = "chat_messages";
const CHAT_INITIAL_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;

export interface MessagesProducerResult {
  enqueued: number;
  channels: number;
  chats: number;
  failures: number;
}

export async function produceMessages(
  env: Env,
  log: Logger,
  deps: ProducerDeps = defaultProducerDeps,
): Promise<MessagesProducerResult> {
  const result: MessagesProducerResult = {
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
      result.enqueued += await walkChannel(env, channel, log, deps);
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
  ).all<ChatDbRow>();

  for (const chat of chats.results) {
    try {
      result.enqueued += await walkChat(env, chat.chat_id, log, deps);
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
  deps: ProducerDeps,
): Promise<number> {
  const scopeKey = `${channel.team_id}|${channel.channel_id}`;
  const stored = await loadDeltaToken(env, RESOURCE_CHANNEL, scopeKey);
  const req: GraphRequest = stored
    ? { path: stored }
    : {
        path: `/teams/${channel.team_id}/channels/${channel.channel_id}/messages/delta`,
        query: { $top: "50" },
      };

  const { items, deltaLink } = await deps.graphAllPages<GraphMessage>(env, req, {
    maxPages: 50,
  });

  let count = 0;
  for (const m of items) {
    if (!m.body?.content) continue;
    const ts = m.lastModifiedDateTime ?? m.createdDateTime;
    const msg: IngestMessage = {
      source: "teams_channel_message",
      resourceId: m.id,
      body: {
        content: m.body.content,
        contentType: m.body.contentType === "text" ? "text" : "html",
      },
      scope: { resourceType: "channel", resourceId: channel.channel_id },
      ...(m.from?.user?.displayName ? { title: m.from.user.displayName } : {}),
      ...(m.from?.user?.id ? { ownerAadId: m.from.user.id } : {}),
      ...(ts ? { lastModifiedAt: ts } : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (deltaLink) await saveDeltaToken(env, RESOURCE_CHANNEL, scopeKey, deltaLink);
  log.info("ingest_channel_walked", {
    channelId: channel.channel_id,
    enqueued: count,
  });
  return count;
}

async function walkChat(
  env: Env,
  chatId: string,
  log: Logger,
  deps: ProducerDeps,
): Promise<number> {
  const stored = await loadDeltaToken(env, RESOURCE_CHAT, chatId);
  const watermark =
    stored ??
    new Date(deps.now().getTime() - CHAT_INITIAL_LOOKBACK_DAYS * DAY_MS).toISOString();

  const { items } = await deps.graphAllPages<GraphMessage>(
    env,
    {
      path: `/chats/${chatId}/messages`,
      query: {
        $filter: `lastModifiedDateTime gt ${watermark}`,
        $orderby: "lastModifiedDateTime desc",
        $top: "50",
      },
    },
    { maxPages: 20 },
  );

  let count = 0;
  let newest = watermark;
  for (const m of items) {
    const ts = m.lastModifiedDateTime ?? m.createdDateTime;
    // Ordered newest-first: once we cross the watermark the rest are older.
    if (ts && ts <= watermark) break;
    if (ts && ts > newest) newest = ts;
    if (!m.body?.content) continue;

    const msg: IngestMessage = {
      source: "chat_message",
      resourceId: m.id,
      body: {
        content: m.body.content,
        contentType: m.body.contentType === "text" ? "text" : "html",
      },
      scope: { resourceType: "chat", resourceId: chatId },
      ...(m.from?.user?.id ? { ownerAadId: m.from.user.id } : {}),
      ...(ts ? { lastModifiedAt: ts } : {}),
    };
    await deps.send(env, msg);
    count += 1;
  }

  if (newest !== watermark) await saveDeltaToken(env, RESOURCE_CHAT, chatId, newest);
  log.info("ingest_chat_walked", { chatId, enqueued: count });
  return count;
}
