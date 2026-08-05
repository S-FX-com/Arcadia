// Arcadia worker entry (v4). Routes: /health (public), /approval* (dashboard,
// Access-verified), /agents/* (SDK routing, Access-verified). The scheduled
// handler is only a bootstrap that wakes the agents so their SDK-persisted
// schedules exist; real scheduling lives inside the agents (§2).

import { getAgentByName, routeAgentRequest } from "agents";
import { handleApprovalRoutes } from "./approval/dashboard";
import { AccessDeniedError, verifyAccess } from "./lib/access";
import { handleVectorizeBatch, type VectorizeJob } from "./memory/self-hosted";

export { Arcadia } from "./agents/arcadia";
export { Hermes } from "./agents/hermes";
export { Radar } from "./agents/radar";
export { Ledger } from "./agents/ledger";
export { Dispatcher } from "./agents/dispatcher";
export { MemoryProfile } from "./memory/self-hosted";
export { PublishWorkflow } from "./workflows/publish";
export { RatifyWorkflow } from "./workflows/ratify";
export { SitePlanWorkflow } from "./workflows/siteplan";

async function wakeAgents(env: Env): Promise<void> {
  // Each agent registers its own SDK schedules in onStart; a DO that has
  // never been woken has no alarm, so this keeps them alive across deploys.
  for (const stub of [
    await getAgentByName(env.Hermes, "main"),
    await getAgentByName(env.Arcadia, "main"),
    await getAgentByName(env.Radar, "main"),
    await getAgentByName(env.Dispatcher, "main"),
  ]) {
    await stub.ping();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "arcadia", phase: "1a" });
    }

    // Everything else is staff-facing: verify the Access JWT and attribute
    // every action to a named human.
    let identity;
    try {
      identity = await verifyAccess(request, env);
    } catch (err) {
      const message = err instanceof AccessDeniedError ? err.message : "access verification failed";
      return new Response(`Forbidden: ${message}`, { status: 403 });
    }

    if (url.pathname === "/init" && request.method === "POST") {
      await wakeAgents(env);
      return Response.json({ ok: true, woke: ["Hermes", "Arcadia", "Radar", "Dispatcher"] });
    }

    const approvalResponse = await handleApprovalRoutes(request, env, identity);
    if (approvalResponse) return approvalResponse;

    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },

  // Daily bootstrap: agents schedule their own work via the SDK, but a DO
  // that has never been woken has no alarm. This keeps them alive across
  // fresh deploys without a human having to hit /init.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(wakeAgents(env));
  },

  async queue(batch: MessageBatch<VectorizeJob>, env: Env): Promise<void> {
    await handleVectorizeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, VectorizeJob>;
