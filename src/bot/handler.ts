// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot Activity Handler
//
// Routes incoming Bot Framework activities to the appropriate pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import { parseCommand } from "./commands.js";
import {
  buildErrorMessage,
  buildWelcomeMessage,
  sendReply,
  trimForTeams,
} from "./messages.js";
import { summarizeChannel, extractDecisions, extractNextSteps } from "../ai/summarize.js";
import { handleQA } from "../ai/qa.js";
import { registerChannel } from "../memory/d1.js";
import { loadCachedMessages } from "../memory/kv.js";
import { getChannelMessages } from "../graph/messages.js";
import type { ChannelMessage, Env, TeamsActivity } from "../types.js";

async function fetchMessages(
  teamId: string,
  channelId: string,
  env: Env
): Promise<ChannelMessage[]> {
  try {
    return await getChannelMessages(teamId, channelId, env);
  } catch {
    return [];
  }
}

/**
 * Fetch a Bot Framework bearer token for sending replies.
 * Uses the bot's own client credentials.
 */
async function getBotToken(env: Env): Promise<string> {
  const res = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.TEAMS_APP_ID,
        client_secret: env.TEAMS_APP_PASSWORD,
        scope: "https://api.botframework.com/.default",
      }).toString(),
    }
  );

  if (!res.ok) {
    throw new Error(`Bot token fetch failed: ${res.status}`);
  }

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

/**
 * Extract team and channel IDs from an activity's channelData.
 * Falls back to conversation ID if channel data isn't available (DM context).
 */
function extractChannelIds(activity: TeamsActivity): {
  teamId: string;
  channelId: string;
  channelName: string;
} {
  const teamId =
    activity.channelData?.teamsTeamId ??
    activity.channelData?.team?.id ??
    activity.conversation.tenantId ?? // fallback
    "unknown";

  const channelId =
    activity.channelData?.teamsChannelId ??
    activity.channelData?.channel?.id ??
    activity.conversation.id;

  const channelName =
    activity.channelData?.channel?.name ??
    activity.conversation.name ??
    "General";

  return { teamId, channelId, channelName };
}

/**
 * Handle a `message` activity — the core interaction flow.
 */
async function handleMessage(activity: TeamsActivity, env: Env): Promise<void> {
  const text = activity.text ?? "";
  if (!text.trim()) return;

  const token = await getBotToken(env);
  const { teamId, channelId } = extractChannelIds(activity);
  const command = parseCommand(activity, env.TEAMS_APP_ID);

  // Only respond if directly @mentioned or in a DM
  const isDM = activity.conversation.conversationType === "personal";
  if (!command.mentionedBot && !isDM) return;

  try {
    let responseText: string;

    switch (command.intent) {
      case "summarize": {
        const result = await summarizeChannel(
          teamId,
          channelId,
          command.language,
          env
        );
        responseText = result.raw;
        break;
      }

      case "decisions": {
        let messages = await loadCachedMessages(teamId, channelId, env);
        if (messages.length === 0) {
          messages = await fetchMessages(teamId, channelId, env);
        }
        responseText = await extractDecisions(messages, command.language, env);
        break;
      }

      case "next-steps": {
        let messages = await loadCachedMessages(teamId, channelId, env);
        if (messages.length === 0) {
          messages = await fetchMessages(teamId, channelId, env);
        }
        responseText = await extractNextSteps(messages, command.language, env);
        break;
      }

      case "who-owns":
      case "status":
      case "general-qa":
      default: {
        responseText = await handleQA(
          teamId,
          channelId,
          command.rawText,
          command.intent,
          command.language,
          env
        );
        break;
      }
    }

    await sendReply(activity, trimForTeams(responseText), token);
  } catch (err) {
    console.error("Error handling message:", err);
    await sendReply(activity, buildErrorMessage(err), token);
  }
}

/**
 * Handle a `conversationUpdate` activity — bot added to channel.
 */
async function handleConversationUpdate(
  activity: TeamsActivity,
  env: Env
): Promise<void> {
  const membersAdded = activity.membersAdded ?? [];
  const botWasAdded = membersAdded.some((m) => m.id === env.TEAMS_APP_ID);
  if (!botWasAdded) return;

  const { teamId, channelId, channelName } = extractChannelIds(activity);

  // Register this channel for daily digests (store conversation ref for proactive messaging)
  await registerChannel(
    teamId,
    channelId,
    channelName,
    env,
    activity.serviceUrl,
    activity.conversation.id
  );

  const token = await getBotToken(env);
  await sendReply(activity, buildWelcomeMessage(channelName), token);
}

/**
 * Main activity router — dispatches to the correct handler.
 */
export async function handleActivity(
  activity: TeamsActivity,
  env: Env
): Promise<Response> {
  try {
    switch (activity.type) {
      case "message":
        await handleMessage(activity, env);
        break;

      case "conversationUpdate":
        await handleConversationUpdate(activity, env);
        break;

      // Other activity types (typing, reactions, etc.) — acknowledge and ignore
      default:
        break;
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("Unhandled activity error:", err);
    return new Response(null, { status: 500 });
  }
}
