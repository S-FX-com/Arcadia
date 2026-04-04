// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Daily Digest Generator
//
// Aggregates the last 24h of channel activity into a structured digest,
// posts it via Bot Framework proactive messaging, and logs it to D1.
// ─────────────────────────────────────────────────────────────────────────────

import { getChannelMessages } from "../graph/messages.js";
import { callAI } from "../ai/router.js";
import { buildDigestPrompt } from "../ai/prompts.js";
import { logDigest } from "../memory/d1.js";
import { detectConversationLanguage } from "./context.js";
import type { ChannelRow, DigestEntry, Env } from "../types.js";

/**
 * Generate the daily digest text for a channel using AI.
 */
async function generateDigestText(
  channel: ChannelRow,
  env: Env
): Promise<string> {
  // Fetch last 24h of messages
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let messages;
  try {
    messages = await getChannelMessages(
      channel.team_id,
      channel.channel_id,
      env,
      100,
      since
    );
  } catch {
    messages = [];
  }

  if (messages.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return `**Daily Summary — ${today}**\nNo activity in the past 24 hours. All quiet.`;
  }

  const language = detectConversationLanguage(messages);
  const { system, user } = buildDigestPrompt(
    channel.channel_name,
    messages,
    language
  );
  const response = await callAI(system, user, env);
  return response.text;
}

/**
 * Post a message to a Teams channel via Bot Framework REST API.
 * Uses the service URL stored in conversationReference for proactive messaging.
 *
 * Note: The conversationId here is the Teams channel conversation ID.
 * This requires the bot to have previously been installed in the channel.
 */
async function postToChannel(
  serviceUrl: string,
  conversationId: string,
  text: string,
  env: Env
): Promise<void> {
  // Get Bot Framework token via client credentials
  const tokenRes = await fetch(
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

  if (!tokenRes.ok) {
    throw new Error(`Bot Framework token fetch failed: ${tokenRes.status}`);
  }

  const { access_token } = await tokenRes.json() as { access_token: string };

  // Post activity to channel
  const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${conversationId}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "message",
      text,
      textFormat: "markdown",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to post digest to channel (${res.status}): ${err}`);
  }
}

/**
 * Generate and post the daily digest for a single channel.
 * Returns the DigestEntry for logging.
 */
export async function generateAndPostDigest(
  channel: ChannelRow,
  serviceUrl: string,
  conversationId: string,
  env: Env
): Promise<DigestEntry> {
  const today = new Date().toISOString().slice(0, 10);
  const content = await generateDigestText(channel, env);

  // Post to Teams channel
  try {
    await postToChannel(serviceUrl, conversationId, content, env);
  } catch (err) {
    console.error(
      `Failed to post digest for ${channel.channel_id}:`,
      err
    );
  }

  // Log to D1
  await logDigest(channel.team_id, channel.channel_id, content, env);

  return {
    teamId: channel.team_id,
    channelId: channel.channel_id,
    date: today,
    activeDiscussions: 0,
    decisionsFinalized: [],
    itemsAwaitingResponse: [],
    staleThreads: 0,
    content,
  };
}
