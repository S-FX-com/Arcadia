import { callAI } from "../../ai/router.js";
import { buildDraftPrompt } from "../../ai/prompts.js";
import { loadCachedMessages } from "../../memory/kv.js";
import { parseDraftCommand } from "../commands.js";
import { KV_KEYS } from "../../constants.js";
import { fetchMessagesForChannel } from "./_shared.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  const { type, targetName } = parseDraftCommand(ctx.command.rawText);
  let messages = await loadCachedMessages(ctx.teamId, ctx.channelId, ctx.env);
  if (messages.length === 0) {
    messages = await fetchMessagesForChannel(ctx);
  }
  const { system, user } = buildDraftPrompt(
    type,
    ctx.command.rawText,
    targetName,
    messages,
    ctx.command.language
  );
  const response = await callAI(system, user, ctx.env);
  await ctx.env.ARCADIA_CACHE.put(
    KV_KEYS.DRAFT(ctx.activity.conversation.id, ctx.activity.id),
    response.text,
    { expirationTtl: 1800 }
  );
  return { text: response.text };
};
