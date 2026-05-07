// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Admin API Handler (Phase 12)
//
// Routes: /api/webapp/admin/*
// All routes require at minimum 'manager' role. Write operations require 'admin'.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types.js";
import type { WebappSession, UserRoleRow, ShiftTemplateRow, ShiftWriteLogRow } from "../types.js";
import { requireRole, auditLog } from "../admin-middleware.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import { getSessionAccessToken } from "../auth.js";
import { getUserTeams } from "../context/teams.js";
import { pushShiftsToTeams, deleteShiftFromTeams } from "../context/shifts-write.js";
import { getUserShifts } from "../context/shifts.js";
import { getPendingUpdates } from "../context/updates.js";
import { MODEL_REGISTRY, getModel, type ModelPurpose } from "../../ai/model-registry.js";

// ─── Utility ─────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function parseBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>;
}

// ─── Main Router ─────────────────────────────────────────────────────────────

export async function handleAdminAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // Users & Roles
  if (path === "/api/webapp/admin/users" && method === "GET") {
    return listUsers(session, env);
  }
  const rolePutMatch = path.match(/^\/api\/webapp\/admin\/users\/([^/]+)\/role$/);
  if (rolePutMatch?.[1] && (method === "PUT" || method === "POST")) {
    return assignRole(rolePutMatch[1], request, session, env);
  }
  if (rolePutMatch?.[1] && method === "DELETE") {
    return removeRole(rolePutMatch[1], session, env);
  }

  // Shift Templates
  if (path === "/api/webapp/admin/shifts/templates" && method === "GET") {
    return listShiftTemplates(session, env);
  }
  if (path === "/api/webapp/admin/shifts/templates" && method === "POST") {
    return createShiftTemplate(request, session, env);
  }
  const templateMatch = path.match(/^\/api\/webapp\/admin\/shifts\/templates\/([^/]+)$/);
  if (templateMatch?.[1] && method === "PUT") {
    return updateShiftTemplate(templateMatch[1], request, session, env);
  }
  if (templateMatch?.[1] && method === "DELETE") {
    return deleteShiftTemplate(templateMatch[1], session, env);
  }
  const pushMatch = path.match(/^\/api\/webapp\/admin\/shifts\/templates\/([^/]+)\/push$/);
  if (pushMatch?.[1] && method === "POST") {
    return pushShiftTemplate(pushMatch[1], request, session, env, ctx);
  }
  const pushStatusMatch = path.match(/^\/api\/webapp\/admin\/shifts\/push-status\/([^/]+)$/);
  if (pushStatusMatch?.[1] && method === "GET") {
    return getPushStatus(pushStatusMatch[1], session, env);
  }
  const deleteLogMatch = path.match(/^\/api\/webapp\/admin\/shifts\/pushed\/(\d+)$/);
  if (deleteLogMatch && method === "DELETE") {
    return deletePushedShift(Number(deleteLogMatch[1]), session, env);
  }

  // Staff Reports
  if (path === "/api/webapp/admin/reports/staff" && method === "GET") {
    return staffReport(url, session, env);
  }

  // Audit Log
  if (path === "/api/webapp/admin/audit-log" && method === "GET") {
    return getAuditLog(url, session, env);
  }

  // Model registry — visibility into which Workers AI models are wired up
  // per purpose. Read-only; overrides happen via wrangler env vars
  // (MODEL_QUICK_CHAT, MODEL_DEEP_RESEARCH, MODEL_CODING).
  if (path === "/api/webapp/admin/models" && method === "GET") {
    return listModels(session, env);
  }

  return null;
}

// ─── Models ───────────────────────────────────────────────────────────────────

async function listModels(session: WebappSession, env: Env): Promise<Response> {
  const roleResult = await requireRole(session, "manager", env);
  if (!roleResult.ok) return roleResult.response;

  const purposes = Object.keys(MODEL_REGISTRY) as ModelPurpose[];
  const models = purposes.map((purpose) => {
    const baseline = MODEL_REGISTRY[purpose];
    const effective = getModel(purpose, env);
    return {
      purpose,
      modelId: effective.modelId,
      defaultModelId: baseline.modelId,
      overridden: effective.modelId !== baseline.modelId,
      fallback: baseline.fallback ?? null,
      maxTokens: effective.maxTokens,
    };
  });
  return jsonResponse({
    agentLoopEnabled: env.AGENT_LOOP_ENABLED === "true",
    models,
  });
}

// ─── Users & Roles ────────────────────────────────────────────────────────────

async function listUsers(session: WebappSession, env: Env): Promise<Response> {
  const roleResult = await requireRole(session, "manager", env);
  if (!roleResult.ok) return roleResult.response;

  // Join linked_users with user_roles (LEFT JOIN so unroled users show as viewer)
  const rows = await env.ARCADIA_DB.prepare(`
    SELECT
      lu.aad_object_id AS user_id,
      lu.display_name,
      lu.email,
      lu.last_auth_at,
      COALESCE(ur.role, 'viewer') AS role,
      ur.assigned_by,
      ur.assigned_at
    FROM linked_users lu
    LEFT JOIN user_roles ur ON ur.user_id = lu.aad_object_id
    ORDER BY lu.display_name ASC
  `).all<{
    user_id: string;
    display_name: string;
    email: string | null;
    last_auth_at: number | null;
    role: string;
    assigned_by: string | null;
    assigned_at: number | null;
  }>();

  return jsonResponse({ users: rows.results });
}

async function assignRole(
  targetUserId: string,
  request: Request,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const body = await parseBody<{ role: string }>(request);
  if (!["admin", "manager", "viewer"].includes(body.role)) {
    return errorResponse("role must be admin, manager, or viewer", 400);
  }

  // Look up the target user's display name from linked_users
  const target = await env.ARCADIA_DB.prepare(
    "SELECT display_name, email FROM linked_users WHERE aad_object_id = ?",
  ).bind(targetUserId).first<{ display_name: string; email: string | null }>();

  if (!target) return errorResponse("User not found", 404);

  const t = now();
  await env.ARCADIA_DB.prepare(`
    INSERT INTO user_roles (user_id, display_name, email, role, assigned_by, assigned_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, assigned_by = excluded.assigned_by, updated_at = excluded.updated_at
  `)
    .bind(targetUserId, target.display_name, target.email ?? null, body.role, session.userId, t, t)
    .run();

  await auditLog(session, "role.assign", "user", targetUserId, { role: body.role, targetName: target.display_name }, env);
  return jsonResponse({ ok: true });
}

async function removeRole(
  targetUserId: string,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  // Cannot remove your own admin role if you are the only admin
  if (targetUserId === session.userId) {
    const otherAdmins = await env.ARCADIA_DB.prepare(
      "SELECT COUNT(*) AS cnt FROM user_roles WHERE role = 'admin' AND user_id != ?",
    ).bind(session.userId).first<{ cnt: number }>();
    if (!otherAdmins || otherAdmins.cnt === 0) {
      return errorResponse("Cannot remove the only admin", 400);
    }
  }

  await env.ARCADIA_DB.prepare("DELETE FROM user_roles WHERE user_id = ?").bind(targetUserId).run();
  await auditLog(session, "role.remove", "user", targetUserId, { revertedTo: "viewer" }, env);
  return jsonResponse({ ok: true });
}

// ─── Shift Templates ──────────────────────────────────────────────────────────

async function listShiftTemplates(session: WebappSession, env: Env): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const rows = await env.ARCADIA_DB.prepare(
    "SELECT * FROM shift_templates WHERE active = 1 ORDER BY created_at DESC",
  ).all<ShiftTemplateRow>();

  return jsonResponse({ templates: rows.results });
}

async function createShiftTemplate(
  request: Request,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const body = await parseBody<{
    name: string;
    team_id: string;
    scheduling_group_id?: string;
    display_name?: string;
    theme?: string;
    notes?: string;
    recurrence_rule: object;
  }>(request);

  if (!body.name || !body.team_id || !body.recurrence_rule) {
    return errorResponse("name, team_id, and recurrence_rule are required", 400);
  }

  const id = uuid();
  const t = now();
  await env.ARCADIA_DB.prepare(`
    INSERT INTO shift_templates
    (id, name, team_id, scheduling_group_id, display_name, theme, notes, recurrence_rule, active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
    .bind(
      id, body.name, body.team_id,
      body.scheduling_group_id ?? null,
      body.display_name ?? null,
      body.theme ?? "blue",
      body.notes ?? null,
      JSON.stringify(body.recurrence_rule),
      session.userId, t, t,
    )
    .run();

  await auditLog(session, "shift_template.create", "shift_template", id, { name: body.name, team_id: body.team_id }, env);
  return jsonResponse({ id, ok: true }, 201);
}

async function updateShiftTemplate(
  templateId: string,
  request: Request,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const existing = await env.ARCADIA_DB.prepare(
    "SELECT id FROM shift_templates WHERE id = ? AND active = 1",
  ).bind(templateId).first<{ id: string }>();
  if (!existing) return errorResponse("Template not found", 404);

  const body = await parseBody<Partial<{
    name: string;
    display_name: string;
    theme: string;
    notes: string;
    scheduling_group_id: string;
    recurrence_rule: object;
  }>>(request);

  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now()];

  if (body.name !== undefined) { sets.push("name = ?"); binds.push(body.name); }
  if (body.display_name !== undefined) { sets.push("display_name = ?"); binds.push(body.display_name); }
  if (body.theme !== undefined) { sets.push("theme = ?"); binds.push(body.theme); }
  if (body.notes !== undefined) { sets.push("notes = ?"); binds.push(body.notes); }
  if (body.scheduling_group_id !== undefined) { sets.push("scheduling_group_id = ?"); binds.push(body.scheduling_group_id); }
  if (body.recurrence_rule !== undefined) { sets.push("recurrence_rule = ?"); binds.push(JSON.stringify(body.recurrence_rule)); }

  binds.push(templateId);
  await env.ARCADIA_DB.prepare(`UPDATE shift_templates SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await auditLog(session, "shift_template.update", "shift_template", templateId, body, env);
  return jsonResponse({ ok: true });
}

async function deleteShiftTemplate(
  templateId: string,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  await env.ARCADIA_DB.prepare(
    "UPDATE shift_templates SET active = 0, updated_at = ? WHERE id = ?",
  ).bind(now(), templateId).run();

  await auditLog(session, "shift_template.delete", "shift_template", templateId, null, env);
  return jsonResponse({ ok: true });
}

async function pushShiftTemplate(
  templateId: string,
  request: Request,
  session: WebappSession,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  // Check scope
  if (!session.scopes.toLowerCase().includes("schedule.readwrite.all")) {
    return errorResponse(
      "Schedule.ReadWrite.All scope required — please re-authenticate to grant shift write permissions",
      403,
    );
  }

  const template = await env.ARCADIA_DB.prepare(
    "SELECT * FROM shift_templates WHERE id = ? AND active = 1",
  ).bind(templateId).first<ShiftTemplateRow>();
  if (!template) return errorResponse("Template not found", 404);

  const body = await parseBody<{ fromDate: string; toDate: string }>(request);
  if (!body.fromDate || !body.toDate) {
    return errorResponse("fromDate and toDate are required (YYYY-MM-DD)", 400);
  }

  const fromDate = new Date(body.fromDate + "T00:00:00Z");
  const toDate = new Date(body.toDate + "T23:59:59Z");

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return errorResponse("Invalid date format — use YYYY-MM-DD", 400);
  }
  if (toDate.getTime() - fromDate.getTime() > 92 * 24 * 60 * 60 * 1000) {
    return errorResponse("Date range cannot exceed 92 days per push", 400);
  }

  const accessToken = await getSessionAccessToken(session, env);

  // Fire-and-forget: push runs in background, results written to shift_write_log
  ctx.waitUntil(
    pushShiftsToTeams(template, fromDate, toDate, accessToken)
      .then(async (results) => {
        const t = now();
        for (const r of results) {
          if (r.graphShiftId) {
            await env.ARCADIA_DB.prepare(`
              INSERT INTO shift_write_log
              (template_id, graph_shift_id, team_id, assignee_id, shift_start, shift_end, written_at, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'created')
            `)
              .bind(
                templateId, r.graphShiftId, template.team_id, r.assigneeId,
                Math.floor(r.startUtc.getTime() / 1000),
                Math.floor(r.endUtc.getTime() / 1000),
                t,
              )
              .run();
          } else {
            console.error(`[Admin] Shift push error for ${r.assigneeId}:`, r.error);
          }
        }
        const succeeded = results.filter((r) => r.graphShiftId).length;
        await auditLog(session, "shift.push", "shift_template", templateId, {
          fromDate: body.fromDate, toDate: body.toDate,
          total: results.length, succeeded,
        }, env);
      })
      .catch((err) => console.error("[Admin] Shift push failed:", err)),
  );

  return jsonResponse({
    ok: true,
    message: "Shift push queued. Poll /api/webapp/admin/shifts/push-status/" + templateId + " for progress.",
  });
}

async function getPushStatus(
  templateId: string,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const rows = await env.ARCADIA_DB.prepare(`
    SELECT swl.*, lu.display_name AS assignee_name
    FROM shift_write_log swl
    LEFT JOIN linked_users lu ON lu.aad_object_id = swl.assignee_id
    WHERE swl.template_id = ?
    ORDER BY swl.shift_start ASC
    LIMIT 200
  `).bind(templateId).all<ShiftWriteLogRow & { assignee_name: string | null }>();

  const summary = {
    total: rows.results.length,
    created: rows.results.filter((r) => r.status === "created").length,
    deleted: rows.results.filter((r) => r.status === "deleted").length,
    error: rows.results.filter((r) => r.status === "error").length,
  };

  return jsonResponse({ summary, log: rows.results });
}

async function deletePushedShift(
  logId: number,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  if (!session.scopes.toLowerCase().includes("schedule.readwrite.all")) {
    return errorResponse("Schedule.ReadWrite.All scope required — please re-authenticate", 403);
  }

  const row = await env.ARCADIA_DB.prepare(
    "SELECT * FROM shift_write_log WHERE id = ? AND status = 'created'",
  ).bind(logId).first<ShiftWriteLogRow>();
  if (!row) return errorResponse("Shift log entry not found or already deleted", 404);

  const accessToken = await getSessionAccessToken(session, env);
  try {
    await deleteShiftFromTeams(row.team_id, row.graph_shift_id, accessToken);
  } catch (err) {
    return errorResponse(`Failed to delete from Teams: ${err instanceof Error ? err.message : String(err)}`, 502);
  }

  await env.ARCADIA_DB.prepare(
    "UPDATE shift_write_log SET status = 'deleted' WHERE id = ?",
  ).bind(logId).run();

  await auditLog(session, "shift.delete", "shift", row.graph_shift_id, {
    logId, teamId: row.team_id, assigneeId: row.assignee_id,
  }, env);

  return jsonResponse({ ok: true });
}

// ─── Staff Reports ────────────────────────────────────────────────────────────

async function staffReport(url: URL, session: WebappSession, env: Env): Promise<Response> {
  const roleResult = await requireRole(session, "manager", env);
  if (!roleResult.ok) return roleResult.response;

  const type = url.searchParams.get("type") ?? "shifts_summary";
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const teamId = url.searchParams.get("teamId");

  if (type === "shifts_summary") {
    return shiftsReport(startDate, endDate, teamId, session, env);
  }
  if (type === "time_off_calendar") {
    return timeOffReport(startDate, endDate, session, env);
  }
  if (type === "activity_summary") {
    return activityReport(env);
  }

  return errorResponse("type must be shifts_summary, time_off_calendar, or activity_summary", 400);
}

async function shiftsReport(
  startDate: string | null,
  endDate: string | null,
  teamId: string | null,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  const fromTs = startDate ? Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000) : Math.floor(Date.now() / 1000);
  const toTs = endDate ? Math.floor(new Date(endDate + "T23:59:59Z").getTime() / 1000) : fromTs + 30 * 24 * 60 * 60;

  let query = `
    SELECT
      swl.assignee_id,
      lu.display_name AS assignee_name,
      lu.email AS assignee_email,
      COUNT(*) AS total_shifts,
      SUM(swl.shift_end - swl.shift_start) AS total_seconds,
      MIN(swl.shift_start) AS earliest_shift,
      MAX(swl.shift_end) AS latest_shift,
      st.name AS template_name,
      st.team_id
    FROM shift_write_log swl
    LEFT JOIN linked_users lu ON lu.aad_object_id = swl.assignee_id
    LEFT JOIN shift_templates st ON st.id = swl.template_id
    WHERE swl.status = 'created'
      AND swl.shift_start >= ?
      AND swl.shift_end <= ?
  `;
  const binds: unknown[] = [fromTs, toTs];

  if (teamId) {
    query += " AND swl.team_id = ?";
    binds.push(teamId);
  }

  query += " GROUP BY swl.assignee_id ORDER BY assignee_name ASC";

  const rows = await env.ARCADIA_DB.prepare(query).bind(...binds).all<{
    assignee_id: string;
    assignee_name: string | null;
    assignee_email: string | null;
    total_shifts: number;
    total_seconds: number;
    earliest_shift: number;
    latest_shift: number;
    template_name: string | null;
    team_id: string;
  }>();

  const users = rows.results.map((r) => ({
    userId: r.assignee_id,
    displayName: r.assignee_name ?? r.assignee_id,
    email: r.assignee_email,
    totalShifts: r.total_shifts,
    totalHours: Math.round((r.total_seconds / 3600) * 10) / 10,
    templateName: r.template_name,
    earliestShift: r.earliest_shift ? new Date(r.earliest_shift * 1000).toISOString() : null,
    latestShift: r.latest_shift ? new Date(r.latest_shift * 1000).toISOString() : null,
  }));

  return jsonResponse({
    type: "shifts_summary",
    fromDate: startDate,
    toDate: endDate,
    users,
    totalShifts: users.reduce((s, u) => s + u.totalShifts, 0),
    totalHours: Math.round(users.reduce((s, u) => s + u.totalHours, 0) * 10) / 10,
  });
}

async function timeOffReport(
  startDate: string | null,
  endDate: string | null,
  session: WebappSession,
  env: Env,
): Promise<Response> {
  // Fetch from Teams Graph (requires delegated token)
  const accessToken = await getSessionAccessToken(session, env);
  const teams = await getUserTeams(accessToken);

  const now_d = startDate ?? new Date().toISOString().slice(0, 10);
  const end_d = endDate ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const allTimeOff: Array<{
    teamId: string;
    userId: string;
    startDateTime: string;
    endDateTime: string;
  }> = [];

  await Promise.allSettled(
    teams.slice(0, 8).map(async (team) => {
      try {
        const res = await import("../context/shifts.js").then((m) =>
          m.getTimesOff(accessToken, [team.id])
        );
        for (const t of res) {
          if (t.startDateTime.slice(0, 10) <= end_d && t.endDateTime.slice(0, 10) >= now_d) {
            allTimeOff.push({
              teamId: t.teamId,
              userId: t.userId,
              startDateTime: t.startDateTime,
              endDateTime: t.endDateTime,
            });
          }
        }
      } catch {
        // Team may not have scheduling
      }
    }),
  );

  // Enrich with display names from linked_users
  const userRows = await env.ARCADIA_DB.prepare(
    "SELECT aad_object_id, display_name, email FROM linked_users",
  ).all<{ aad_object_id: string; display_name: string; email: string | null }>();
  const nameMap = new Map(userRows.results.map((r) => [r.aad_object_id, r.display_name]));

  return jsonResponse({
    type: "time_off_calendar",
    fromDate: now_d,
    toDate: end_d,
    entries: allTimeOff.map((t) => ({
      ...t,
      displayName: nameMap.get(t.userId) ?? t.userId,
    })),
  });
}

async function activityReport(env: Env): Promise<Response> {
  const rows = await env.ARCADIA_DB.prepare(`
    SELECT
      ui.user_id,
      ui.display_name,
      ui.timezone,
      ui.total_interactions,
      ui.positive_rate,
      ui.expertise_areas
    FROM user_intelligence ui
    ORDER BY ui.total_interactions DESC
    LIMIT 100
  `).all<{
    user_id: string;
    display_name: string;
    timezone: string | null;
    total_interactions: number;
    positive_rate: number;
    expertise_areas: string | null;
  }>();

  return jsonResponse({
    type: "activity_summary",
    users: rows.results.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      timezone: r.timezone,
      totalInteractions: r.total_interactions,
      positiveRate: Math.round(r.positive_rate * 100) / 100,
      expertiseAreas: r.expertise_areas ? JSON.parse(r.expertise_areas) : [],
    })),
  });
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

async function getAuditLog(url: URL, session: WebappSession, env: Env): Promise<Response> {
  const roleResult = await requireRole(session, "admin", env);
  if (!roleResult.ok) return roleResult.response;

  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const offset = Number(url.searchParams.get("offset") ?? "0");

  const rows = await env.ARCADIA_DB.prepare(
    "SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
  ).bind(limit, offset).all();

  const totalRow = await env.ARCADIA_DB.prepare(
    "SELECT COUNT(*) AS cnt FROM admin_audit_log",
  ).first<{ cnt: number }>();

  return jsonResponse({
    entries: rows.results,
    total: totalRow?.cnt ?? 0,
    limit,
    offset,
  });
}
