// Helpers shared between intent handlers.

import { fetchConversationMessages, type ConversationType } from "../../graph/fetch.js";
import type { ChannelMessage, Env } from "../../types.js";
import type { IntentContext } from "./types.js";

export async function fetchMessagesForChannel(ctx: IntentContext): Promise<ChannelMessage[]> {
  const type: ConversationType =
    ctx.conversationType === "personal"
      ? "personal"
      : ctx.conversationType === "groupChat"
        ? "groupChat"
        : "channel";
  return fetchConversationMessages(ctx.env, {
    teamId: ctx.teamId,
    channelId: ctx.channelId,
    chatId: type === "groupChat" ? ctx.channelId : undefined,
    conversationType: type,
    useCacheFallback: false,
  });
}

export function adminOnly(isAdmin: boolean, message: string): string | null {
  return isAdmin ? null : message;
}

export type { Env };
