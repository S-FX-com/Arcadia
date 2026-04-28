// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Per-User Report Generation (Phase 9)
//
// generateUserReport  — builds a report for one config using the user's
//                       delegated token to read their Teams/Channels/Chats.
// runUserReportCron   — scans user_report_configs for reports due this hour,
//                       generates them, and delivers via Bot Framework DM.
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import { buildReportPrompt } from "../ai/prompts.js";
import { getChannelMessages, getChatMessages, getTeamChannels } from "../webapp/context/teams.js";
import { decryptToken, encryptToken } from "../webapp/crypto.js";
import { features } from "../features.js";
import { BOT_FRAMEWORK, GRAPH } from "../constants.js";
import type { ChannelMessage, Env, UserReportConfigRow, ReportSourceRow } from "../types.js";
import type { WebappSessionRow } from "../webapp/types.js";

// ─── Token management ─────────────────────────────────────────────────────────

interface MSTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

/**
 * Retrieves a valid delegated access token for a user without an active HTTP
 * session (cron context). Attempts a token refresh when the stored token is
 * within 60 seconds of expiry or already expired.
 * Returns null if no session exists, the user needs to re-authenticate, or
 * the refresh fails (caller should log and skip delivery for this cycle).
 */
async function getValidAccessTokenForUser(userId: string, env: Env): Promise<string | null> {
  const row = await env.ARCADIA_DB.prepare(
    "SELECT * FROM webapp_sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1",
  ).bind(userId).first<WebappSessionRow>();

  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);

  if (row.token_expiry >= now + 60) {
    try {
      return await decryptToken(row.access_token, env.WEBAPP_SESSION_SECRET);
    } catch {
      console.error(`[UserReports] Failed to decrypt access token for user ${userId}`);
      return null;
    }
  }

  // Token expired — attempt refresh
  if (!row.refresh_token) {
    console.warn(`[UserReports] No refresh token for user ${userId} — re-auth required`);
    return null;
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptToken(row.refresh_token, env.WEBAPP_SESSION_SECRET);
  } catch {
    console.error(`[UserReports] Failed to decrypt refresh token for user ${userId}`);
    return null;
  }

  let refreshed: MSTokenResponse | null = null;
  try {
    const res = await fetch(GRAPH.TOKEN_URL(env.GRAPH_TENANT_ID), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.WEBAPP_CLIENT_ID,
        client_secret: env.WEBAPP_CLIENT_SECRET,
        refresh_token: refreshToken,
        scope: row.scopes || "openid profile email User.Read Chat.Read ChannelMessage.Read.All Group.Read.All Team.ReadBasic.All offline_access",
      }).toString(),
    });
    if (!res.ok) {
      console.error(`[UserReports] Token refresh failed for user ${userId}: ${res.status}`, await res.text());
      return null;
    }
    refreshed = await res.json() as MSTokenResponse;
  } catch (err) {
    console.error(`[UserReports] Token refresh error for user ${userId}:`, err);
    return null;
  }

  // Persist refreshed tokens so subsequent calls in this hour also benefit
  try {
    const encAccess = await encryptToken(refreshed.access_token, env.WEBAPP_SESSION_SECRET);
    const encRefresh = refreshed.refresh_token
      ? await encryptToken(refreshed.refresh_token, env.WEBAPP_SESSION_SECRET)
      : row.refresh_token;
    const newExpiry = now + refreshed.expires_in;
    await env.ARCADIA_DB.prepare(
      "UPDATE webapp_sessions SET access_token = ?, refresh_token = ?, token_expiry = ?, last_active = ? WHERE id = ?",
    ).bind(encAccess, encRefresh, newExpiry, now, row.id).run();
    console.log(`[UserReports] Token refreshed for user ${userId}`);
  } catch (err) {
    console.error(`[UserReports] Failed to persist refreshed token for user ${userId}:`, err);
    // Return the new token even if we couldn't write it back
  }

  return refreshed.access_token;
}

// ─── Message fetching ─────────────────────────────────────────────────────────

async function fetchSourceMessages(
  source: ReportSourceRow,
  accessToken: string,
  since: Date,
): Promise<{ messages: ChannelMessage[]; label: string }> {
  const label = source.label ?? source.source_name;
  let raw: ChannelMessage[] = [];

  try {
    if (source.source_type === "chat") {
      raw = await getChatMessages(source.source_id, accessToken, 50);
    } else if (source.source_type === "channel") {
      // source_id encoded as '{teamId}:{channelId}'
      const colon = source.source_id.indexOf(":");
      if (colon > 0) {
        const teamId = source.source_id.slice(0, colon);
        const channelId = source.source_id.slice(colon + 1);
        raw = await getChannelMessages(teamId, channelId, accessToken, 50);
      }
    } else if (source.source_type === "team") {
      // Enumerate up to 5 channels in the team
      const channels = await getTeamChannels(source.source_id, accessToken).catch(() => []);
      const fetches = channels.slice(0, 5).map((ch) =>
        getChannelMessages(source.source_id, ch.id, accessToken, 25).catch(() => [] as ChannelMessage[]),
      );
      raw = (await Promise.all(fetches)).flat();
    }
  } catch (err) {
    console.error(`[UserReports] Failed to fetch messages for source "${label}":`, err);
  }

  const sinceMs = since.getTime();
  const messages = raw
    .filter((m) => new Date(m.timestamp).getTime() >= sinceMs)
    .map((m) => ({ ...m, channelName: label }));

  return { messages, label };
}

// ─── Report generation ────────────────────────────────────────────────────────

/**
 * Generates the report text for a specific config.
 * Does not deliver — returns the string for the caller to store and send.
 * Returns null if the config is unavailable, has no sources, or the user
 * has no valid delegated token.
 */
export async function generateUserReport(
  userId: string,
  configId: string,
  env: Env,
): Promise<string | null> {
  const config = await env.ARCADIA_DB.prepare(
    "SELECT * FROM user_report_configs WHERE id = ? AND user_id = ? AND active = 1",
  ).bind(configId, userId).first<UserReportConfigRow>();

  if (!config) {
    console.warn(`[UserReports] Config ${configId} not found or inactive for user ${userId}`);
    return null;
  }

  const sourcesResult = await env.ARCADIA_DB.prepare(
    "SELECT * FROM report_sources WHERE config_id = ? ORDER BY created_at ASC",
  ).bind(configId).all<ReportSourceRow>();

  if (sourcesResult.results.length === 0) {
    console.warn(`[UserReports] No sources configured for report ${configId}`);
    return null;
  }

  const accessToken = await getValidAccessTokenForUser(userId, env);
  if (!accessToken) {
    console.error(`[UserReports] No valid token for user ${userId} — skipping report`);
    return null;
  }

  const periodHours = config.report_type === "weekly" ? 7 * 24 : 24;
  const since = new Date(Date.now() - periodHours * 3600 * 1000);

  const sourceResults = await Promise.all(
    sourcesResult.results.map((s) => fetchSourceMessages(s, accessToken, since)),
  );

  const allMessages: ChannelMessage[] = sourceResults.flatMap((r) => r.messages);
  const sourceLabels = sourceResults.map((r) => r.label);
  const period: "daily" | "weekly" = config.report_type === "weekly" ? "weekly" : "daily";

  if (allMessages.length === 0) {
    const periodLabel = period === "daily" ? "past 24 hours" : "past 7 days";
    return `**${period === "daily" ? "Daily" : "Weekly"} Report — ${config.config_name} — ${new Date().toISOString().slice(0, 10)}**\n\nNo activity across your configured sources in the ${periodLabel}.`;
  }

  const linkedUser = await env.ARCADIA_DB.prepare(
    "SELECT display_name FROM linked_users WHERE aad_object_id = ?",
  ).bind(userId).first<{ display_name: string }>();
  const userName = linkedUser?.display_name ?? "there";

  const { system, user } = buildReportPrompt(userName, sourceLabels, allMessages, period);
  const response = await callAI(system, user, env);
  return response.text;
}

// ─── Report delivery ──────────────────────────────────────────────────────────

async function deliverReportToUser(userId: string, content: string, env: Env): Promise<boolean> {
  const linked = await env.ARCADIA_DB.prepare(
    "SELECT conversation_id, service_url FROM linked_users WHERE aad_object_id = ?",
  ).bind(userId).first<{ conversation_id: string | null; service_url: string | null }>();

  if (!linked?.conversation_id || !linked?.service_url) {
    console.warn(`[UserReports] No DM conversation ref for user ${userId} — cannot deliver`);
    return false;
  }

  const tokenRes = await fetch(GRAPH.TOKEN_URL(env.GRAPH_TENANT_ID), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TEAMS_APP_ID,
      client_secret: env.TEAMS_APP_PASSWORD,
      scope: BOT_FRAMEWORK.SCOPE,
    }).toString(),
  });

  if (!tokenRes.ok) {
    console.error(`[UserReports] Bot Framework token fetch failed: ${tokenRes.status}`);
    return false;
  }

  const { access_token } = await tokenRes.json() as { access_token: string };
  const dmUrl = `${linked.service_url.replace(/\/$/, "")}/v3/conversations/${linked.conversation_id}/activities`;

  const res = await fetch(dmUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "message", text: content, textFormat: "markdown" }),
  });

  if (!res.ok) {
    console.error(`[UserReports] Delivery failed for user ${userId}: ${res.status}`, await res.text());
    return false;
  }

  return true;
}

// ─── Cron runner ──────────────────────────────────────────────────────────────

/**
 * Fired by the hourly cron ("0 * * * *").
 * Finds all active report configs scheduled for the current UTC hour,
 * generates the report, and delivers it to the user's Teams DM.
 */
export async function runUserReportCron(env: Env): Promise<void> {
  if (!features.userReports(env)) return;

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentDay = now.getUTCDay(); // 0 = Sunday

  console.log(`[UserReports] Cron: UTC hour ${currentHour}, day ${currentDay}`);

  const configsResult = await env.ARCADIA_DB.prepare(
    "SELECT * FROM user_report_configs WHERE active = 1 AND schedule_hour = ?",
  ).bind(currentHour).all<UserReportConfigRow>();

  if (configsResult.results.length === 0) return;
  console.log(`[UserReports] ${configsResult.results.length} config(s) due`);

  // Start of today (UTC) and start of this week (Monday UTC) for dedup checks
  const todayStart = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
  );
  const mondayOffset = (currentDay + 6) % 7;
  const weekStart = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset) / 1000,
  );

  for (const config of configsResult.results) {
    // Weekly: only run on the configured day (default Monday)
    if (config.report_type === "weekly") {
      const targetDay = config.schedule_day ?? 1;
      if (currentDay !== targetDay) continue;
    }

    // Skip if already delivered in the current period
    const periodStart = config.report_type === "daily" ? todayStart : weekStart;
    const alreadyDone = await env.ARCADIA_DB.prepare(
      "SELECT id FROM report_log WHERE config_id = ? AND status IN ('delivered', 'generated') AND generated_at >= ? LIMIT 1",
    ).bind(config.id, periodStart).first<{ id: number }>();
    if (alreadyDone) continue;

    // Insert pending log entry
    const nowSec = Math.floor(Date.now() / 1000);
    const insertResult = await env.ARCADIA_DB.prepare(
      "INSERT INTO report_log (user_id, config_id, status, generated_at) VALUES (?, ?, 'pending', ?)",
    ).bind(config.user_id, config.id, nowSec).run();
    const logId = insertResult.meta.last_row_id as number | undefined;

    try {
      const content = await generateUserReport(config.user_id, config.id, env);

      if (!content) {
        if (logId !== undefined) {
          await env.ARCADIA_DB.prepare("UPDATE report_log SET status = 'failed' WHERE id = ?")
            .bind(logId).run();
        }
        continue;
      }

      if (logId !== undefined) {
        await env.ARCADIA_DB.prepare(
          "UPDATE report_log SET status = 'generated', content_preview = ? WHERE id = ?",
        ).bind(content.slice(0, 500), logId).run();
      }

      const delivered = await deliverReportToUser(config.user_id, content, env);
      const deliveredSec = delivered ? Math.floor(Date.now() / 1000) : null;

      if (logId !== undefined) {
        await env.ARCADIA_DB.prepare(
          "UPDATE report_log SET status = ?, delivered_at = ? WHERE id = ?",
        ).bind(delivered ? "delivered" : "failed", deliveredSec, logId).run();
      }

      console.log(`[UserReports] Config ${config.id} (${config.config_name}): ${delivered ? "delivered" : "delivery failed"}`);
    } catch (err) {
      console.error(`[UserReports] Report generation failed for config ${config.id}:`, err);
      if (logId !== undefined) {
        await env.ARCADIA_DB.prepare("UPDATE report_log SET status = 'failed' WHERE id = ?")
          .bind(logId).run();
      }
    }
  }

  console.log("[UserReports] Cron complete.");
}
