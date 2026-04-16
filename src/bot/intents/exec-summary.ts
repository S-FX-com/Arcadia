import { callAI } from "../../ai/router.js";
import { buildExecSummaryPrompt } from "../../ai/prompts.js";
import { loadCachedMessages } from "../../memory/kv.js";
import { extractDateRange } from "../commands.js";
import type { IntentHandler } from "./types.js";

export const handle: IntentHandler = async (ctx) => {
  const dateRange = extractDateRange(ctx.command.rawText);

  if (!dateRange) {
    return {
      text: [
        "To generate an Executive Summary I need a time period. Try:",
        "- `exec summary for today`",
        "- `exec summary for April 10`",
        "- `exec summary for this week`",
        "- `exec summary for April 1 to April 10`",
      ].join("\n"),
    };
  }

  const allMessages = await loadCachedMessages(ctx.teamId, ctx.channelId, ctx.env);
  const rangeMessages = allMessages.filter(
    (m) => m.timestamp.slice(0, 10) >= dateRange.from && m.timestamp.slice(0, 10) <= dateRange.to
  );

  const { system, user } = buildExecSummaryPrompt(
    ctx.channelName,
    dateRange,
    rangeMessages,
    ctx.command.language
  );
  const response = await callAI(system, user, ctx.env);
  return { text: response.text };
};
