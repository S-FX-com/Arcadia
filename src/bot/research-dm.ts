// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Research DM handler (Phase 5)
//
// Handles the admin DM flow for the autoresearch system: dispatch of
// `research` commands, and heuristic matching of free-form replies as
// answers to the most recent pending research question.
// ─────────────────────────────────────────────────────────────────────────────

import { sendReply, trimForTeams } from "./messages.js";
import { runResearchCommand } from "./intents/index.js";
import { getLatestPendingQuestion, processAnswer } from "../research/questions.js";
import { getBotToken } from "./activity-utils.js";
import type { Env, TeamsActivity } from "../types.js";

const KNOWN_COMMAND_INTENTS = [
  "summarize",
  "status",
  "who-owns",
  "decisions",
  "next-steps",
  "tasks",
  "draft",
  "exec-summary",
  "research",
];

/**
 * Returns true if the activity was handled as a research command or answer.
 */
export async function tryHandleResearchDM(
  activity: TeamsActivity,
  intent: string,
  rawText: string,
  env: Env
): Promise<boolean> {
  const token = await getBotToken(env);

  if (intent === "research") {
    const responseText = await runResearchCommand(rawText, env);
    await sendReply(activity, trimForTeams(responseText), token);
    return true;
  }

  const pendingQ = await getLatestPendingQuestion(env);
  if (pendingQ && pendingQ.status === "asked") {
    const looksLikeAnswer =
      rawText.length > 5 &&
      !/^@/.test(rawText) &&
      !KNOWN_COMMAND_INTENTS.includes(intent);

    if (looksLikeAnswer) {
      const confirmation = await processAnswer(pendingQ.id, rawText, env);
      await sendReply(activity, trimForTeams(confirmation), token);
      return true;
    }
  }

  return false;
}
