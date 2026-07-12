// Worker entry — fetch + scheduled + queue.
//
// All HTTP traffic enters here. Routes branch by URL path:
//
//   /api/messages          → Bot Framework activity handler
//   /api/webapp/*          → Webapp HTTP API (session-gated, public sub-routes)
//   /api/mcp               → MCP JSON-RPC
//   /api/graph/notify      → Microsoft Graph change-notification webhook
//   /api/openapi.json      → OpenAPI 3.1 spec
//   /api/agent365/manifest → Tenant governance manifest
//   /api/healthz           → Liveness probe
//
// scheduled() routes by event.cron through src/runtime/cron-dispatcher.
// queue() consumes IngestMessages from the arcadia-ingest queue.

import type { Env } from "./env";
import { agent365Manifest } from "./agent365/manifest";
import { consumeBatch } from "./ingest/queue-consumer";
import type { IngestMessage } from "./ingest/types";
import { alert } from "./lib/alert";
import { logger } from "./lib/logger";
import { handleMcp } from "./mcp/server";
import { openApiSpec } from "./openapi/spec";
import { handleActivity } from "./runtime/activity-handler";
import { dispatchCron } from "./runtime/cron-dispatcher";
import { handleGraphNotification } from "./graph/subscriptions";
import { handleWebapp } from "./webapp/routes";

const handler: ExportedHandler<Env, IngestMessage> = {
  async fetch(request, env, ctx): Promise<Response> {
    const requestId = crypto.randomUUID();
    const log = logger({ env, requestId });
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/healthz") {
        return Response.json({ ok: true, ts: new Date().toISOString() });
      }
      if (path === "/api/messages") {
        return await handleActivity(request, env, ctx, log);
      }
      if (path.startsWith("/api/webapp/")) {
        return await handleWebapp(request, env, ctx, log);
      }
      if (path === "/api/mcp") {
        return await handleMcp(request, env, ctx, log);
      }
      if (path === "/api/graph/notify") {
        return await handleGraphNotification(request, env, ctx, log);
      }
      if (path === "/api/openapi.json") {
        return Response.json(openApiSpec(env));
      }
      if (path === "/api/agent365/manifest") {
        return Response.json(agent365Manifest(env));
      }

      log.warn("route_not_found", { path, method: request.method });
      return new Response("not found", { status: 404 });
    } catch (e) {
      log.error("unhandled", { path, error: String(e) });
      return new Response("internal", { status: 500 });
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const log = logger({ env, requestId: `cron:${controller.cron}` });
    try {
      await dispatchCron(
        { cron: controller.cron, scheduledTime: controller.scheduledTime },
        env,
        log,
        ctx,
      );
    } catch (e) {
      // Top-level cron failure: log + fire-and-forget alert. waitUntil lets
      // the webhook POST outlive the handler return.
      ctx.waitUntil(
        alert(env, "cron_unhandled", { cron: controller.cron, error: String(e) }, log),
      );
    }
  },

  async queue(batch, env, ctx): Promise<void> {
    const log = logger({ env, requestId: `queue:${batch.queue}` });
    try {
      await consumeBatch(batch, env, log);
    } catch (e) {
      ctx.waitUntil(
        alert(env, "queue_unhandled", { queue: batch.queue, error: String(e) }, log),
      );
    }
  },
};

export default handler;
