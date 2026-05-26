// /api/webapp/clients — user-facing Client routes.
//
//   GET    /api/webapp/clients            list Clients the viewer can see
//   GET    /api/webapp/clients/active     current active Client + scope
//   PUT    /api/webapp/clients/active     body { clientId: string | null }
//                                         entitlement enforced
//   GET    /api/webapp/clients/:id        detail (client + assets)
//   GET    /api/webapp/clients/:id/status Copilot-style cross-asset status
//
// Admin write paths live in ./admin-clients-api.ts under
// /api/webapp/admin/clients/*.

import type { Env } from "../env";
import {
  ActiveClient,
  ClientAssetStore,
  ClientMembership,
  ClientScopeResolver,
  ClientStore,
} from "../clients";
import { synthesizeClientStatus } from "../intelligence/client-status";
import { logger } from "../lib/logger";
import type { Session } from "./auth";

export async function handleClients(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/clients                  -> [api, webapp, clients]
  // /api/webapp/clients/active           -> [api, webapp, clients, active]
  // /api/webapp/clients/:id              -> [api, webapp, clients, id]
  // /api/webapp/clients/:id/status       -> [..., id, status]
  const head = segments[3];
  const sub = segments[4];

  if (!head) {
    if (request.method === "GET") return listMine(env, session);
    return methodNotAllowed();
  }

  if (head === "active") {
    if (request.method === "GET") return getActive(env, session);
    if (request.method === "PUT") return setActive(request, env, session);
    return methodNotAllowed();
  }

  if (sub === "status" && request.method === "GET") {
    return getStatus(env, session, head);
  }
  if (sub) return Response.json({ error: "not_found" }, { status: 404 });

  if (request.method === "GET") return getOne(env, session, head);
  return methodNotAllowed();
}

async function listMine(env: Env, session: Session): Promise<Response> {
  const membership = new ClientMembership(env);
  const clients = await membership.listForViewer({
    viewerAadId: session.aadId,
    tenantId: session.tenantId,
  });
  return Response.json({ clients });
}

async function getActive(env: Env, session: Session): Promise<Response> {
  const active = new ActiveClient(env);
  const clientId = await active.get(session.aadId);
  if (!clientId) return Response.json({ client: null, scope: null });

  const membership = new ClientMembership(env);
  const allowed = await membership.canAccess(clientId, {
    viewerAadId: session.aadId,
    tenantId: session.tenantId,
  });
  if (!allowed) {
    // Entitlement was revoked since the user last switched. Clear it
    // and report empty so the UI prompts a re-pick.
    await active.clear(session.aadId);
    return Response.json({ client: null, scope: null });
  }

  const store = new ClientStore(env);
  const client = await store.byId(clientId);
  if (!client) {
    await active.clear(session.aadId);
    return Response.json({ client: null, scope: null });
  }
  const resolver = new ClientScopeResolver(env);
  const scope = await resolver.resolve(clientId);
  return Response.json({ client, scope });
}

async function setActive(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  let body: { clientId?: string | null };
  try {
    body = (await request.json()) as { clientId?: string | null };
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const clientId = body.clientId ?? null;

  const active = new ActiveClient(env);
  try {
    await active.set(
      session.aadId,
      clientId,
      { viewerAadId: session.aadId, tenantId: session.tenantId },
    );
  } catch (e) {
    if (String(e).includes("forbidden")) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return Response.json({ error: String(e) }, { status: 500 });
  }

  if (clientId === null) {
    return Response.json({ client: null, scope: null });
  }
  const store = new ClientStore(env);
  const client = await store.byId(clientId);
  if (!client) return Response.json({ error: "not_found" }, { status: 404 });
  const resolver = new ClientScopeResolver(env);
  const scope = await resolver.resolve(clientId);
  return Response.json({ client, scope });
}

async function getOne(
  env: Env,
  session: Session,
  clientId: string,
): Promise<Response> {
  const membership = new ClientMembership(env);
  const allowed = await membership.canAccess(clientId, {
    viewerAadId: session.aadId,
    tenantId: session.tenantId,
  });
  if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });

  const store = new ClientStore(env);
  const client = await store.byId(clientId);
  if (!client) return Response.json({ error: "not_found" }, { status: 404 });

  const assetStore = new ClientAssetStore(env);
  const assets = await assetStore.listForClient(clientId);
  return Response.json({ client, assets });
}

async function getStatus(
  env: Env,
  session: Session,
  clientId: string,
): Promise<Response> {
  const membership = new ClientMembership(env);
  const allowed = await membership.canAccess(clientId, {
    viewerAadId: session.aadId,
    tenantId: session.tenantId,
  });
  if (!allowed) return Response.json({ error: "forbidden" }, { status: 403 });

  const log = logger({ env, base: { event_scope: "client_status" } });
  const status = await synthesizeClientStatus(env, clientId, log);
  if (!status) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ status });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
