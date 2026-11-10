// Arcadia Worker entry. /health and /auth/{login,callback,logout} are public;
// everything else needs a signed-in, active staff member and is routed by
// src/routes.ts. The cron only wakes the Arcadia scheduler DO so its
// SDK-persisted schedules (the directory sync and the shift-pattern post)
// exist after a fresh deploy; the schedules themselves live in the agent.

import { getAgentByName } from "agents";
import { resolveUser } from "./lib/rbac";
import { beginLogin, completeLogin, logout, readIdentity, redirectToLogin, SsoError } from "./lib/sso";
import { handleVectorizeBatch, type VectorizeJob } from "./memory/self-hosted";
import { dispatch } from "./routes";

export { Arcadia } from "./agents/arcadia";
export { MemoryProfile } from "./memory/self-hosted";

async function wakeArcadia(env: Env): Promise<void> {
  // The agent registers its SDK schedules in onStart; a DO that has never
  // been woken has no alarm, so this keeps them alive across deploys.
  const stub = await getAgentByName(env.Arcadia, "main");
  await stub.ping();
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
      // Browsers get the login redirect; scripted clients get a 401 they can
      // act on rather than an HTML page they cannot parse.
      const wantsHtml = request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html");
      return wantsHtml
        ? redirectToLogin(request)
        : new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }

    // A session outlives a deactivation, so re-check rather than trusting the
    // cookie for the rest of its eight hours.
    const user = await resolveUser(env, identity);
    if (!user.active) {
      return new Response("Forbidden: account deactivated", { status: 403 });
    }

    return dispatch(request, env, user, identity);
  },

  // Daily bootstrap: the agent schedules its own work via the SDK, but a DO
  // that has never been woken has no alarm.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(wakeArcadia(env));
  },

  async queue(batch: MessageBatch<VectorizeJob>, env: Env): Promise<void> {
    await handleVectorizeBatch(batch, env);
  },
} satisfies ExportedHandler<Env, VectorizeJob>;
