// /api/webapp/routines — CRUD + manual run.
//
//   GET    /api/webapp/routines            list routines owned by session.aadId
//   POST   /api/webapp/routines            create a routine from a definition body
//   GET    /api/webapp/routines/:id        fetch one (must be owner)
//   PATCH  /api/webapp/routines/:id        update definition or enabled flag
//   DELETE /api/webapp/routines/:id        remove
//   POST   /api/webapp/routines/:id/run    execute now (manual trigger)
//
// All routes verify session.aadId == routine.ownerAadId before
// mutating. The bot's admin (ADMIN_USER_AAD_ID) can read any routine
// but still can't masquerade-write.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { runRoutine } from "../routines/executor";
import { safeParseDefinition } from "../routines/definition";
import { RoutineStore } from "../routines/store";
import type { Session } from "./auth";

export async function handleRoutines(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/routines              -> ['api','webapp','routines']
  // /api/webapp/routines/<id>         -> ['api','webapp','routines', id]
  // /api/webapp/routines/<id>/run     -> [..., id, 'run']
  const id = segments[3];
  const action = segments[4];
  const store = new RoutineStore(env);

  if (!id) {
    if (request.method === "GET") {
      const routines = await store.listByOwner(session.aadId);
      return Response.json({ routines });
    }
    if (request.method === "POST") {
      return createRoutine(request, store, session, log);
    }
    return methodNotAllowed();
  }

  const existing = await store.byId(id);
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
  if (
    existing.ownerAadId !== session.aadId &&
    session.aadId !== env.ADMIN_USER_AAD_ID
  ) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (action === "run") {
    if (request.method !== "POST") return methodNotAllowed();
    if (existing.ownerAadId !== session.aadId) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const run = await runRoutine(env, existing, "manual", log, { ctx });
    return Response.json(run, { status: run.status === "succeeded" ? 200 : 500 });
  }

  if (action) return Response.json({ error: "not_found" }, { status: 404 });

  if (request.method === "GET") return Response.json({ routine: existing });

  if (existing.ownerAadId !== session.aadId) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (request.method === "PATCH") {
    return patchRoutine(request, store, id);
  }
  if (request.method === "DELETE") {
    await store.delete(id);
    return new Response(null, { status: 204 });
  }
  return methodNotAllowed();
}

async function createRoutine(
  request: Request,
  store: RoutineStore,
  session: Session,
  log: Logger,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const def = (body as { definition?: unknown })?.definition ?? body;
  const enabled =
    (body as { enabled?: boolean })?.enabled === undefined
      ? true
      : Boolean((body as { enabled?: boolean }).enabled);

  const parsed = safeParseDefinition(def);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  try {
    const created = await store.create(session.aadId, parsed.data, enabled);
    log.info("routine_created", {
      ownerAadId: session.aadId,
      routineId: created.id,
    });
    return Response.json({ routine: created }, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

async function patchRoutine(
  request: Request,
  store: RoutineStore,
  id: string,
): Promise<Response> {
  let body: { definition?: unknown; enabled?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  const patch: { def?: unknown; enabled?: boolean } = {};
  if (body.definition !== undefined) {
    const parsed = safeParseDefinition(body.definition);
    if (!parsed.ok)
      return Response.json({ error: parsed.error }, { status: 400 });
    patch.def = parsed.data;
  }
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  try {
    const updated = await store.update(id, patch);
    if (!updated) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ routine: updated });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
