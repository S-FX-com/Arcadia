// Weekly Monday operational roll-up.
//
// Once a week (Mondays at 08:00 UTC) we aggregate the prior 7-day
// window across every enabled channel: tasks opened/completed/blocked,
// decisions, recent stale threads. The roll-up is summarised by the AI
// router and stored in `briefs` with kind = 'weekly' and target_kind =
// 'tenant'. Delivery to a designated channel lands when the dashboard
// + admin-channel binding ship; for now it's persisted and surfaced via
// the webapp/dashboard API.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import { injectCharter } from "../charter/inject";
import { postText } from "../runtime/bot-outbound";

export interface WeeklyRunResult {
  tasksOpened: number;
  tasksCompleted: number;
  tasksBlocked: number;
  decisions: number;
  staleNow: number;
  channels: number;
  briefId: string | null;
}

const WINDOW_DAYS = 7;

export async function runWeeklyCycle(
  env: Env,
  log: Logger,
): Promise<WeeklyRunResult> {
  const since = new Date(
    Date.now() - WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();

  const stats = await aggregateStats(env, since);
  const topChannels = await topChannelsByActivity(env, since);
  const topDecisions = await recentDecisions(env, since);

  const router = new Router(env);
  const body = await summarize(env, router, stats, topChannels, topDecisions, log);

  const briefId = crypto.randomUUID();
  await env.ARCADIA_DB.prepare(
    `INSERT INTO briefs (id, kind, target_kind, target_id, body, message_id, posted_at)
     VALUES (?, 'weekly', 'tenant', ?, ?, NULL, ?)`,
  )
    .bind(
      briefId,
      env.ADMIN_USER_AAD_ID ?? "tenant",
      body,
      new Date().toISOString(),
    )
    .run();

  await deliverWeekly(env, body, log);

  const result: WeeklyRunResult = { ...stats, briefId };
  log.info("weekly_cycle", result);
  return result;
}

async function deliverWeekly(
  env: Env,
  body: string,
  log: Logger,
): Promise<void> {
  const channelId = env.WEEKLY_REPORT_CHANNEL_ID;
  if (!channelId) return;
  const row = await env.ARCADIA_DB.prepare(
    `SELECT service_url, conversation_id FROM channels WHERE channel_id = ?`,
  )
    .bind(channelId)
    .first<{ service_url: string; conversation_id: string | null }>();
  if (!row?.conversation_id) {
    log.warn("weekly_delivery_skipped_no_channel", { channelId });
    return;
  }
  try {
    await postText(
      env,
      {
        serviceUrl: row.service_url,
        conversationId: row.conversation_id,
      },
      `Weekly roll-up:\n\n${body}`,
      log,
    );
  } catch (e) {
    log.warn("weekly_delivery_failed", { error: String(e) });
  }
}

interface Aggregated {
  tasksOpened: number;
  tasksCompleted: number;
  tasksBlocked: number;
  decisions: number;
  staleNow: number;
  channels: number;
}

async function aggregateStats(
  env: Env,
  since: string,
): Promise<Aggregated> {
  const taskRows = await env.ARCADIA_DB.prepare(
    `SELECT
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN status = 'done' AND updated_at >= ? THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked
     FROM tasks`,
  )
    .bind(since, since)
    .first<{ opened: number | null; completed: number | null; blocked: number | null }>();

  const decisionRow = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM decisions WHERE decided_at >= ?`,
  )
    .bind(since)
    .first<{ n: number }>();

  const staleRow = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM threads WHERE stale_at IS NOT NULL`,
  ).first<{ n: number }>();

  const channelRow = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) AS n FROM channels WHERE enabled = 1`,
  ).first<{ n: number }>();

  return {
    tasksOpened: taskRows?.opened ?? 0,
    tasksCompleted: taskRows?.completed ?? 0,
    tasksBlocked: taskRows?.blocked ?? 0,
    decisions: decisionRow?.n ?? 0,
    staleNow: staleRow?.n ?? 0,
    channels: channelRow?.n ?? 0,
  };
}

async function topChannelsByActivity(
  env: Env,
  since: string,
): Promise<{ display_name: string | null; opened: number; completed: number }[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT c.display_name,
            SUM(CASE WHEN t.created_at >= ? THEN 1 ELSE 0 END) AS opened,
            SUM(CASE WHEN t.status = 'done' AND t.updated_at >= ? THEN 1 ELSE 0 END) AS completed
       FROM channels c
       LEFT JOIN tasks t ON t.channel_id = c.channel_id
      WHERE c.enabled = 1
      GROUP BY c.channel_id, c.display_name
      ORDER BY opened + completed DESC
      LIMIT 5`,
  )
    .bind(since, since)
    .all<{ display_name: string | null; opened: number; completed: number }>();
  return rows.results;
}

async function recentDecisions(
  env: Env,
  since: string,
): Promise<{ text: string; decided_at: string }[]> {
  const rows = await env.ARCADIA_DB.prepare(
    `SELECT text, decided_at
       FROM decisions
      WHERE decided_at >= ?
      ORDER BY decided_at DESC
      LIMIT 10`,
  )
    .bind(since)
    .all<{ text: string; decided_at: string }>();
  return rows.results;
}

async function summarize(
  env: Env,
  router: Router,
  stats: Aggregated,
  topChannels: { display_name: string | null; opened: number; completed: number }[],
  topDecisions: { text: string; decided_at: string }[],
  log: Logger,
): Promise<string> {
  const channelsBlock = topChannels.length
    ? topChannels
        .map(
          (c) =>
            `- ${c.display_name ?? "(unnamed)"}: ${c.opened} opened / ${c.completed} done`,
        )
        .join("\n")
    : "- (no channel activity)";

  const decisionsBlock = topDecisions.length
    ? topDecisions.map((d) => `- ${d.text} (${d.decided_at})`).join("\n")
    : "- (no decisions recorded)";

  try {
    const system = await injectCharter(
      env,
      "You are Arcadia. Write a weekly operational roll-up for the operator — under 10 lines, plain prose. Lead with the headline. Call out what's slipping. No filler, no markdown headers.",
    );
    const reply = await router.complete({
      system,
      messages: [
        {
          role: "user",
          content: `Last 7 days:
- Tasks opened: ${stats.tasksOpened}
- Tasks completed: ${stats.tasksCompleted}
- Currently blocked: ${stats.tasksBlocked}
- Decisions captured: ${stats.decisions}
- Stale threads right now: ${stats.staleNow}
- Channels active: ${stats.channels}

Top channels:
${channelsBlock}

Decisions:
${decisionsBlock}`,
        },
      ],
      tier: "deep",
      maxTokens: 600,
    });
    return reply.text.trim();
  } catch (e) {
    log.warn("weekly_summarize_failed", { error: String(e) });
    return `Weekly: ${stats.tasksOpened} opened, ${stats.tasksCompleted} completed, ${stats.tasksBlocked} blocked, ${stats.decisions} decisions, ${stats.staleNow} stale threads across ${stats.channels} channels.`;
  }
}
