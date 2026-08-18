// Arcadia worker entry (v4). Routes: /health and /auth/* (public), "/" and
// /chat* (the chat with Arcadia, SSO-verified), /approval* (operations and
// admin, SSO-verified), /agents/* (SDK routing, SSO-verified). The scheduled
// handler is only a bootstrap that wakes the agents so their SDK-persisted
// schedules exist; real scheduling lives inside the agents (§2).

import { getAgentByName, routeAgentRequest } from "agents";
import { handleChatRoutes } from "./approval/chat";
import { handleApprovalRoutes } from "./approval/dashboard";
import { handleLeadershipRoutes } from "./approval/leadership";
import { handleSectionRoutes } from "./approval/sections";
import { resolveUser } from "./lib/rbac";
import { beginLogin, completeLogin, logout, readIdentity, redirectToLogin, SsoError } from "./lib/sso";
import { handleVectorizeBatch, type VectorizeJob } from "./memory/self-hosted";

export { Arcadia } from "./agents/arcadia";
export { Radar } from "./agents/radar";
export { Ledger } from "./agents/ledger";
export { Dispatcher } from "./agents/dispatcher";
export { MemoryProfile } from "./memory/self-hosted";
export { RatifyWorkflow } from "./workflows/ratify";
export { SitePlanWorkflow } from "./workflows/siteplan";
export { SeedWorkflow } from "./workflows/seed";
// Named entrypoint a Cloudflare OS deployment binds as a service — not
// reachable over HTTP; see src/os-bridge/index.ts for the adapter contract.
export { ArcadiaOsGatekeeper } from "./os-bridge";

async function wakeAgents(env: Env): Promise<void> {
  // Each agent registers its own SDK schedules in onStart; a DO that has
  // never been woken has no alarm, so this keeps them alive across deploys.
  for (const stub of [
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
      return Response.json({ ok: true, service: "arcadia" });
    }

    // The SSO round trip itself must stay reachable without a session.
    if (url.pathname.startsWith("/auth/")) {
      try {
        if (url.pathname === "/auth/login") return await beginLogin(env, request);
        if (url.pathname === "/auth/callback") return await completeLogin(env, request);
        if (url.pathname === "/auth/logout") return logout(env, request);
      } catch (err) {
        console.error("sso", err);
        if (!(err instanceof SsoError)) {
          return new Response("Sign-in failed: sign_in_failed", { status: 403 });
        }
        // A deployment missing its own configuration names the unset
        // variables: they are variable names, not values, and without them
        // the operator cannot tell an unconfigured Worker from a rejected
        // sign-in. Every other reason stays bare — those details come from
        // the IdP or from the caller's own request.
        const shown = err.reason === "sso_not_configured" ? err.message : err.reason;
        return new Response(`Sign-in failed: ${shown}`, { status: 403 });
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
      return Response.json({ ok: true, woke: ["Arcadia", "Radar", "Dispatcher"] });
    }

    // The bare domain is the chat with Arcadia. Operations and admin are their
    // own pages under /approval — someone with a doctrine question should not
    // land on the approval queue, and a superadmin should not land on model
    // routing.
    const chatResponse = await handleChatRoutes(request, env, user);
    if (chatResponse) return chatResponse;

    // Leadership is live: the org chart and the directives it steers.
    const leadershipResponse = await handleLeadershipRoutes(request, env, user);
    if (leadershipResponse) return leadershipResponse;

    // The rest of Agency and Clients: nav placeholders, read-only until each
    // is wired to its source (src/approval/sections.tsx).
    const sectionResponse = handleSectionRoutes(request, user);
    if (sectionResponse) return sectionResponse;

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
