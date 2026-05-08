// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 17: User Operating Charter API
//
// Endpoints:
//   GET  /api/webapp/charter         — current charter (or null) + profile insights
//   PUT  /api/webapp/charter         — replace content (validates byte cap)
//   POST /api/webapp/charter/review  — bump last_reviewed_at without editing
//
// The webapp Context tab is the EA-relationship surface: the user authors
// their charter on the left, and the right pane shows what Arcadia has
// inferred (ProfileInsights). When they conflict, the charter wins —
// enforced by label asymmetry in the system prompt, not by merging here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ProfileInsights } from "../../types.js";
import type { WebappSession } from "../types.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import {
  CHARTER_MAX_BYTES,
  CHARTER_REVIEW_INTERVAL_DAYS,
  markCharterReviewed,
  resolveUserCharter,
  upsertUserCharter,
} from "../../intelligence/charter.js";
import { resolveUserProfile } from "../../intelligence/profiles.js";

export async function handleCharterAPI(
  request: Request,
  url: URL,
  session: WebappSession,
  env: Env,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;

  // GET /api/webapp/charter — charter + inferred ProfileInsights side-by-side.
  if (path === "/api/webapp/charter" && method === "GET") {
    const [charter, profile] = await Promise.all([
      resolveUserCharter(session.userId, env),
      resolveUserProfile(session.userId, env),
    ]);
    const insights: ProfileInsights | null = profile?.insights ?? null;
    return jsonResponse({
      charter,
      insights,
      maxBytes: CHARTER_MAX_BYTES,
      reviewIntervalDays: CHARTER_REVIEW_INTERVAL_DAYS,
    });
  }

  // PUT /api/webapp/charter — upsert content.
  if (path === "/api/webapp/charter" && method === "PUT") {
    let body: { content?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return errorResponse("Invalid JSON", 400);
    }

    if (typeof body.content !== "string") {
      return errorResponse("content (string) is required", 400);
    }

    const result = await upsertUserCharter(session.userId, body.content, env);
    if (!result.ok) {
      return errorResponse(
        `content too large (${result.bytes} bytes; max ${CHARTER_MAX_BYTES})`,
        413,
      );
    }
    return jsonResponse({ charter: result.charter });
  }

  // POST /api/webapp/charter/review — confirm reviewed without edits.
  if (path === "/api/webapp/charter/review" && method === "POST") {
    const charter = await markCharterReviewed(session.userId, env);
    if (!charter) {
      return errorResponse("No charter to review yet", 404);
    }
    return jsonResponse({ charter });
  }

  return null;
}
