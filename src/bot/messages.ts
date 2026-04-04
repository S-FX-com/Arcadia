// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Response Message Builders
//
// Formats outgoing Teams messages in plain markdown.
// Arcadia personality: concise, reasoned, light wit when appropriate.
// ─────────────────────────────────────────────────────────────────────────────

import type { TeamsActivity } from "../types.js";

/**
 * Build a Bot Framework reply activity from a text response.
 */
export function buildReply(activity: TeamsActivity, text: string): object {
  return {
    type: "message",
    text,
    textFormat: "markdown",
    from: activity.recipient,
    recipient: activity.from,
    replyToId: activity.id,
    conversation: activity.conversation,
    channelId: activity.channelId,
    serviceUrl: activity.serviceUrl,
  };
}

/**
 * Build a typing indicator activity — shows Arcadia is "thinking".
 */
export function buildTypingIndicator(activity: TeamsActivity): object {
  return {
    type: "typing",
    from: activity.recipient,
    recipient: activity.from,
    conversation: activity.conversation,
    channelId: activity.channelId,
    serviceUrl: activity.serviceUrl,
  };
}

/**
 * Post an activity (reply or typing indicator) to the Bot Framework service URL.
 */
export async function postActivity(
  activity: TeamsActivity,
  body: object,
  token: string
): Promise<void> {
  const url = `${activity.serviceUrl.replace(/\/$/, "")}/v3/conversations/${activity.conversation.id}/activities`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Send a reply to a Teams activity.
 */
export async function sendReply(
  activity: TeamsActivity,
  text: string,
  token: string
): Promise<void> {
  await postActivity(activity, buildReply(activity, text), token);
}

/**
 * Format a welcome message when Arcadia is added to a channel.
 */
export function buildWelcomeMessage(channelName?: string): string {
  const channel = channelName ? `**${channelName}**` : "this channel";
  return [
    `I'm Arcadia — your AI operations layer for Teams.`,
    "",
    `I'm now active in ${channel}. Here's what I can do:`,
    "",
    "- **Summarize** this thread or channel (`summarize`, `tl;dr`, `catch me up`)",
    "- **Answer questions** about ongoing work (`what's going on?`, `what's the status?`)",
    "- **Find owners** (`who owns X?`, `who's responsible for Y?`)",
    "- **Surface decisions** (`what did we decide?`)",
    "- **Identify next steps** (`what are the next steps?`, `action items`)",
    "- **Daily digest** — I'll post a summary here every morning at 8am UTC",
    "",
    "Just @mention me or ask directly. I'll take it from there.",
  ].join("\n");
}

/**
 * Format an error message with Arcadia's personality.
 */
export function buildErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Something went wrong on my end — ${msg}. Try again or reach out if this persists.`;
}

/**
 * Trim AI response to a sensible length for Teams (max ~3000 chars).
 */
export function trimForTeams(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) return text;
  const trimmed = text.slice(0, maxLength - 50);
  const lastNewline = trimmed.lastIndexOf("\n");
  return (lastNewline > maxLength * 0.8 ? trimmed.slice(0, lastNewline) : trimmed) +
    "\n\n_…response trimmed for length._";
}
