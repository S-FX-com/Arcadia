// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Morning Brief Generator
//
// Posts a 7am ET Mon–Fri morning brief to every registered channel.
// Cron: "0 12 * * 1-5" (12:00 UTC = 7am EST / 8am EDT)
// ─────────────────────────────────────────────────────────────────────────────

import { buildMorningBriefPrompt } from "../ai/prompts.js";
import { callAI } from "../ai/router.js";
import { loadCachedMessages, storeBotMessageId } from "../memory/kv.js";
import { unregisterChannel } from "../memory/d1.js";
import { getOpenTasksForChannel } from "../tasks/store.js";
import { detectConversationLanguage } from "./context.js";
import type { ChannelRow, Env, TaskRow } from "../types.js";

// ─── Proactive post helper ────────────────────────────────────────────────────

async function postProactive(
  serviceUrl: string,
  conversationId: string,
  text: string,
  env: Env,
  teamId: string,
  channelId: string
): Promise<string | null> {
  const tokenRes = await fetch(
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

  if (!tokenRes.ok) {
    throw new Error(`Bot token fetch failed: ${tokenRes.status}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", text, textFormat: "markdown" }),
  });

  if (!res.ok) {
    const err = await res.text();
    try {
      const parsed = JSON.parse(err);
      if (res.status === 403 && parsed?.error?.message?.includes("BotNotInConversationRoster")) {
        await unregisterChannel(teamId, channelId, env);
      }
    } catch { /* ignore */ }
    throw new Error(`Morning brief post failed (${res.status}): ${err}`);
  }

  try {
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

// ─── Task summary formatter ───────────────────────────────────────────────────

function formatOpenTaskSummary(tasks: TaskRow[]): string {
  if (tasks.length === 0) return "No open tasks.";
  const lines = tasks.slice(0, 10).map((t) => {
    const owner = t.owner_name ? ` → ${t.owner_name}` : " → Unassigned";
    const deadline = t.deadline
      ? ` (due ${new Date(t.deadline * 1000).toISOString().slice(0, 10)})`
      : "";
    const status = t.status === "blocked" ? " [BLOCKED]" : "";
    return `- ${t.description}${owner}${deadline}${status}`;
  });
  if (tasks.length > 10) lines.push(`…and ${tasks.length - 10} more.`);
  return lines.join("\n");
}

// ─── Brief generation ─────────────────────────────────────────────────────────

async function generateMorningText(channel: ChannelRow, env: Env): Promise<string> {
  // Fetch messages from the last 24h for context
  const allMessages = await loadCachedMessages(channel.team_id, channel.channel_id, env);

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // Exclude threaded replies to Arcadia's own posts — those are meta-conversation, not team work
  const recentMessages = allMessages.filter((m) => m.timestamp >= yesterday && !m.isBot);

  // Load open tasks
  let tasks: TaskRow[] = [];
  try {
    tasks = await getOpenTasksForChannel(channel.team_id, channel.channel_id, env);
  } catch { /* tasks table may not exist yet */ }

  const openTaskSummary = formatOpenTaskSummary(tasks);
  const today = new Date().toISOString().slice(0, 10);

  if (recentMessages.length === 0 && tasks.length === 0) {
    return `**Morning Brief — ${today}**\nNothing carried over from yesterday in **${channel.channel_name}**. Clean slate — have a productive day.`;
  }

  const language = detectConversationLanguage(recentMessages);
  const { system, user } = buildMorningBriefPrompt(
    channel.channel_name,
    recentMessages,
    openTaskSummary,
    language
  );
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Generate and post the morning brief for a single channel.
 */
export async function generateAndPostMorningBrief(channel: ChannelRow, env: Env): Promise<void> {
  if (!channel.service_url || !channel.conversation_id) {
    console.warn(`[Arcadia] Morning brief: no service URL for ${channel.channel_name}`);
    return;
  }

  const content = await generateMorningText(channel, env);

  const postedId = await postProactive(
    channel.service_url,
    channel.conversation_id,
    content,
    env,
    channel.team_id,
    channel.channel_id
  );

  // Track the posted message ID so threaded replies to it are marked as bot-conversation
  if (postedId) {
    storeBotMessageId(channel.team_id, channel.channel_id, postedId, env).catch((e) =>
      console.error("[Arcadia] storeBotMessageId failed:", e)
    );
  }

  console.log(`[Arcadia] Morning brief posted for ${channel.channel_name}`);
}
