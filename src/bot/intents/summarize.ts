import { summarizeChannel } from "../../ai/summarize.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  const result = await summarizeChannel(
    ctx.teamId,
    ctx.channelId,
    ctx.command.language,
    ctx.env,
    50,
    ctx.conversationType
  );
  return { text: result.raw };
};
