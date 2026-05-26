// /api/webapp/admin/clients — admin-only Client write paths.
//
//   GET    /api/webapp/admin/clients
//   POST   /api/webapp/admin/clients
//   GET    /api/webapp/admin/clients/:id
//   PATCH  /api/webapp/admin/clients/:id
//   DELETE /api/webapp/admin/clients/:id        archives (soft delete)
//
//   GET    /api/webapp/admin/clients/:id/assets
//   POST   /api/webapp/admin/clients/:id/assets
//   DELETE /api/webapp/admin/clients/:id/assets/:assetKind/:assetId
//
//   GET    /api/webapp/admin/clients/:id/grants
//   POST   /api/webapp/admin/clients/:id/grants
//   DELETE /api/webapp/admin/clients/:id/grants/:principalType/:principalId
//
// Every route here requires session.isAdmin === true (set by
// routes.ts after consulting users.is_admin / ADMIN_USER_AAD_ID).

import type { Env } from "../env";
import {
  ClientAssetStore,
  ClientMembership,
  ClientStore,
  isAssetKind,
} from "../clients";
import type { AssetKind, ClientStatus } from "../clients";
import type { Session } from "./auth";

export async function handleAdminClients(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  if (!session.isAdmin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/admin/clients                      -> [api, webapp, admin, clients]
  // /api/webapp/admin/clients/:id                  -> [..., id]
  // /api/webapp/admin/clients/:id/assets           -> [..., id, assets]
  // /api/webapp/admin/clients/:id/assets/:k/:i     -> [..., id, assets, k, i]
  // /api/webapp/admin/clients/:id/grants/...       -> [..., id, grants, ...]
  const id = segments[4];
  const sub = segments[5];

  if (!id) {
    if (request.method === "GET") return listAll(env);
    if (request.method === "POST") return createClient(request, env, session);
    return methodNotAllowed();
  }

  if (!sub) {
    if (request.method === "GET") return getClient(env, id);
    if (request.method === "PATCH") return patchClient(request, env, id);
    if (request.method === "DELETE") return archiveClient(env, id);
    return methodNotAllowed();
  }

  if (sub === "assets") {
    return handleAssets(request, env, session, id, segments.slice(6));
  }
  if (sub === "grants") {
    return handleGrants(request, env, id, segments.slice(6));
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Client CRUD
// ---------------------------------------------------------------------------

async function listAll(env: Env): Promise<Response> {
  const store = new ClientStore(env);
  const clients = await store.list();
  return Response.json({ clients });
}

async function getClient(env: Env, id: string): Promise<Response> {
  const store = new ClientStore(env);
  const client = await store.byId(id);
  if (!client) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ client });
}

async function createClient(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  let body: {
    displayName?: unknown;
    slug?: unknown;
    description?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const displayName =
    typeof body.displayName === "string" ? body.displayName.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  if (!displayName || !slug) {
    return Response.json(
      { error: "missing_displayName_or_slug" },
      { status: 400 },
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return Response.json({ error: "bad_slug" }, { status: 400 });
  }

  const store = new ClientStore(env);
  if (await store.bySlug(slug)) {
    return Response.json({ error: "slug_taken" }, { status: 409 });
  }
  try {
    const client = await store.create({
      displayName,
      slug,
      createdBy: session.aadId,
      ...(typeof body.description === "string"
        ? { description: body.description }
        : {}),
    });
    return Response.json({ client }, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

async function patchClient(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  let body: {
    displayName?: unknown;
    description?: unknown;
    status?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const patch: {
    displayName?: string;
    description?: string | null;
    status?: ClientStatus;
  } = {};
  if (typeof body.displayName === "string") {
    patch.displayName = body.displayName.trim();
  }
  if (body.description === null || typeof body.description === "string") {
    patch.description = body.description as string | null;
  }
  if (body.status === "active" || body.status === "archived") {
    patch.status = body.status;
  }

  const store = new ClientStore(env);
  const updated = await store.update(id, patch);
  if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ client: updated });
}

async function archiveClient(env: Env, id: string): Promise<Response> {
  const store = new ClientStore(env);
  const existing = await store.byId(id);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
  await store.archive(id);
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Asset CRUD
// ---------------------------------------------------------------------------

async function handleAssets(
  request: Request,
  env: Env,
  session: Session,
  clientId: string,
  rest: string[],
): Promise<Response> {
  const store = new ClientStore(env);
  if (!(await store.byId(clientId))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const assets = new ClientAssetStore(env);

  if (rest.length === 0) {
    if (request.method === "GET") {
      const list = await assets.listForClient(clientId);
      return Response.json({ assets: list });
    }
    if (request.method === "POST") {
      return addAsset(request, assets, clientId, session);
    }
    return methodNotAllowed();
  }

  if (rest.length === 2 && request.method === "DELETE") {
    const [kindRaw, assetId] = rest;
    if (!kindRaw || !assetId) {
      return Response.json({ error: "bad_path" }, { status: 400 });
    }
    if (!isAssetKind(kindRaw)) {
      return Response.json({ error: "bad_asset_kind" }, { status: 400 });
    }
    const removed = await assets.remove(clientId, kindRaw, assetId);
    if (!removed) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function addAsset(
  request: Request,
  assets: ClientAssetStore,
  clientId: string,
  session: Session,
): Promise<Response> {
  let body: {
    assetKind?: unknown;
    assetId?: unknown;
    label?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const kind = typeof body.assetKind === "string" ? body.assetKind : "";
  const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
  if (!isAssetKind(kind)) {
    return Response.json({ error: "bad_asset_kind" }, { status: 400 });
  }
  if (!assetId) {
    return Response.json({ error: "missing_assetId" }, { status: 400 });
  }
  const asset = await assets.add(clientId, {
    assetKind: kind as AssetKind,
    assetId,
    addedBy: session.aadId,
    ...(typeof body.label === "string" ? { label: body.label } : {}),
  });
  return Response.json({ asset }, { status: 201 });
}

// ---------------------------------------------------------------------------
// Grants CRUD
// ---------------------------------------------------------------------------

async function handleGrants(
  request: Request,
  env: Env,
  clientId: string,
  rest: string[],
): Promise<Response> {
  const store = new ClientStore(env);
  if (!(await store.byId(clientId))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const membership = new ClientMembership(env);

  if (rest.length === 0) {
    if (request.method === "GET") {
      const grants = await membership.grantsFor(clientId);
      return Response.json({ grants });
    }
    if (request.method === "POST") {
      return addGrant(request, membership, clientId);
    }
    return methodNotAllowed();
  }

  if (rest.length === 2 && request.method === "DELETE") {
    const [type, principalId] = rest;
    if (!principalId) {
      return Response.json({ error: "bad_path" }, { status: 400 });
    }
    if (type === "user") {
      await membership.revokeUser(clientId, principalId);
    } else if (type === "group") {
      await membership.revokeGroup(clientId, principalId);
    } else {
      return Response.json({ error: "bad_principal_type" }, { status: 400 });
    }
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function addGrant(
  request: Request,
  membership: ClientMembership,
  clientId: string,
): Promise<Response> {
  let body: { principalType?: unknown; principalId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const type = body.principalType;
  const principalId =
    typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (!principalId) {
    return Response.json({ error: "missing_principalId" }, { status: 400 });
  }
  if (type === "user") {
    await membership.grantUser(clientId, principalId);
  } else if (type === "group") {
    await membership.grantGroup(clientId, principalId);
  } else {
    return Response.json({ error: "bad_principal_type" }, { status: 400 });
  }
  return new Response(null, { status: 201 });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
