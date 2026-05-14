// Arcadia v2 — Cloudflare Worker entry point.
//
// Routes:
//   POST /api/messages           Microsoft 365 Agents SDK channel ingress
//   POST /api/webapp/*           Web app HTTP API (SvelteKit)
//   POST /api/graph/notify       Microsoft Graph change-notification webhook
//   *    /api/mcp[/...]          Arcadia-as-MCP-server
//   GET  /api/openapi.json       OpenAPI 3.1 spec for the public API
//   GET  /api/agent365/manifest  Agent 365 capability manifest
//   GET  /healthz                Liveness
//
// scheduled() routes crons; queue() drains the ingest pipeline.
//
// Handlers are lazy-imported so cold-start cost stays proportional to
// the route actually being served.

import type { Env } from "./env";
import { logger } from "./lib/logger";

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const log = logger({ env, requestId: crypto.randomUUID() });

  log.info("fetch", { method: request.method, path: url.pathname });

  if (url.pathname === "/healthz") {
    return new Response("ok", { status: 200 });
  }

  if (url.pathname === "/api/messages") {
    const { handleActivity } = await import("./runtime/activity-handler");
    return handleActivity(request, env, ctx, log);
  }

  if (url.pathname === "/api/graph/notify") {
    const { handleGraphNotification } = await import("./graph/subscriptions");
    return handleGraphNotification(request, env, ctx, log);
  }

  if (url.pathname.startsWith("/api/webapp/")) {
    const { handleWebapp } = await import("./webapp/routes");
    return handleWebapp(request, env, ctx, log);
  }

  if (url.pathname === "/api/mcp" || url.pathname.startsWith("/api/mcp/")) {
    const { handleMcp } = await import("./mcp/server");
    return handleMcp(request, env, ctx, log);
  }

  if (url.pathname === "/api/openapi.json") {
    const { openApiSpec } = await import("./openapi/spec");
    return Response.json(openApiSpec(env));
  }

  if (url.pathname === "/api/agent365/manifest") {
    const { agent365Manifest } = await import("./agent365/manifest");
    return Response.json(agent365Manifest(env));
  }

  return new Response("not found", { status: 404 });
}

async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const log = logger({
    env,
    requestId: `cron-${event.cron}`,
    extra: { cron: event.cron },
  });
  log.info("scheduled");
  const { dispatchCron } = await import("./runtime/cron-dispatcher");
  ctx.waitUntil(dispatchCron(event, env, log));
}

async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const log = logger({
    env,
    requestId: `queue-${batch.queue}`,
    extra: { queue: batch.queue, size: batch.messages.length },
  });
  log.info("queue_batch");
  const { handleIngestBatch } = await import("./ingest/queue-consumer");
  await handleIngestBatch(batch, env, ctx, log);
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<Env>;
