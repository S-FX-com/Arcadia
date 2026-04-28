// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 11: Procedures & Feedback API
//
// REST endpoints:
//   GET  /api/webapp/procedures            — list procedures (filterable)
//   GET  /api/webapp/procedures/:id        — single procedure
//   GET  /api/webapp/procedures/:id/history — evolution history
//   POST /api/webapp/procedures/:id/promote — manually promote to active
//   POST /api/webapp/procedures/:id/retire  — manually retire
//   PUT  /api/webapp/procedures/:id/content — edit content
//
//   POST /api/webapp/feedback               — thumbs up/down signal
//
//   GET  /api/webapp/intelligence           — current user intelligence profile
//   POST /api/webapp/intelligence           — override fields manually
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, UserIntelligenceRow } from "../../types.js";
import type { WebappSession } from "../types.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import {
  getProcedure,
  listProcedures,
  updateProcedureStatus,
  updateProcedureContent,
  getProcedureEvolutionHistory,
  scoreInteraction,
  getUserIntelligence,
} from "../../intelligence/learning-loop.js";

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleProceduresAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // ─── Feedback ─────────────────────────────────────────────────────────────

  // POST /api/webapp/feedback
  if (path === "/api/webapp/feedback" && method === "POST") {
    let body: { conversationId?: string; messageId?: string; signal?: "positive" | "negative" };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    if (!body.conversationId || !body.messageId || !body.signal) {
      return errorResponse("conversationId, messageId and signal are required", 400);
    }
    if (body.signal !== "positive" && body.signal !== "negative") {
      return errorResponse('signal must be "positive" or "negative"', 400);
    }

    // Look up which procedures were used in this conversation recently
    const recent = await env.ARCADIA_DB.prepare(
      `SELECT procedures_used FROM interaction_scores
       WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(body.conversationId)
      .first<{ procedures_used: string }>();

    let proceduresUsed: string[] = [];
    if (recent?.procedures_used) {
      try { proceduresUsed = JSON.parse(recent.procedures_used) as string[]; } catch {}
    }

    await scoreInteraction(
      body.conversationId,
      body.messageId,
      session.userId,
      body.signal,
      "explicit",
      proceduresUsed,
      env,
      `Explicit ${body.signal} feedback from webapp`,
    );

    return jsonResponse({ ok: true });
  }

  // ─── User Intelligence ────────────────────────────────────────────────────

  // GET /api/webapp/intelligence
  if (path === "/api/webapp/intelligence" && method === "GET") {
    const intel = await getUserIntelligence(session.userId, env);
    return jsonResponse({ intelligence: intel });
  }

  // POST /api/webapp/intelligence  (manual override of specific fields)
  if (path === "/api/webapp/intelligence" && method === "POST") {
    let body: Partial<{
      preferredResponseLength: string;
      preferredFormat: string;
      communicationStyle: string;
      timezone: string;
    }>;
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const existing = await env.ARCADIA_DB.prepare(
      `SELECT * FROM user_intelligence WHERE user_id = ?`,
    )
      .bind(session.userId)
      .first<UserIntelligenceRow>();

    if (!existing) {
      // Create a baseline row
      await env.ARCADIA_DB.prepare(
        `INSERT INTO user_intelligence
           (user_id, display_name, preferred_response_length, preferred_format,
            communication_style, timezone, expertise_areas, recurring_clients,
            correction_patterns, total_interactions, positive_rate, last_updated, intelligence_version)
         VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 0, 0.5, ?, 1)`,
      )
        .bind(
          session.userId,
          session.displayName,
          body.preferredResponseLength ?? "medium",
          body.preferredFormat ?? "markdown",
          body.communicationStyle ?? null,
          body.timezone ?? "America/New_York",
          now,
        )
        .run();
    } else {
      const updates: string[] = ["last_updated = ?", "intelligence_version = intelligence_version + 1"];
      const params: unknown[] = [now];

      if (body.preferredResponseLength) {
        updates.push("preferred_response_length = ?");
        params.push(body.preferredResponseLength);
      }
      if (body.preferredFormat) {
        updates.push("preferred_format = ?");
        params.push(body.preferredFormat);
      }
      if (body.communicationStyle !== undefined) {
        updates.push("communication_style = ?");
        params.push(body.communicationStyle);
      }
      if (body.timezone) {
        updates.push("timezone = ?");
        params.push(body.timezone);
      }

      params.push(session.userId);
      await env.ARCADIA_DB.prepare(
        `UPDATE user_intelligence SET ${updates.join(", ")} WHERE user_id = ?`,
      )
        .bind(...params)
        .run();
    }

    const updated = await getUserIntelligence(session.userId, env);
    return jsonResponse({ intelligence: updated });
  }

  // ─── Procedures list ──────────────────────────────────────────────────────

  // GET /api/webapp/procedures
  if (path === "/api/webapp/procedures" && method === "GET") {
    const statusParam = url.searchParams.get("status");
    const procedures = await listProcedures(
      env,
      statusParam ? { status: statusParam, limit: 100 } : { limit: 100 },
    );
    return jsonResponse({ procedures });
  }

  // Single procedure routes
  const procMatch = path.match(/^\/api\/webapp\/procedures\/([^/]+)(\/.*)?$/);
  if (!procMatch) return null;

  const procId = procMatch[1]!;
  const subPath = procMatch[2] ?? "";

  // GET /api/webapp/procedures/:id
  if (subPath === "" && method === "GET") {
    const proc = await getProcedure(procId, env);
    if (!proc) return errorResponse("Procedure not found", 404);
    return jsonResponse({ procedure: proc });
  }

  // GET /api/webapp/procedures/:id/history
  if (subPath === "/history" && method === "GET") {
    const history = await getProcedureEvolutionHistory(procId, env);
    return jsonResponse({ history });
  }

  // POST /api/webapp/procedures/:id/promote
  if (subPath === "/promote" && method === "POST") {
    const proc = await getProcedure(procId, env);
    if (!proc) return errorResponse("Procedure not found", 404);
    await updateProcedureStatus(procId, "active", env);
    return jsonResponse({ ok: true });
  }

  // POST /api/webapp/procedures/:id/retire
  if (subPath === "/retire" && method === "POST") {
    const proc = await getProcedure(procId, env);
    if (!proc) return errorResponse("Procedure not found", 404);
    await updateProcedureStatus(procId, "retired", env);
    return jsonResponse({ ok: true });
  }

  // PUT /api/webapp/procedures/:id/content
  if (subPath === "/content" && method === "PUT") {
    let body: { content?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }
    if (!body.content?.trim()) return errorResponse("content is required", 400);

    const proc = await getProcedure(procId, env);
    if (!proc) return errorResponse("Procedure not found", 404);
    await updateProcedureContent(procId, body.content.trim(), env);
    const updated = await getProcedure(procId, env);
    return jsonResponse({ procedure: updated });
  }

  return null;
}
