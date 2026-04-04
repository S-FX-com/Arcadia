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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Task & nudge formatters
// ─────────────────────────────────────────────────────────────────────────────

import type { NudgeReason, TaskRow } from "../types.js";

const STATUS_EMOJI: Record<string, string> = {
  open: "⬜",
  in_progress: "🔄",
  blocked: "🚫",
  done: "✅",
};

const PRIORITY_BADGE: Record<string, string> = {
  high: " 🔴",
  normal: "",
  low: " ⬇️",
};

/**
 * Format a list of open tasks for display in Teams.
 * Groups by: blocked → open (no owner) → open (owned) → in_progress
 */
export function formatTaskList(tasks: TaskRow[], language: string): string {
  if (tasks.length === 0) {
    return language.startsWith("fr")
      ? "Aucune tâche ouverte dans ce canal pour l'instant."
      : "No open tasks tracked in this channel yet.";
  }

  // Group
  const blocked = tasks.filter((t) => t.status === "blocked");
  const unowned = tasks.filter((t) => t.status === "open" && !t.owner_name);
  const owned = tasks.filter((t) => t.status === "open" && t.owner_name);
  const inProgress = tasks.filter((t) => t.status === "in_progress");

  function formatRow(t: TaskRow): string {
    const emoji = STATUS_EMOJI[t.status] ?? "⬜";
    const priority = PRIORITY_BADGE[t.priority] ?? "";
    const owner = t.owner_name ? ` → ${t.owner_name}` : " → _Unassigned_";
    const deadline = t.deadline
      ? ` _(due ${new Date(t.deadline * 1000).toISOString().slice(0, 10)})_`
      : "";
    return `${emoji}${priority} ${t.description}${owner}${deadline}`;
  }

  const sections: string[] = [];

  if (blocked.length > 0) {
    sections.push("**Blocked:**");
    sections.push(...blocked.map(formatRow));
  }
  if (unowned.length > 0) {
    sections.push("**Needs an owner:**");
    sections.push(...unowned.map(formatRow));
  }
  if (owned.length > 0) {
    sections.push("**Open:**");
    sections.push(...owned.map(formatRow));
  }
  if (inProgress.length > 0) {
    sections.push("**In progress:**");
    sections.push(...inProgress.map(formatRow));
  }

  sections.push("");
  sections.push(`_${tasks.length} task(s) tracked. Use \`@Arcadia assign [task] to [name]\` to assign._`);

  return sections.join("\n");
}

/**
 * Static nudge post formatter (no AI).
 * Used as a fast fallback in the nudge engine.
 */
export function formatNudgePost(task: TaskRow, reason: NudgeReason): string {
  const owner = task.owner_name ? `**${task.owner_name}**` : "the team";
  const deadlineStr = task.deadline
    ? ` Deadline: ${new Date(task.deadline * 1000).toISOString().slice(0, 10)}.`
    : "";

  switch (reason) {
    case "no-owner":
      return `**Unowned task needs attention:**\n_${task.description}_\n\nNo owner assigned.${deadlineStr} Use \`@Arcadia assign ${task.description} to [name]\` to claim it.`;
    case "no-progress":
      return `**No progress on tracked task:**\n_${task.description}_\n\nAssigned to ${owner} — no updates recently.${deadlineStr}`;
    case "deadline-24h":
      return `**Due in < 24 hours:**\n_${task.description}_\n\n${owner} — please confirm status or flag if blocked.`;
    case "deadline-48h":
      return `**Deadline approaching:**\n_${task.description}_\n\n${owner} — check if on track.${deadlineStr}`;
  }
}

/**
 * Update the welcome message to include Phase 2 capabilities.
 */
export function buildWelcomeMessageV2(channelName?: string): string {
  const channel = channelName ? `**${channelName}**` : "this channel";
  return [
    `I'm Arcadia — your AI operations layer for Teams.`,
    "",
    `I'm now active in ${channel}. Here's what I can do:`,
    "",
    "**Understand what's happening:**",
    "- Summarize this thread or channel (`summarize`, `tl;dr`, `catch me up`)",
    "- Answer questions about ongoing work (`what's going on?`, `what's the status?`)",
    "- Surface decisions (`what did we decide?`) and next steps (`action items`)",
    "",
    "**Track work proactively:**",
    "- Show open tasks (`open tasks`, `what's on our plate`)",
    "- Assign ownership (`assign [task] to [name]`)",
    "- I'll nudge owners when tasks stall or deadlines approach",
    "",
    "**Generate reports:**",
    "- Daily digest — posted every morning at 8am UTC",
    "- Weekly report — posted Monday mornings",
    "",
    "**Get help drafting:**",
    "- `draft a follow-up to John`",
    "- `write a message to unblock the vendor review`",
    "",
    "Just @mention me or ask directly. I'll take it from there.",
  ].join("\n");
}
