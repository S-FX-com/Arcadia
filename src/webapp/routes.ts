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

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import {
  clearCookieHeader,
  exchangeAndSeal,
  readSession,
  type Session,
} from "./auth";
import { handleChat, handleChatStream } from "./chat-stream";
import { handleCharter } from "./charter-api";
import { handleDashboard } from "./dashboard-api";
import { handleMemory } from "./memory-api";
import { handleRoutines } from "./routines-api";

export async function handleWebapp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  log: Logger,
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

  if (path === "/api/webapp/auth/logout" && request.method === "POST") {
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": clearCookieHeader() },
    });
  }

  if (path === "/api/webapp/me") {
    return Response.json({ session });
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

  if (path.startsWith("/api/webapp/charter")) {
    return handleCharter(request, env, session);
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
    return Response.json(
      { error: "exchange_failed", detail: String(e) },
      { status: 401 },
    );
  }
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export type { Session };
