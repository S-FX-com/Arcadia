// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — M365 Sync API (Phase 10)
//
// POST /api/webapp/sync   — trigger a fresh pull of the user's M365 data
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types.js";
import type { WebappSession } from "../types.js";
import { jsonResponse, errorResponse } from "../middleware.js";
import { getSessionAccessToken } from "../auth.js";
import { fetchUserFullContext } from "../context/teams.js";

const SYNC_KV_TTL = 86400; // 24 hours

export async function handleSyncAPI(
  request: Request,
  _url: URL,
  session: WebappSession,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;

  const accessToken = await getSessionAccessToken(session, env);

  let sourcesRefreshed = 0;
  try {
    const messages = await fetchUserFullContext(accessToken);
    sourcesRefreshed = messages.length;
  } catch (err) {
    console.error("[Arcadia Sync] fetchUserFullContext failed:", err);
    return errorResponse('M365 sync failed — please try again', 502);
  }

  const lastSync = new Date().toISOString();
  const syncKey = `sync:${session.userId}:last`;
  await env.ARCADIA_CACHE.put(syncKey, lastSync, { expirationTtl: SYNC_KV_TTL });

  return jsonResponse({ status: 'ok', sourcesRefreshed, lastSync });
}
