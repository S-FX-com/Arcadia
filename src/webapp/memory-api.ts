// /api/webapp/memory — read + correct.
//
//   GET  /api/webapp/memory?query=...&scopeType=...&scopeId=...&kind=...
//        Semantic recall with strict ACL for session.aadId.
//
//   GET  /api/webapp/memory/recent?scopeType=...&scopeId=...&kind=...&limit=...
//        Time-ordered recent memories within a scope.
//
//   POST /api/webapp/memory/:id/forget
//        Soft-delete (sets expires_at = now). Subject of the memory or
//        ADMIN_USER_AAD_ID only.

import type { Env } from "../env";
import { MemoryStore } from "../memory/store";
import type { Kind, Scope } from "../memory/types";
import type { Session } from "./auth";

const VALID_SCOPES: Scope[] = [
  "tenant",
  "channel",
  "chat",
  "user",
  "project",
  "customer",
];

const VALID_KINDS: Kind[] = [
  "episodic",
  "semantic",
  "procedural",
  "observation",
];

export async function handleMemory(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/memory                -> ['api','webapp','memory']
  // /api/webapp/memory/recent
  // /api/webapp/memory/:id/forget
  const head = segments[3];
  const action = segments[4];
  const store = new MemoryStore(env);

  if (!head && request.method === "GET") {
    return recall(url, env, session);
  }

  if (head === "recent" && request.method === "GET") {
    return recent(url, store);
  }

  if (head && action === "forget" && request.method === "POST") {
    return forget(head, store, session, env);
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function recall(
  url: URL,
  env: Env,
  session: Session,
): Promise<Response> {
  const query = url.searchParams.get("query") ?? "";
  if (!query) return Response.json({ error: "missing_query" }, { status: 400 });

  const limit = clampInt(url.searchParams.get("limit"), 5, 1, 50);
  const scopeType = parseScope(url.searchParams.get("scopeType"));
  const scopeId = url.searchParams.get("scopeId");
  const kind = parseKind(url.searchParams.get("kind"));

  const store = new MemoryStore(env);
  const hits = await store.recall(query, {
    limit,
    viewer: session.aadId,
    tenantId: session.tenantId,
    ...(scopeType ? { scopeType } : {}),
    ...(scopeId ? { scopeId } : {}),
    ...(kind ? { kind } : {}),
  });
  return Response.json({ hits });
}

async function recent(url: URL, store: MemoryStore): Promise<Response> {
  const scopeType = parseScope(url.searchParams.get("scopeType"));
  const scopeId = url.searchParams.get("scopeId");
  if (!scopeType || !scopeId) {
    return Response.json({ error: "missing_scope" }, { status: 400 });
  }
  const kind = parseKind(url.searchParams.get("kind"));
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 200);
  const memories = await store.recent(scopeType, scopeId, kind, limit);
  return Response.json({ memories });
}

async function forget(
  id: string,
  store: MemoryStore,
  session: Session,
  env: Env,
): Promise<Response> {
  const memory = await store.byId(id);
  if (!memory) return Response.json({ error: "not_found" }, { status: 404 });
  const isSubject =
    memory.subjectAadId !== undefined &&
    memory.subjectAadId === session.aadId;
  const isAdmin = session.aadId === env.ADMIN_USER_AAD_ID;
  if (!isSubject && !isAdmin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  await store.forget(id);
  return new Response(null, { status: 204 });
}

function parseScope(v: string | null): Scope | undefined {
  if (!v) return undefined;
  return VALID_SCOPES.includes(v as Scope) ? (v as Scope) : undefined;
}

function parseKind(v: string | null): Kind | undefined {
  if (!v) return undefined;
  return VALID_KINDS.includes(v as Kind) ? (v as Kind) : undefined;
}

function clampInt(
  v: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
