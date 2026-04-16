import { handleQA } from "../../ai/qa.js";
import type { IntentHandler } from "./types.js";

/** Fallback handler for who-owns, status, and general-qa intents. */
export const handle: IntentHandler = async (ctx) => {
  const text = await handleQA(
    ctx.teamId,
    ctx.channelId,
    ctx.command.rawText,
    ctx.command.intent,
    ctx.command.language,
    ctx.env,
    ctx.conversationType
  );
  return { text };
};
