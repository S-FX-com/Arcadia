// /api/webapp/charter — operator-only CRUD.
//
//   GET    /api/webapp/charter           Return the active charter + recent history.
//   POST   /api/webapp/charter           Publish a new version. body: { body: string }
//   POST   /api/webapp/charter/:id/revert
//                                        Re-publish a prior version's body as a new
//                                        forward-moving version.
//
// All writes are gated to the operator (env.ADMIN_USER_AAD_ID). Reads
// are session-authenticated only — anyone with a session can see the
// charter (it's ground truth they're operating under).

import type { Env } from "../env";
import { CharterStore } from "../charter/store";
import type { Session } from "./auth";

export async function handleCharter(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[3];
  const action = segments[4];
  const store = new CharterStore(env);

  if (!id) {
    if (request.method === "GET") {
      const active = await store.active();
      const history = await store.history(25);
      return Response.json({ active, history });
    }
    if (request.method === "POST") {
      if (!isAdmin(env, session)) return forbidden();
      let body: { body?: unknown };
      try {
        body = (await request.json()) as { body?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.body !== "string" || body.body.trim().length === 0) {
        return Response.json({ error: "missing_body" }, { status: 400 });
      }
      const created = await store.publish(body.body);
      return Response.json({ charter: created }, { status: 201 });
    }
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  if (action === "revert") {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (!isAdmin(env, session)) return forbidden();
    const rolled = await store.revertTo(id);
    if (!rolled) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ charter: rolled });
  }

  if (request.method === "GET") {
    const charter = await store.byId(id);
    if (!charter) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ charter });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

function isAdmin(env: Env, session: Session): boolean {
  return (
    !!env.ADMIN_USER_AAD_ID && session.aadId === env.ADMIN_USER_AAD_ID
  );
}

function forbidden(): Response {
  return Response.json({ error: "forbidden_admin_only" }, { status: 403 });
}
