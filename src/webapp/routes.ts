// Web app HTTP API consumed by the SvelteKit frontend in web/.
//
// Planned routes:
//   GET  /api/webapp/health
//   GET  /api/webapp/me
//   POST /api/webapp/auth/exchange      NAA / OBO token exchange
//   POST /api/webapp/chat               non-streaming chat
//   POST /api/webapp/chat/stream        SSE stream
//   GET  /api/webapp/routines
//   POST /api/webapp/routines
//   POST /api/webapp/routines/:id/run
//   GET  /api/webapp/memory
//   GET  /api/webapp/sources
//   GET  /api/webapp/dashboard
//
// Real implementation lands in the Webapp commit.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";

export async function handleWebapp(
  request: Request,
  _env: Env,
  _ctx: ExecutionContext,
  log: Logger,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/webapp/health") {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }

  log.warn("webapp_route_unimplemented", { path: url.pathname });
  return new Response("not implemented", { status: 501 });
}
