// send_message — post a plain-text message to a Teams channel or chat.
//
// App-only: Arcadia posts as herself via the Bot Framework outbound lane
// (postText). The conversation reference (serviceUrl + conversationId) is
// resolved from the channels/chats topology tables. Channels store an
// explicit conversation_id; for chats the chat_id *is* the Bot Framework
// conversation id.

import type { Env } from "../../env";
import type { ActionVerb } from "../framework";
import { postText } from "../../runtime/bot-outbound";
import type { ConversationRef } from "../../runtime/bot-outbound";
import { asObject, clip, optString, reqString, type PostTextFn } from "./_util";

export interface SendMessageParams {
  text: string;
  channelId?: string;
  chatId?: string;
}

export interface SendMessageDeps {
  postText: PostTextFn;
}

async function resolveRef(
  env: Env,
  p: SendMessageParams,
): Promise<ConversationRef | null> {
  if (p.channelId) {
    const row = await env.ARCADIA_DB.prepare(
      `SELECT service_url, conversation_id FROM channels WHERE channel_id = ?`,
    )
      .bind(p.channelId)
      .first<{ service_url: string; conversation_id: string | null }>();
    if (!row?.service_url) return null;
    return {
      serviceUrl: row.service_url,
      conversationId: row.conversation_id ?? p.channelId,
    };
  }
  if (p.chatId) {
    const row = await env.ARCADIA_DB.prepare(
      `SELECT service_url FROM chats WHERE chat_id = ?`,
    )
      .bind(p.chatId)
      .first<{ service_url: string }>();
    if (!row?.service_url) return null;
    return { serviceUrl: row.service_url, conversationId: p.chatId };
  }
  return null;
}

export function makeSendMessageVerb(
  deps: SendMessageDeps = { postText },
): ActionVerb<SendMessageParams> {
  return {
    name: "send_message",
    defaultLevel: "confirm",

    parse(raw): SendMessageParams {
      const o = asObject(raw);
      const text = reqString(o, "text");
      const channelId = optString(o, "channelId");
      const chatId = optString(o, "chatId");
      if (!channelId && !chatId) {
        throw new Error("channelId or chatId required");
      }
      return {
        text,
        ...(channelId ? { channelId } : {}),
        ...(chatId ? { chatId } : {}),
      };
    },

    describe(p): string {
      const target = p.channelId ?? p.chatId ?? "?";
      return `Send message to ${target}: "${clip(p.text)}"`;
    },

    async execute(ctx, p) {
      const ref = await resolveRef(ctx.env, p);
      if (!ref) return { ok: false, error: "conversation_not_found" };
      await deps.postText(ctx.env, ref, p.text, ctx.log);
      return { ok: true, detail: { conversationId: ref.conversationId } };
    },
  };
}

export const sendMessageVerb = makeSendMessageVerb();
