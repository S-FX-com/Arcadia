// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot Activity Handler
//
// Routing rules:
//   personal (1:1 DM)   → Full LLM conversation mode with history + profile
//   groupChat            → Passive cache always; respond only when @mentioned
//   channel              → Respond only when @mentioned (unchanged)
//
// Access control:
//   Cross-user / cross-channel queries → admin only (ADMIN_USER_AAD_ID)
//   All other queries → scoped to the current conversation context
// ─────────────────────────────────────────────────────────────────────────────

import { parseCommand, parseDraftCommand, extractDateRange } from "./commands.js";
import { buildErrorMessage, buildWelcomeMessageV2, buildDMWelcomeMessage, formatTaskList, sendReply, trimForTeams } from "./messages.js";
import { summarizeChannel, extractDecisions, extractNextSteps } from "../ai/summarize.js";
import { handleQA } from "../ai/qa.js";
import { buildDMSystemPrompt, buildExecSummaryPrompt, buildDraftPrompt } from "../ai/prompts.js";
import { callAI, callAIWithHistory } from "../ai/router.js";
import { registerChannel } from "../memory/d1.js";
import { cacheMessages, loadCachedMessages, loadDMHistory, saveDMHistory } from "../memory/kv.js";
import { getChannelMessages, getChatMessages } from "../graph/messages.js";
import { getOpenTasksForChannel } from "../tasks/store.js";
import { parseAssignCommand, handleAssignCommand } from "../tasks/assign.js";
import { touchUserProfile, resolveUserProfile, updateCustomerProfiles, buildTeamProfileSummary } from "../intelligence/profiles.js";
import { stripMention } from "./commands.js";
import type { ChannelMessage, ConversationTurn, Env, TeamsActivity } from "../types.js";

// ─── Channel ID helpers ───────────────────────────────────────────────────────

function extractChannelIds(activity: TeamsActivity): {
  teamId: string;
  channelId: string;
  channelName: string;
} {
  const teamId =
    activity.channelData?.team?.aadGroupId ??
    activity.channelData?.teamsTeamId ??
    activity.channelData?.team?.id ??
    activity.conversation.tenantId ??
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

// ─── Bot Framework token ──────────────────────────────────────────────────────

async function getBotToken(env: Env): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
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
    const err = await res.text();
    throw new Error(`Bot token fetch failed: ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ─── Access control ───────────────────────────────────────────────────────────

/**
 * Returns true only for the configured admin user (Shane Skwarek).
 * The admin can query cross-user and cross-channel data.
 */
function isAdminUser(activity: TeamsActivity, env: Env): boolean {
  if (!env.ADMIN_USER_AAD_ID) return false;
  const userId = activity.from.aadObjectId ?? activity.from.id;
  return userId === env.ADMIN_USER_AAD_ID;
}

/**
 * Detect whether a query is asking for cross-user or cross-channel data.
 * Non-admin users receive only context from their current conversation.
 */
function requiresAdminAccess(rawText: string): boolean {
  return /\b(other\s+user|all\s+user|someone\s+else|everyone|all\s+staff|all\s+people|cross.channel|other\s+channel|all\s+channel|entire\s+tenant|across\s+the\s+org|other\s+team|tell\s+me\s+about\s+[A-Z]|what\s+is\s+\w+\s+working|habits\s+of|profile\s+of|patterns\s+of)\b/i
    .test(rawText);
}

// ─── Passive message caching ──────────────────────────────────────────────────

/**
 * Cache an incoming message without responding.
 * Called for ALL incoming messages regardless of whether Arcadia responds.
 */
async function passiveCacheMessage(
  activity: TeamsActivity,
  teamId: string,
  channelId: string,
  env: Env,
  cleanText: string
): Promise<void> {
  if (!cleanText.trim()) return;

  const msg: ChannelMessage = {
    id: activity.id,
    timestamp: activity.timestamp ?? new Date().toISOString(),
    authorId: activity.from.id,
    authorName: activity.from.name ?? activity.from.id,
    text: cleanText,
    isBot: false,
    replyToId: activity.replyToId,
  };

  const max = parseInt(env.MAX_MESSAGES_CACHED ?? "100", 10);
  await cacheMessages(teamId, channelId, [msg], env, max);
}

// ─── Message fetcher ──────────────────────────────────────────────────────────

async function fetchMessages(
  teamId: string,
  channelId: string,
  env: Env,
  conversationType?: string
): Promise<ChannelMessage[]> {
  try {
    if (conversationType === "personal") {
      return await loadCachedMessages(teamId, channelId, env);
    }
    if (conversationType === "groupChat") {
      return await getChatMessages(channelId, env);
    }
    return await getChannelMessages(teamId, channelId, env);
  } catch (err) {
    console.error("[Arcadia] fetchMessages error:", err);
    return [];
  }
}

// ─── 1:1 DM full conversation mode ───────────────────────────────────────────

async function handleDMMode(activity: TeamsActivity, env: Env): Promise<void> {
  const token = await getBotToken(env);
  const userId = activity.from.aadObjectId ?? activity.from.id;
  const userName = activity.from.name ?? "there";
  const admin = isAdminUser(activity, env);

  // Load conversation history and user profile concurrently
  const [history, profile] = await Promise.all([
    loadDMHistory(userId, env),
    resolveUserProfile(userId, env),
  ]);

  // Build rich system prompt with profile context
  const system = buildDMSystemPrompt(userName, admin, profile?.insights ?? null);

  // For admin cross-user queries, inject team profile summary into the user message
  const command = parseCommand(activity, env.TEAMS_APP_ID);
  let userMessage = command.rawText;

  if (admin && requiresAdminAccess(userMessage)) {
    try {
      const teamId = activity.channelData?.team?.id ?? "unknown";
      const teamSummary = await buildTeamProfileSummary(teamId, env);
      userMessage = `[Team profile context]\n${teamSummary}\n\n[User query]\n${userMessage}`;
    } catch (e) {
      console.error("[Arcadia] Failed to load team profiles for admin query:", e);
    }
  }

  // Call AI with full conversation history
  const response = await callAIWithHistory(system, history, userMessage, env);

  // Persist updated history asynchronously (non-blocking)
  const newHistory: ConversationTurn[] = [
    ...history,
    { role: "user", content: command.rawText, timestamp: new Date().toISOString() },
    { role: "assistant", content: response.text, timestamp: new Date().toISOString() },
  ];
  saveDMHistory(userId, newHistory, env).catch((e) =>
    console.error("[Arcadia] saveDMHistory failed:", e)
  );

  await sendReply(activity, trimForTeams(response.text), token);
}

// ─── Executive Summary handler ────────────────────────────────────────────────

async function handleExecSummary(
  activity: TeamsActivity,
  rawText: string,
  teamId: string,
  channelId: string,
  channelName: string,
  language: string,
  env: Env
): Promise<string> {
  const dateRange = extractDateRange(rawText);

  if (!dateRange) {
    return [
      "To generate an Executive Summary I need a time period. Try:",
      "- `exec summary for today`",
      "- `exec summary for April 10`",
      "- `exec summary for this week`",
      "- `exec summary for April 1 to April 10`",
    ].join("\n");
  }

  // Fetch messages for the date range from cache
  const allMessages = await loadCachedMessages(teamId, channelId, env);
  const rangeMessages = allMessages.filter(
    (m) => m.timestamp.slice(0, 10) >= dateRange.from && m.timestamp.slice(0, 10) <= dateRange.to
  );

  const { system, user } = buildExecSummaryPrompt(channelName, dateRange, rangeMessages, language);
  const response = await callAI(system, user, env);
  return response.text;
}

// ─── Main message handler ─────────────────────────────────────────────────────

async function handleMessage(activity: TeamsActivity, env: Env): Promise<void> {
  const text = activity.text ?? "";
  console.log("[Arcadia] handleMessage text:", JSON.stringify(text));
  if (!text.trim()) return;

  const conversationType = activity.conversation.conversationType;
  const isDM = conversationType === "personal";
  const isGroupChat = conversationType === "groupChat";
  const { teamId, channelId, channelName } = extractChannelIds(activity);

  // Parse command (strips @mention, resolves language, detects intent)
  const command = parseCommand(activity, env.TEAMS_APP_ID);
  const cleanText = stripMention(text);

  // ── Always: cache the incoming message and update user profile ──────────────
  // These run in the background — errors are swallowed so they never block replies.
  passiveCacheMessage(activity, teamId, channelId, env, cleanText).catch((e) =>
    console.error("[Arcadia] passiveCacheMessage failed:", e)
  );
  touchUserProfile(activity, env).catch((e) =>
    console.error("[Arcadia] touchUserProfile failed:", e)
  );

  // ── 1:1 DM: always respond in full conversation mode ────────────────────────
  if (isDM) {
    await handleDMMode(activity, env);
    return;
  }

  // ── Group chat / channel: only respond when @mentioned ─────────────────────
  // For group chats, the bot receives all messages but stays silent unless summoned.
  if (!command.mentionedBot) {
    // Periodically run background customer profile analysis (every ~25 messages)
    const msgs = await loadCachedMessages(teamId, channelId, env).catch(() => []);
    if (msgs.length > 0 && msgs.length % 25 === 0) {
      updateCustomerProfiles(msgs, env).catch((e) =>
        console.error("[Arcadia] updateCustomerProfiles failed:", e)
      );
    }
    return; // Silently digest the message
  }

  // ── Mentioned: run intent dispatch with access control ─────────────────────
  const token = await getBotToken(env);

  try {
    let responseText: string;

    // Access control: restrict cross-user / cross-channel data to admin user only
    if (requiresAdminAccess(command.rawText) && !isAdminUser(activity, env)) {
      responseText =
        "I can only share information from this conversation. Cross-user and cross-channel analysis is available to administrators only.";
      await sendReply(activity, responseText, token);
      return;
    }

    switch (command.intent) {
      case "summarize": {
        const result = await summarizeChannel(
          teamId,
          channelId,
          command.language,
          env,
          50,
          conversationType
        );
        responseText = result.raw;
        break;
      }

      case "decisions": {
        let messages = await loadCachedMessages(teamId, channelId, env);
        if (messages.length === 0) messages = await fetchMessages(teamId, channelId, env, conversationType);
        responseText = await extractDecisions(messages, command.language, env);
        break;
      }

      case "next-steps": {
        let messages = await loadCachedMessages(teamId, channelId, env);
        if (messages.length === 0) messages = await fetchMessages(teamId, channelId, env, conversationType);
        responseText = await extractNextSteps(messages, command.language, env);
        break;
      }

      case "exec-summary": {
        responseText = await handleExecSummary(
          activity,
          command.rawText,
          teamId,
          channelId,
          channelName,
          command.language,
          env
        );
        break;
      }

      // ─── Phase 2 intents ───────────────────────────────────────────────────

      case "assign": {
        const parsed = parseAssignCommand(command.rawText);
        if (parsed) {
          responseText = await handleAssignCommand(activity, parsed, env);
        } else {
          responseText = "I couldn't parse that assignment. Try: `@Arcadia assign [task] to [name]`";
        }
        break;
      }

      case "tasks": {
        const tasks = await getOpenTasksForChannel(teamId, channelId, env);
        responseText = formatTaskList(tasks, command.language);
        break;
      }

      case "draft": {
        const { type, targetName } = parseDraftCommand(command.rawText);
        let messages = await loadCachedMessages(teamId, channelId, env);
        if (messages.length === 0) messages = await fetchMessages(teamId, channelId, env, conversationType);
        const { system, user } = buildDraftPrompt(type, command.rawText, targetName, messages, command.language);
        const response = await callAI(system, user, env);
        await env.ARCADIA_CACHE.put(
          `draft:${activity.conversation.id}:${activity.id}`,
          response.text,
          { expirationTtl: 1800 }
        );
        responseText = response.text;
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
          env,
          conversationType
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

// ─── Conversation update (bot added) ─────────────────────────────────────────

async function handleConversationUpdate(activity: TeamsActivity, env: Env): Promise<void> {
  const membersAdded = activity.membersAdded ?? [];
  const botWasAdded = membersAdded.some(
    (m) =>
      m.id === activity.recipient?.id ||
      m.aadObjectId === env.TEAMS_APP_ID ||
      m.id === env.TEAMS_APP_ID
  );
  if (!botWasAdded) return;

  const { teamId, channelId, channelName } = extractChannelIds(activity);
  const conversationType = activity.conversation.conversationType;
  const isDM = conversationType === "personal";

  await registerChannel(
    teamId,
    channelId,
    channelName,
    env,
    activity.serviceUrl,
    activity.conversation.id
  );

  const token = await getBotToken(env);
  const welcome = isDM
    ? buildDMWelcomeMessage(activity.from.name)
    : buildWelcomeMessageV2(channelName);
  await sendReply(activity, welcome, token);
}

// ─── Main activity router ─────────────────────────────────────────────────────

export async function handleActivity(activity: TeamsActivity, env: Env): Promise<Response> {
  try {
    console.log(activity);

    switch (activity.type) {
      case "message":
        await handleMessage(activity, env);
        break;

      case "conversationUpdate":
        await handleConversationUpdate(activity, env);
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
