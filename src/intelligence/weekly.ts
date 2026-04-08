// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — Weekly Report Generator
//
// Produces Monday morning operational reports aggregating the past 7 days
// of task activity and channel conversations.
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import { buildWeeklyReportPrompt } from "../ai/prompts.js";
import { getChannelMessages } from "../graph/messages.js";
import {
  getOpenTasksForChannel,
  getTasksDueWithin,
  logWeeklyReport,
} from "../tasks/store.js";
import { detectConversationLanguage } from "./context.js";
import type { ChannelRow, Env, WeeklyTaskStats } from "../types.js";

// ─── Week helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the YYYY-MM-DD of the most recent Monday (UTC).
 */
export function getWeekStart(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, …
  const diff = day === 0 ? 6 : day - 1; // Days since Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

// ─── KV cache ─────────────────────────────────────────────────────────────────

function weeklyCacheKey(teamId: string, channelId: string, weekStart: string): string {
  return `weekly:${teamId}:${channelId}:${weekStart}`;
}

async function getCachedReport(
  teamId: string,
  channelId: string,
  weekStart: string,
  env: Env
): Promise<string | null> {
  return env.ARCADIA_CACHE.get(weeklyCacheKey(teamId, channelId, weekStart));
}

async function cacheReport(
  teamId: string,
  channelId: string,
  weekStart: string,
  content: string,
  env: Env
): Promise<void> {
  await env.ARCADIA_CACHE.put(
    weeklyCacheKey(teamId, channelId, weekStart),
    content,
    { expirationTtl: 3600 } // 1 hour
  );
}

// ─── Stats compilation ────────────────────────────────────────────────────────

/**
 * Compile task statistics for the weekly report.
 * Note: "doneThisWeek" requires querying closed tasks — for MVP we approximate
 * using open task counts and flag everything as active.
 */
async function compileWeeklyStats(
  teamId: string,
  channelId: string,
  env: Env
): Promise<WeeklyTaskStats> {
  const [openTasks, overdueOrDue] = await Promise.all([
    getOpenTasksForChannel(teamId, channelId, env),
    getTasksDueWithin(0, env), // Already past deadline (deadline < now)
  ]);

  const now = Math.floor(Date.now() / 1000);
  const ownerGaps = openTasks.filter((t) => !t.owner_id && !t.owner_name).length;
  const blockedCount = openTasks.filter((t) => t.status === "blocked").length;

  // Overdue = deadline set and in the past
  const deadlinesMissed = openTasks.filter(
    (t) => t.deadline !== null && t.deadline < now
  ).length;

  return {
    openCount: openTasks.length,
    blockedCount,
    doneThisWeek: 0, // Requires done-task tracking (future enhancement)
    ownerGaps,
    deadlinesMissed,
  };
}

// ─── Report generation ────────────────────────────────────────────────────────

/**
 * Generate the weekly report text for a channel.
 * Returns the full formatted report string.
 */
export async function generateWeeklyReport(
  channel: ChannelRow,
  env: Env
): Promise<string> {
  const weekStart = getWeekStart();

  // Check KV cache first
  const cached = await getCachedReport(channel.team_id, channel.channel_id, weekStart, env);
  if (cached) return cached;

  // Fetch last 7 days of messages
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let messages;
  try {
    messages = await getChannelMessages(channel.team_id, channel.channel_id, env, 100, since);
  } catch {
    messages = [];
  }

  const language = messages.length > 0
    ? detectConversationLanguage(messages)
    : "en";

  const stats = await compileWeeklyStats(channel.team_id, channel.channel_id, env);

  const { system, user } = buildWeeklyReportPrompt(
    channel.channel_name,
    weekStart,
    stats,
    messages,
    language
  );

  let content: string;
  try {
    const response = await callAI(system, user, env);
    content = response.text;
  } catch (err) {
    // Fallback to a static summary if AI fails
    content = buildStaticWeeklyReport(channel.channel_name, weekStart, stats);
  }

  // Cache and return
  await cacheReport(channel.team_id, channel.channel_id, weekStart, content, env);
  return content;
}

/**
 * Static fallback weekly report (no AI) — used when model calls fail.
 */
function buildStaticWeeklyReport(
  channelName: string,
  weekStart: string,
  stats: WeeklyTaskStats
): string {
  const lines = [
    `**Weekly Summary — Week of ${weekStart}** | ${channelName}`,
    "",
    `**Active workstreams:** ${stats.openCount} open task(s)`,
    `**Completed:** ${stats.doneThisWeek > 0 ? stats.doneThisWeek : "None this week"}`,
    `**At risk:** ${stats.blockedCount} blocked, ${stats.deadlinesMissed} overdue`,
    `**Action needed:** ${stats.ownerGaps > 0 ? `${stats.ownerGaps} task(s) have no assigned owner` : "None"}`,
    "",
  ];

  if (stats.deadlinesMissed > 0 || stats.blockedCount > 0) {
    lines.push("Needs attention — some items are blocked or overdue.");
  } else if (stats.openCount === 0) {
    lines.push("All clear — no open tasks this week.");
  } else {
    lines.push("On track.");
  }

  return lines.join("\n");
}

// ─── Proactive posting ────────────────────────────────────────────────────────

/**
 * Generate and post the weekly report to a Teams channel, then log it to D1.
 */
export async function postWeeklyReport(
  channel: ChannelRow,
  env: Env
): Promise<void> {
  if (!channel.service_url || !channel.conversation_id) {
    console.warn(
      `[Arcadia/Weekly] No service URL for ${channel.channel_id} — skipping post`
    );
    return;
  }

  const weekStart = getWeekStart();
  const content = await generateWeeklyReport(channel, env);

  // Get Bot Framework token
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
    console.error("[Arcadia/Weekly] Bot token fetch failed:", tokenRes.status);
    return;
  }
  const { access_token } = await tokenRes.json() as { access_token: string };

  const url = `${channel.service_url.replace(/\/$/, "")}/v3/conversations/${channel.conversation_id}/activities`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "message", text: content, textFormat: "markdown" }),
  });

  if (!res.ok) {
    console.error("[Arcadia/Weekly] Post failed:", res.status, await res.text());
    return;
  }

  // Log to D1
  await logWeeklyReport(channel.team_id, channel.channel_id, weekStart, content, env);
  console.log(`[Arcadia/Weekly] Report posted for ${channel.channel_name} (week: ${weekStart})`);
}
