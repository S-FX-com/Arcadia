// Arcadia worker entry (v4). Routes: /health and /auth/* (public), /approval*
// (dashboard, SSO-verified), /agents/* (SDK routing, SSO-verified). The
// scheduled handler is only a bootstrap that wakes the agents so their
// SDK-persisted schedules exist; real scheduling lives inside the agents (§2).

import { getAgentByName, routeAgentRequest } from "agents";
import { handleApprovalRoutes } from "./approval/dashboard";
import { resolveUser } from "./lib/rbac";
import { beginLogin, completeLogin, logout, readIdentity, redirectToLogin, SsoError } from "./lib/sso";
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
// Named entrypoint a Cloudflare OS deployment binds as a service — not
// reachable over HTTP; see src/os-bridge/index.ts for the adapter contract.
export { ArcadiaOsGatekeeper } from "./os-bridge";

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

    // The SSO round trip itself must stay reachable without a session.
    if (url.pathname.startsWith("/auth/")) {
      try {
        if (url.pathname === "/auth/login") return await beginLogin(env, request);
        if (url.pathname === "/auth/callback") return await completeLogin(env, request);
        if (url.pathname === "/auth/logout") return logout(env, request);
      } catch (err) {
        // Reasons are named so a misconfigured tenant is diagnosable, but the
        // detail never reaches the browser.
        const reason = err instanceof SsoError ? err.reason : "sign_in_failed";
        console.error("sso", err);
        return new Response(`Sign-in failed: ${reason}`, { status: 403 });
      }
      return new Response("Not found", { status: 404 });
    }

    // Everything else is staff-facing: require a session and attribute every
    // action to a named human.
    const identity = await readIdentity(env, request);
    if (!identity) {
      // Browsers get the login redirect; API and WebSocket clients get a 401
      // they can act on rather than an HTML page they cannot parse.
      const wantsHtml = request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html");
      return wantsHtml
        ? redirectToLogin(request)
        : new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }

    // A session outlives a deactivation, so re-check rather than trusting the
    // cookie for the rest of its eight hours (§12.2).
    const user = await resolveUser(env, identity);
    if (!user.active) {
      return new Response("Forbidden: account deactivated", { status: 403 });
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
