// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Evening Wrap-Up Generator
//
// Posts a 5pm ET Mon–Fri wrap-up to every registered channel.
// Cron: "0 21 * * 1-5" (21:00 UTC = 5pm EDT / 4pm EST)
// ─────────────────────────────────────────────────────────────────────────────

import { buildEveningWrapupPrompt } from "../ai/prompts.js";
import { callAI } from "../ai/router.js";
import { loadCachedMessages } from "../memory/kv.js";
import { unregisterChannel } from "../memory/d1.js";
import { detectConversationLanguage } from "./context.js";
import type { ChannelRow, Env } from "../types.js";

// ─── Proactive post helper (mirrors digest.ts pattern) ───────────────────────

async function postProactive(
  serviceUrl: string,
  conversationId: string,
  text: string,
  env: Env,
  teamId: string,
  channelId: string
): Promise<void> {
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
    throw new Error(`Evening wrap-up post failed (${res.status}): ${err}`);
  }
}

// ─── Wrap-up generation ───────────────────────────────────────────────────────

async function generateEveningText(channel: ChannelRow, env: Env): Promise<string> {
  // Fetch today's messages (last 10h window covers the work day)
  let messages = await loadCachedMessages(channel.team_id, channel.channel_id, env);

  // Filter to today's messages
  const today = new Date().toISOString().slice(0, 10);
  messages = messages.filter((m) => m.timestamp.startsWith(today));

  if (messages.length === 0) {
    return `**End of Day — ${today}**\nQuiet day in **${channel.channel_name}** — no messages to wrap up.`;
  }

  const language = detectConversationLanguage(messages);
  const { system, user } = buildEveningWrapupPrompt(channel.channel_name, messages, language);
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Generate and post the evening wrap-up for a single channel.
 */
export async function generateAndPostEveningWrapup(channel: ChannelRow, env: Env): Promise<void> {
  if (!channel.service_url || !channel.conversation_id) {
    console.warn(`[Arcadia] Evening wrap-up: no service URL for ${channel.channel_name}`);
    return;
  }

  const content = await generateEveningText(channel, env);

  await postProactive(
    channel.service_url,
    channel.conversation_id,
    content,
    env,
    channel.team_id,
    channel.channel_id
  );

  console.log(`[Arcadia] Evening wrap-up posted for ${channel.channel_name}`);
}
