// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Report Config REST API (Phase 9)
//
// All /api/webapp/reports/* routes.  Mounted from webapp/api.ts after auth.
//
// Routes:
//   GET    /api/webapp/reports/configs
//   POST   /api/webapp/reports/configs
//   PUT    /api/webapp/reports/configs/:id
//   DELETE /api/webapp/reports/configs/:id
//   GET    /api/webapp/reports/configs/:id/sources
//   POST   /api/webapp/reports/configs/:id/sources
//   DELETE /api/webapp/reports/configs/:id/sources/:sourceId
//   GET    /api/webapp/reports/history
//   POST   /api/webapp/reports/configs/:id/run
// ─────────────────────────────────────────────────────────────────────────────

import { jsonResponse, errorResponse } from "../middleware.js";
import { generateUserReport } from "../../intelligence/user-reports.js";
import type { Env, UserReportConfigRow, ReportSourceRow, ReportLogRow } from "../../types.js";
import type { WebappSession } from "../types.js";

// ─── Request body shapes ──────────────────────────────────────────────────────

interface CreateConfigBody {
  config_name: string;
  report_type: "daily" | "weekly";
  schedule_hour?: number;   // UTC hour 0–23; defaults to 8
  schedule_day?: number;    // Day of week 0–6 for weekly; defaults to 1 (Monday)
}

interface UpdateConfigBody {
  config_name?: string;
  report_type?: "daily" | "weekly";
  schedule_hour?: number;
  schedule_day?: number;
  active?: boolean;
}

interface CreateSourceBody {
  source_type: "team" | "channel" | "chat";
  source_id: string;        // bare ID for team/chat; '{teamId}:{channelId}' for channel
  source_name: string;
  label?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ownedConfig(
  configId: string,
  userId: string,
  env: Env,
): Promise<UserReportConfigRow | null> {
  return env.ARCADIA_DB.prepare(
    "SELECT * FROM user_report_configs WHERE id = ? AND user_id = ?",
  ).bind(configId, userId).first<UserReportConfigRow>();
}

// ─── Main router ──────────────────────────────────────────────────────────────

/**
 * Routes /api/webapp/reports/* requests.
 * Returns null when the path does not match any known route (caller handles 404).
 */
export async function handleReportsAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  const userId = session.userId;

  // ── GET /api/webapp/reports/configs ──────────────────────────────────────
  if (path === "/api/webapp/reports/configs" && method === "GET") {
    const result = await env.ARCADIA_DB.prepare(
      "SELECT * FROM user_report_configs WHERE user_id = ? ORDER BY created_at DESC",
    ).bind(userId).all<UserReportConfigRow>();
    return jsonResponse({ configs: result.results });
  }

  // ── POST /api/webapp/reports/configs ─────────────────────────────────────
  if (path === "/api/webapp/reports/configs" && method === "POST") {
    let body: CreateConfigBody;
    try {
      body = await request.json() as CreateConfigBody;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    if (!body.config_name?.trim()) return errorResponse("config_name is required", 400);
    if (body.report_type !== "daily" && body.report_type !== "weekly") {
      return errorResponse("report_type must be 'daily' or 'weekly'", 400);
    }

    const hour = body.schedule_hour !== undefined
      ? Math.max(0, Math.min(23, Math.floor(body.schedule_hour)))
      : 8;
    const day = body.schedule_day !== undefined
      ? Math.max(0, Math.min(6, Math.floor(body.schedule_day)))
      : null;
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    await env.ARCADIA_DB.prepare(
      `INSERT INTO user_report_configs (id, user_id, config_name, report_type, schedule_hour, schedule_day, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, userId, body.config_name.trim(), body.report_type, hour, day, now, now).run();

    const created = await env.ARCADIA_DB.prepare(
      "SELECT * FROM user_report_configs WHERE id = ?",
    ).bind(id).first<UserReportConfigRow>();
    return jsonResponse({ config: created }, 201);
  }

  // ── PUT /api/webapp/reports/configs/:id ──────────────────────────────────
  const configMatch = path.match(/^\/api\/webapp\/reports\/configs\/([^/]+)$/);
  if (configMatch && configMatch[1]) {
    const configId = configMatch[1];

    if (method === "PUT") {
      const config = await ownedConfig(configId, userId, env);
      if (!config) return errorResponse("Not found", 404);

      let body: UpdateConfigBody;
      try {
        body = await request.json() as UpdateConfigBody;
      } catch {
        return errorResponse("Invalid JSON", 400);
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.config_name !== undefined) {
        updates.push("config_name = ?");
        values.push(body.config_name.trim());
      }
      if (body.report_type !== undefined) {
        if (body.report_type !== "daily" && body.report_type !== "weekly") {
          return errorResponse("report_type must be 'daily' or 'weekly'", 400);
        }
        updates.push("report_type = ?");
        values.push(body.report_type);
      }
      if (body.schedule_hour !== undefined) {
        updates.push("schedule_hour = ?");
        values.push(Math.max(0, Math.min(23, Math.floor(body.schedule_hour))));
      }
      if (body.schedule_day !== undefined) {
        updates.push("schedule_day = ?");
        values.push(Math.max(0, Math.min(6, Math.floor(body.schedule_day))));
      }
      if (body.active !== undefined) {
        updates.push("active = ?");
        values.push(body.active ? 1 : 0);
      }

      if (updates.length === 0) return errorResponse("No fields to update", 400);

      updates.push("updated_at = ?");
      values.push(Math.floor(Date.now() / 1000));
      values.push(configId);

      await env.ARCADIA_DB.prepare(
        `UPDATE user_report_configs SET ${updates.join(", ")} WHERE id = ?`,
      ).bind(...values).run();

      const updated = await env.ARCADIA_DB.prepare(
        "SELECT * FROM user_report_configs WHERE id = ?",
      ).bind(configId).first<UserReportConfigRow>();
      return jsonResponse({ config: updated });
    }

    if (method === "DELETE") {
      const config = await ownedConfig(configId, userId, env);
      if (!config) return errorResponse("Not found", 404);

      await env.ARCADIA_DB.prepare(
        "DELETE FROM report_sources WHERE config_id = ?",
      ).bind(configId).run();
      await env.ARCADIA_DB.prepare(
        "DELETE FROM user_report_configs WHERE id = ?",
      ).bind(configId).run();
      return jsonResponse({ ok: true });
    }
  }

  // ── Sources: /api/webapp/reports/configs/:id/sources ─────────────────────
  const sourcesMatch = path.match(/^\/api\/webapp\/reports\/configs\/([^/]+)\/sources$/);
  if (sourcesMatch && sourcesMatch[1]) {
    const configId = sourcesMatch[1];

    if (method === "GET") {
      const config = await ownedConfig(configId, userId, env);
      if (!config) return errorResponse("Not found", 404);

      const result = await env.ARCADIA_DB.prepare(
        "SELECT * FROM report_sources WHERE config_id = ? ORDER BY created_at ASC",
      ).bind(configId).all<ReportSourceRow>();
      return jsonResponse({ sources: result.results });
    }

    if (method === "POST") {
      const config = await ownedConfig(configId, userId, env);
      if (!config) return errorResponse("Not found", 404);

      let body: CreateSourceBody;
      try {
        body = await request.json() as CreateSourceBody;
      } catch {
        return errorResponse("Invalid JSON", 400);
      }
      if (!body.source_id?.trim()) return errorResponse("source_id is required", 400);
      if (!body.source_name?.trim()) return errorResponse("source_name is required", 400);
      if (!["team", "channel", "chat"].includes(body.source_type)) {
        return errorResponse("source_type must be team, channel, or chat", 400);
      }

      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const label = body.label?.trim() || null;

      await env.ARCADIA_DB.prepare(
        `INSERT INTO report_sources (id, user_id, config_id, source_type, source_id, source_name, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, userId, configId, body.source_type, body.source_id.trim(), body.source_name.trim(), label, now).run();

      const created = await env.ARCADIA_DB.prepare(
        "SELECT * FROM report_sources WHERE id = ?",
      ).bind(id).first<ReportSourceRow>();
      return jsonResponse({ source: created }, 201);
    }
  }

  // ── DELETE /api/webapp/reports/configs/:id/sources/:sourceId ─────────────
  const sourceDeleteMatch = path.match(/^\/api\/webapp\/reports\/configs\/([^/]+)\/sources\/([^/]+)$/);
  if (sourceDeleteMatch && sourceDeleteMatch[1] && sourceDeleteMatch[2] && method === "DELETE") {
    const configId = sourceDeleteMatch[1];
    const sourceId = sourceDeleteMatch[2];

    const config = await ownedConfig(configId, userId, env);
    if (!config) return errorResponse("Not found", 404);

    const deleted = await env.ARCADIA_DB.prepare(
      "DELETE FROM report_sources WHERE id = ? AND config_id = ? AND user_id = ?",
    ).bind(sourceId, configId, userId).run();

    if (!deleted.meta.changes) return errorResponse("Source not found", 404);
    return jsonResponse({ ok: true });
  }

  // ── GET /api/webapp/reports/history ──────────────────────────────────────
  if (path === "/api/webapp/reports/history" && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
    const result = await env.ARCADIA_DB.prepare(
      "SELECT * FROM report_log WHERE user_id = ? ORDER BY generated_at DESC LIMIT ?",
    ).bind(userId, limit).all<ReportLogRow>();
    return jsonResponse({ history: result.results });
  }

  // ── POST /api/webapp/reports/configs/:id/run ──────────────────────────────
  const runMatch = path.match(/^\/api\/webapp\/reports\/configs\/([^/]+)\/run$/);
  if (runMatch && runMatch[1] && method === "POST") {
    const configId = runMatch[1];

    const config = await ownedConfig(configId, userId, env);
    if (!config) return errorResponse("Not found", 404);

    const nowSec = Math.floor(Date.now() / 1000);
    const insertResult = await env.ARCADIA_DB.prepare(
      "INSERT INTO report_log (user_id, config_id, status, generated_at) VALUES (?, ?, 'pending', ?)",
    ).bind(userId, configId, nowSec).run();
    const logId = insertResult.meta.last_row_id as number | undefined;

    try {
      const content = await generateUserReport(userId, configId, env);
      if (!content) {
        if (logId !== undefined) {
          await env.ARCADIA_DB.prepare("UPDATE report_log SET status = 'failed' WHERE id = ?")
            .bind(logId).run();
        }
        return errorResponse("Report generation failed — check your sources and token", 500);
      }

      if (logId !== undefined) {
        await env.ARCADIA_DB.prepare(
          "UPDATE report_log SET status = 'generated', content_preview = ? WHERE id = ?",
        ).bind(content.slice(0, 500), logId).run();
      }
      return jsonResponse({ ok: true, preview: content.slice(0, 500), full: content });
    } catch (err) {
      if (logId !== undefined) {
        await env.ARCADIA_DB.prepare("UPDATE report_log SET status = 'failed' WHERE id = ?")
          .bind(logId).run();
      }
      console.error(`[Reports API] Manual run failed for config ${configId}:`, err);
      return errorResponse("Report generation failed", 500);
    }
  }

  return null; // not a reports route
}
