// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Context-Aware Q&A Pipeline
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "./router.js";
import {
  buildQAPrompt,
  buildOwnershipPrompt,
} from "./prompts.js";
import { fetchConversationMessages, type ConversationType } from "../graph/fetch.js";
import type { ChannelMessage, CommandIntent, Env } from "../types.js";

/**
 * Fetch context messages for a channel.
 * Tries Graph first, falls back to KV cache.
 */
async function getContextMessages(
  teamId: string,
  channelId: string,
  env: Env,
  limit = 50,
  conversationType?: string
): Promise<ChannelMessage[]> {
  const type: ConversationType =
    conversationType === "personal"
      ? "personal"
      : conversationType === "groupChat"
        ? "groupChat"
        : "channel";
  return fetchConversationMessages(env, {
    teamId,
    channelId,
    chatId: type === "groupChat" ? channelId : undefined,
    conversationType: type,
    limit,
    useCacheFallback: true,
  });
}

/**
 * Answer a general question with channel context.
 */
export async function answerQuestion(
  teamId: string,
  channelId: string,
  question: string,
  language: string,
  env: Env,
  conversationType?: string
): Promise<string> {
  const messages = await getContextMessages(teamId, channelId, env, 50, conversationType);

  if (messages.length === 0) {
    return language.startsWith("fr")
      ? "Aucun message récent trouvé pour répondre à cette question."
      : "No recent messages found to answer this question.";
  }

  const { system, user } = buildQAPrompt(messages, question, language);
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Answer an ownership/accountability question.
 */
export async function answerOwnership(
  teamId: string,
  channelId: string,
  topic: string,
  language: string,
  env: Env,
  conversationType?: string
): Promise<string> {
  const messages = await getContextMessages(teamId, channelId, env, 50, conversationType);

  if (messages.length === 0) {
    return "No recent messages found to identify ownership.";
  }

  const { system, user } = buildOwnershipPrompt(messages, topic, language);
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Route a Q&A request to the appropriate handler based on detected intent.
 * This is the main entry point for all Q&A commands.
 */
export async function handleQA(
  teamId: string,
  channelId: string,
  rawText: string,
  intent: CommandIntent,
  language: string,
  env: Env,
  conversationType?: string
): Promise<string> {
  switch (intent) {
    case "who-owns":
      return answerOwnership(teamId, channelId, rawText, language, env, conversationType);

    case "status":
    case "general-qa":
    default:
      return answerQuestion(teamId, channelId, rawText, language, env, conversationType);
  }
}
