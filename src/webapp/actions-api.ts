// /api/webapp/actions — the admin control plane for autonomy (EXECUTION-PLAN
// §Phase 5, D5). This is the operator surface over the action framework's
// three controls: the capability ladder (action_policy), the global kill
// switch (KV flag), and the append-only audit trail (action_log).
//
//   GET    /api/webapp/actions/policy
//     List every configured (verb, scope) → level policy row.
//   PUT    /api/webapp/actions/policy   body {verb, scopeType, scopeId, level}
//     Upsert one policy row. Validates level ∈ ladder and scopeType ∈ set.
//   DELETE /api/webapp/actions/policy   body or query {verb, scopeType, scopeId}
//     Remove a policy row — reverts to the verb's fail-closed default.
//   GET    /api/webapp/actions/kill                 → { on: boolean }
//   PUT    /api/webapp/actions/kill     body {on}   → { on: boolean }
//     Read / flip the tenant-wide kill switch (disables all action).
//   GET    /api/webapp/actions/log?status=&verb=&limit=
//     Recent action_log rows, newest first, capped (default 100).
//
// Every route requires session.isAdmin === true (routes.ts consults
// users.is_admin / ADMIN_USER_AAD_ID). Configuring autonomy is an operator
// act: Arcadia never raises her own ladder — Shane does (SOUL.md + D5).

import type { Env } from "../env";
import {
  isKillSwitchOn,
  setKillSwitch,
  type Ladder,
} from "../actions/framework";
import {
  ActionPolicyStore,
  isLadder,
  isScopeType,
  type ActionScopeType,
} from "../actions/policy";
import type { Session } from "./auth";

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;

export async function handleActions(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  if (!session.isAdmin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/actions/<resource> -> [api, webapp, actions, resource]
  const resource = segments[3];

  if (resource === "policy") return handlePolicy(request, env, session);
  if (resource === "kill") return handleKill(request, env);
  if (resource === "log") return handleLog(request, env, url);

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function handlePolicy(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const store = new ActionPolicyStore(env);

  if (request.method === "GET") {
    const policies = await store.list();
    return Response.json({ policies });
  }

  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body) return badJson();

    const verb = str(body.verb);
    const scopeType = body.scopeType;
    const scopeId = str(body.scopeId);
    const level = body.level;

    if (!verb) return badRequest("missing_verb");
    if (!isScopeType(scopeType)) return badRequest("bad_scope_type");
    if (!scopeId) return badRequest("missing_scope_id");
    if (!isLadder(level)) return badRequest("bad_level");

    const policy = await store.set({
      verb,
      scopeType: scopeType as ActionScopeType,
      scopeId,
      level: level as Ladder,
      updatedBy: session.aadId,
    });
    return Response.json({ policy });
  }

  if (request.method === "DELETE") {
    // Accept target from body or query string.
    const body = (await readJson(request)) ?? {};
    const verb = str(body.verb) ?? str(qp(request, "verb"));
    const scopeTypeRaw = body.scopeType ?? qp(request, "scopeType");
    const scopeId = str(body.scopeId) ?? str(qp(request, "scopeId"));

    if (!verb) return badRequest("missing_verb");
    if (!isScopeType(scopeTypeRaw)) return badRequest("bad_scope_type");
    if (!scopeId) return badRequest("missing_scope_id");

    const removed = await store.remove(
      verb,
      scopeTypeRaw as ActionScopeType,
      scopeId,
    );
    return Response.json({ ok: true, removed });
  }

  return methodNotAllowed();
}

async function handleKill(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({ on: await isKillSwitchOn(env) });
  }
  if (request.method === "PUT") {
    const body = await readJson(request);
    if (!body || typeof body.on !== "boolean") return badRequest("bad_on");
    await setKillSwitch(env, body.on);
    return Response.json({ on: await isKillSwitchOn(env) });
  }
  return methodNotAllowed();
}

interface ActionLogRow {
  id: string;
  verb: string;
  actor_aad_id: string;
  on_behalf: string | null;
  scope_type: string;
  scope_id: string;
  level: string;
  status: string;
  created_at: string;
  executed_at: string | null;
}

async function handleLog(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();

  const status = str(url.searchParams.get("status") ?? undefined);
  const verb = str(url.searchParams.get("verb") ?? undefined);
  const limit = clampLimit(url.searchParams.get("limit"));

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    clauses.push("status = ?");
    binds.push(status);
  }
  if (verb) {
    clauses.push("verb = ?");
    binds.push(verb);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = await env.ARCADIA_DB.prepare(
    `SELECT id, verb, actor_aad_id, on_behalf, scope_type, scope_id,
            level, status, created_at, executed_at
       FROM action_log
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<ActionLogRow>();

  const log = rows.results.map((r) => ({
    id: r.id,
    verb: r.verb,
    actorAadId: r.actor_aad_id,
    onBehalf: r.on_behalf,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    level: r.level,
    status: r.status,
    createdAt: r.created_at,
    executedAt: r.executed_at,
  }));
  return Response.json({ log });
}

function clampLimit(raw: string | null): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.floor(n), MAX_LOG_LIMIT);
}

async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function qp(request: Request, key: string): string | undefined {
  return new URL(request.url).searchParams.get(key) ?? undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function badJson(): Response {
  return Response.json({ error: "bad_json" }, { status: 400 });
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
