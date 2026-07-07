// Webapp HTTP route table.
//
// All paths under /api/webapp/* land here from src/index.ts after the
// outer router has matched the prefix. We do session reading + auth
// here so per-route handlers can rely on a non-null Session.
//
//   GET    /api/webapp/health                 — liveness, no auth
//   POST   /api/webapp/auth/exchange          — exchange access token for cookie
//   POST   /api/webapp/auth/logout            — clear cookie
//   GET    /api/webapp/me                     — current session
//   POST   /api/webapp/chat                   — non-streaming chat
//   POST   /api/webapp/chat/stream            — SSE chat
//   *      /api/webapp/routines[/:id[/run]]   — see routines-api.ts
//   *      /api/webapp/memory[/...]           — see memory-api.ts
//   GET    /api/webapp/dashboard              — see dashboard-api.ts
//   GET    /api/webapp/org-pulse             — see org-pulse-api.ts (admin-only)
//   *      /api/webapp/sources[/:id]           — see sources-api.ts
//   POST   /api/webapp/search                  — see search-api.ts (delegated OBO)

import type { JWTVerifyGetKey } from "jose";
import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import {
  clearCookieHeader,
  exchangeAndSeal,
  readSession,
  type Session,
} from "./auth";
import { handleAdminClients } from "./admin-clients-api";
import { handleChat, handleChatStream } from "./chat-stream";
import { handleCharter } from "./charter-api";
import { handleClients } from "./clients-api";
import { handleDashboard } from "./dashboard-api";
import { handleMemory } from "./memory-api";
import { handleOrgPulse } from "./org-pulse-api";
import { handleRoutines } from "./routines-api";
import { handleSearch } from "./search-api";
import { handleSources } from "./sources-api";

export interface HandleWebappOptions {
  /** Test seam: local key resolver threaded into the delegated x-graph-token verification in search-api.ts. */
  keyResolver?: JWTVerifyGetKey;
}

export async function handleWebapp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
  opts: HandleWebappOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Public routes — no session required.
  if (path === "/api/webapp/health") {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }
  if (path === "/api/webapp/auth/exchange" && request.method === "POST") {
    return authExchange(request, env, log);
  }

  // Session-required routes.
  const session = await readSession(env, request);
  if (!session) return unauthorized();

  await enrichSession(env, session);

  if (path === "/api/webapp/auth/logout" && request.method === "POST") {
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": clearCookieHeader() },
    });
  }

  if (path === "/api/webapp/me") {
    return Response.json({ session });
  }

  if (path.startsWith("/api/webapp/admin/clients")) {
    return handleAdminClients(request, env, session);
  }

  if (path.startsWith("/api/webapp/clients")) {
    return handleClients(request, env, session);
  }

  if (path === "/api/webapp/chat" && request.method === "POST") {
    return handleChat(request, env, session, log);
  }

  if (path === "/api/webapp/chat/stream" && request.method === "POST") {
    return handleChatStream(request, env, session, log);
  }

  if (path.startsWith("/api/webapp/routines")) {
    return handleRoutines(request, env, session, log, ctx);
  }

  if (path.startsWith("/api/webapp/memory")) {
    return handleMemory(request, env, session);
  }

  if (path === "/api/webapp/dashboard" && request.method === "GET") {
    return handleDashboard(request, env, session);
  }

  if (path === "/api/webapp/org-pulse" && request.method === "GET") {
    return handleOrgPulse(request, env, session, log);
  }

  if (path.startsWith("/api/webapp/sources")) {
    return handleSources(request, env, session);
  }

  if (path.startsWith("/api/webapp/charter")) {
    return handleCharter(request, env, session);
  }

  if (path === "/api/webapp/search" && request.method === "POST") {
    return handleSearch(
      request,
      env,
      session,
      log,
      undefined,
      opts.keyResolver ? { keyResolver: opts.keyResolver } : {},
    );
  }

  log.warn("webapp_route_unknown", {
    path,
    method: request.method,
    aadId: session.aadId,
  });
  return Response.json({ error: "not_found" }, { status: 404 });
}

async function authExchange(
  request: Request,
  env: Env,
  log: Logger,
): Promise<Response> {
  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.token) {
    return Response.json({ error: "missing_token" }, { status: 400 });
  }
  try {
    const { session, cookie } = await exchangeAndSeal(env, body.token);
    log.info("webapp_session", { aadId: session.aadId });
    return Response.json(
      { session },
      { headers: { "set-cookie": cookie } },
    );
  } catch (e) {
    log.warn("webapp_auth_exchange_failed", { error: String(e) });
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Mutates `session` in-place to add activeClientId and isAdmin, read
 * fresh from D1 on every request. Cookies never carry these — that way
 * a switch or an admin-promotion takes effect on the next request
 * without a cookie reissue.
 */
async function enrichSession(env: Env, session: Session): Promise<void> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT active_client_id, is_admin FROM users WHERE aad_id = ?`,
  )
    .bind(session.aadId)
    .first<{ active_client_id: string | null; is_admin: number }>();

  if (row?.active_client_id) session.activeClientId = row.active_client_id;
  const isAdminRow = row?.is_admin === 1;
  const isAdminEnv =
    !!env.ADMIN_USER_AAD_ID && session.aadId === env.ADMIN_USER_AAD_ID;
  if (isAdminRow || isAdminEnv) session.isAdmin = true;
}

export type { Session };
