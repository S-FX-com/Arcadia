// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot Activity Handler
//
// Thin dispatcher. Responsibilities:
//   1. Route Teams activities by type (message / conversationUpdate).
//   2. For messages: passive-cache, update profile, pick the conversation mode,
//      and delegate to either the conversational flow or the @mention intent
//      dispatcher.
//
// All real work lives in siblings:
//   - conversation-modes.ts   (DM / GroupChat / Channel strategies)
//   - intents/                (@mention intent handlers)
//   - access-control.ts       (admin gating)
//   - memory-recording.ts     (fire-and-forget memory extraction)
//   - research-dm.ts          (Phase-5 admin research DM flow)
//   - passive-cache.ts        (rolling message cache)
//   - activity-utils.ts       (channel-id extraction, bot token)
// ─────────────────────────────────────────────────────────────────────────────

import { parseCommand, stripMention } from "./commands.js";
import {
  buildErrorMessage,
  buildWelcomeMessageV2,
  buildDMWelcomeMessage,
  buildDMAuthRequiredWelcome,
  buildDMAuthRequiredReminder,
  sendReply,
  trimForTeams,
} from "./messages.js";
import { isUserLinked, registerChannel } from "../memory/d1.js";
import { loadCachedMessages } from "../memory/kv.js";
import { touchUserProfile, updateCustomerProfiles, buildTeamProfileSummary } from "../intelligence/profiles.js";
import { dispatchIntent, runKnowledgeCommand } from "./intents/index.js";
import type { ConversationTurn, Env, TeamsActivity } from "../types.js";
import { features } from "../features.js";
import { LIMITS, TEAMS } from "../constants.js";
import { isAdminActivity, requiresAdminAccess } from "./access-control.js";
import { DMMode, resolveConversationMode, type ConversationMode } from "./conversation-modes.js";
import { extractChannelIds, getBotToken } from "./activity-utils.js";
import { recordMemoriesFromInteraction } from "./memory-recording.js";
import { tryHandleResearchDM } from "./research-dm.js";
import { passiveCacheMessage } from "./passive-cache.js";
import { runArcadiaPipeline } from "../pipeline/arcadia-pipeline.js";

// ─── Conversational mode (DM + group chat) ───────────────────────────────────

/**
 * Unified flow for surfaces that keep a turn-by-turn history (DM, groupChat).
 * Fetches history via the strategy, calls the AI with context engine, persists
 * the updated turns, and fires memory extraction.
 */
async function handleConversationalMode(
  activity: TeamsActivity,
  mode: ConversationMode,
  env: Env
): Promise<void> {
  const token = await getBotToken(env);
  const command = parseCommand(activity, env.TEAMS_APP_ID);
  const userId = activity.from.aadObjectId ?? activity.from.id;
  const userName = activity.from.name ?? "there";
  const admin = isAdminActivity(activity, env);
  const isDM = mode.name === "dm";
  const { teamId, channelId, channelName } = extractChannelIds(activity);

  const history = await mode.fetchHistory(activity, env);

  // DM admin cross-scope injects a team profile preamble as extra context.
  let extraContext: string | undefined;
  if (isDM && admin && requiresAdminAccess(command.rawText)) {
    try {
      const summaryTeamId = activity.channelData?.team?.id ?? "unknown";
      const teamSummary = await buildTeamProfileSummary(summaryTeamId, env);
      extraContext = `[Team profile context]\n${teamSummary}`;
    } catch (e) {
      console.error("[Arcadia] Failed to load team profiles for admin query:", e);
    }
  }

  const surface = isDM ? "dm" : "groupchat";
  const result = await runArcadiaPipeline({
    mode: "teams-bot",
    user: { id: userId, displayName: userName, isAdmin: admin },
    text: command.rawText,
    conversation: {
      id: activity.conversation.id,
      surface,
      channelId: isDM ? null : channelId,
      teamId: isDM ? null : teamId,
      channelName: isDM ? "DM" : channelName,
    },
    history,
    ...(extraContext !== undefined ? { extraContext } : {}),
    env,
  });

  // Persist history using the original turn shape (speaker prefix for groupchat).
  const persistedUserMessage = isDM ? command.rawText : `[${userName}] ${command.rawText}`;
  const newHistory: ConversationTurn[] = [
    ...history,
    { role: "user", content: persistedUserMessage, timestamp: new Date().toISOString() },
    { role: "assistant", content: result.rawText, timestamp: new Date().toISOString() },
  ];
  mode.saveHistory(activity, newHistory, env).catch((e) =>
    console.error("[Arcadia] saveHistory failed:", e)
  );

  await sendReply(activity, result.text, token);
}

// ─── Auth gating ─────────────────────────────────────────────────────────────

/**
 * Build the deep link the bot sends to unauthenticated DM users so they can
 * sign in to the webapp and grant Arcadia permission to build their persona.
 */
function buildWebappAuthUrl(workerUrl: string): string {
  const base = workerUrl.replace(/\/$/, "");
  return `${base}/app?source=teams`;
}

// ─── Message dispatch ────────────────────────────────────────────────────────

async function handleMessage(activity: TeamsActivity, env: Env, workerUrl: string): Promise<void> {
  const text = activity.text ?? "";
  console.log("[Arcadia] handleMessage text:", JSON.stringify(text));
  if (!text.trim()) return;

  const command = parseCommand(activity, env.TEAMS_APP_ID);
  const cleanText = stripMention(text);
  const { teamId, channelId, channelName } = extractChannelIds(activity);
  const mode = resolveConversationMode(activity);

  // DM gate: a 1:1 interaction requires the user to have authenticated the
  // webapp first. Without that we refuse to respond, cache, or build a
  // persona — everything personal flows from an explicit grant.
  if (mode === DMMode) {
    const userAadId = activity.from.aadObjectId ?? activity.from.id;
    const linked = await isUserLinked(userAadId, env).catch((e) => {
      console.error("[Arcadia] isUserLinked failed:", e);
      return false;
    });
    if (!linked) {
      const token = await getBotToken(env);
      await sendReply(activity, buildDMAuthRequiredReminder(buildWebappAuthUrl(workerUrl)), token);
      return;
    }
  }

  // Background bookkeeping — errors never block replies.
  passiveCacheMessage(activity, teamId, channelId, env, cleanText).catch((e) =>
    console.error("[Arcadia] passiveCacheMessage failed:", e)
  );
  touchUserProfile(activity, env).catch((e) =>
    console.error("[Arcadia] touchUserProfile failed:", e)
  );

  // DM: admin-only Phase 5/6 shortcuts before the normal conversational flow.
  if (mode === DMMode) {
    const admin = isAdminActivity(activity, env);
    if (admin && command.intent === "knowledge" && features.knowledgeGraph(env)) {
      const token = await getBotToken(env);
      const responseText = await runKnowledgeCommand(command.rawText, env);
      await sendReply(activity, trimForTeams(responseText), token);
      return;
    }
    if (admin && features.autoresearch(env)) {
      const handled = await tryHandleResearchDM(activity, command.intent, command.rawText, env);
      if (handled) return;
    }
  }

  // Channel: silent digest unless @mentioned.
  if (!mode.shouldRespond(activity, command.mentionedBot)) {
    const msgs = await loadCachedMessages(teamId, channelId, env).catch(() => []);
    if (msgs.length > 0 && msgs.length % LIMITS.CUSTOMER_PROFILE_UPDATE_INTERVAL === 0) {
      updateCustomerProfiles(msgs, env).catch((e) =>
        console.error("[Arcadia] updateCustomerProfiles failed:", e)
      );
    }
    return;
  }

  // DM + group chat → unified conversational flow.
  if (mode.name !== "channel") {
    await handleConversationalMode(activity, mode, env);
    return;
  }

  // Channel @mention → intent dispatcher.
  const token = await getBotToken(env);
  try {
    if (requiresAdminAccess(command.rawText) && !isAdminActivity(activity, env)) {
      await sendReply(
        activity,
        "I can only share information from this conversation. Cross-user and cross-channel analysis is available to administrators only.",
        token
      );
      return;
    }

    const { text: responseText } = await dispatchIntent({
      activity,
      command,
      teamId,
      channelId,
      channelName,
      conversationType: activity.conversation.conversationType,
      isAdmin: isAdminActivity(activity, env),
      env,
    });

    await sendReply(activity, trimForTeams(responseText), token);

    recordMemoriesFromInteraction(
      activity.from.name ?? "unknown",
      command.rawText,
      responseText,
      channelName,
      activity.from.aadObjectId ?? activity.from.id,
      channelId,
      env
    ).catch((e) => console.error("[Arcadia] Memory recording failed:", e));
  } catch (err) {
    console.error("Error handling message:", err);
    await sendReply(activity, buildErrorMessage(err), token);
  }
}

// ─── Conversation update (bot added) ─────────────────────────────────────────

async function handleConversationUpdate(
  activity: TeamsActivity,
  env: Env,
  workerUrl: string
): Promise<void> {
  const membersAdded = activity.membersAdded ?? [];
  const botWasAdded = membersAdded.some(
    (m) =>
      m.id === activity.recipient?.id ||
      m.aadObjectId === env.TEAMS_APP_ID ||
      m.id === env.TEAMS_APP_ID
  );
  if (!botWasAdded) return;

  const { teamId, channelId, channelName } = extractChannelIds(activity);
  const isDM = activity.conversation.conversationType === TEAMS.CONVERSATION_TYPES.PERSONAL;
  const token = await getBotToken(env);

  // DMs are gated on webapp auth. If the user hasn't linked yet, send the
  // sign-in prompt instead of the regular welcome and skip persona work.
  if (isDM) {
    const userAadId = activity.from.aadObjectId ?? activity.from.id;
    const linked = await isUserLinked(userAadId, env).catch((e) => {
      console.error("[Arcadia] isUserLinked failed during conversationUpdate:", e);
      return false;
    });
    if (!linked) {
      await sendReply(
        activity,
        buildDMAuthRequiredWelcome(activity.from.name, buildWebappAuthUrl(workerUrl)),
        token
      );
      return;
    }
    await sendReply(activity, buildDMWelcomeMessage(activity.from.name), token);
    return;
  }

  // Group chats and channels: no per-user gating — Arcadia operates on shared
  // conversation context. Register the channel for proactive posting and send
  // the standard welcome.
  await registerChannel(
    teamId,
    channelId,
    channelName,
    env,
    activity.serviceUrl,
    activity.conversation.id
  );
  await sendReply(activity, buildWelcomeMessageV2(channelName), token);
}

// ─── Main activity router ─────────────────────────────────────────────────────

export async function handleActivity(
  activity: TeamsActivity,
  env: Env,
  workerUrl: string
): Promise<Response> {
  try {
    console.log(activity);

    switch (activity.type) {
      case "message":
        await handleMessage(activity, env, workerUrl);
        break;
      case "conversationUpdate":
        await handleConversationUpdate(activity, env, workerUrl);
        break;
      default:
        break;
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("Unhandled activity error:", err);
    return new Response(null, { status: 500 });
  }
}
