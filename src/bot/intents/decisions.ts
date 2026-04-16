import { extractDecisions } from "../../ai/summarize.js";
import { loadCachedMessages } from "../../memory/kv.js";
import { fetchMessagesForChannel } from "./_shared.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  let messages = await loadCachedMessages(ctx.teamId, ctx.channelId, ctx.env);
  if (messages.length === 0) {
    messages = await fetchMessagesForChannel(ctx);
  }
  const text = await extractDecisions(messages, ctx.command.language, ctx.env);
  return { text };
};
