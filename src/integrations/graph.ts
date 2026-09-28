// Microsoft Graph — read-only, application-scoped, minimum permissions (§8):
// Files.Read.All, Sites.Read.All, Tasks.ReadWrite.All, ChannelMessage.Read.All,
// Chat.Read.All, User.Read.All, Presence.Read.All, Calendars.Read.
//
// Phase 1a has ZERO Microsoft dependency by design and never imports this.
// Phase 1b's Planner / SharePoint / Teams signals call through here and
// degrade cleanly to "unavailable" until the app registration and Global
// Admin consent exist (§9.7) — Radar reports a missing credential as a
// missing credential, never as a stall.

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const TOKEN_CACHE_KEY = "graph:app_token";

export function graphAvailable(env: Env): boolean {
  return Boolean(env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET);
}

/**
 * One sentence naming the missing credential. Null when tenant id, client
 * id, and client secret are all set. Consent failures are a different
 * sentence, written by the sync that Microsoft refused.
 */
export function graphNotConnected(env: Env): string | null {
  const missing = [
    env.GRAPH_TENANT_ID ? null : "GRAPH_TENANT_ID",
    env.GRAPH_CLIENT_ID ? null : "GRAPH_CLIENT_ID",
    env.GRAPH_CLIENT_SECRET ? null : "GRAPH_CLIENT_SECRET",
  ].filter((name): name is string => Boolean(name));
  if (missing.length === 0) return null;
  const list =
    missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  const verb = missing.length === 1 ? "is" : "are";
  return `Microsoft 365 is not connected. ${list} ${verb} not set.`;
}

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "GraphError";
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Client-credentials token, cached in KV until shortly before it expires. */
async function appToken(env: Env): Promise<string> {
  if (!graphAvailable(env)) {
    throw new GraphError("Graph credentials are not configured (CLAUDE.md §9.7)", 401);
  }
  const cached = await env.CONTROL.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID as string,
    client_secret: env.GRAPH_CLIENT_SECRET as string,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new GraphError(`token request failed: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const token = (await res.json()) as TokenResponse;
  await env.CONTROL.put(TOKEN_CACHE_KEY, token.access_token, {
    expirationTtl: Math.max(60, Math.min(token.expires_in - 120, 3600)),
  });
  return token.access_token;
}

export async function graphGet<T>(env: Env, path: string): Promise<T> {
  const token = await appToken(env);
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new GraphError(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * Generic authenticated POST, for the one write Schedule needs (filing a
 * time-off request — non-binding, auto-approvable at the gatekeeper, §12.1).
 * Not a general-purpose escape hatch: callers still go through their
 * gatekeeper, which decides whether a write is even in scope.
 */
export async function graphPost<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await appToken(env);
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new GraphError(`POST ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  // A 202/204 with no body is valid for some Graph writes; callers that need
  // the created resource (Schedule does, for its id) get {} and treat a
  // missing id as "filed, id unconfirmed" rather than throwing.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Display-name cache: a board re-resolves the same dozen people on every view. */
const USER_NAME_TTL_SECONDS = 86_400;

/**
 * Display name for a directory user, cached in KV for a day. A 404 — someone
 * who has left the directory but still holds Planner assignments — is cached
 * too, as the empty string, so a departed assignee does not cost a Graph call
 * on every board render. Names are decoration on a board; any other failure
 * is the caller's to decide about, so it propagates.
 */
export async function graphUserDisplayName(env: Env, aadId: string): Promise<string | undefined> {
  const key = `graph:username:${aadId}`;
  const cached = await env.CONTROL.get(key);
  if (cached !== null) return cached || undefined;
  try {
    const user = await graphGet<{ displayName?: string }>(
      env,
      `/users/${encodeURIComponent(aadId)}?$select=displayName`
    );
    const name = (user.displayName ?? "").trim();
    await env.CONTROL.put(key, name, { expirationTtl: USER_NAME_TTL_SECONDS });
    return name || undefined;
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) {
      await env.CONTROL.put(key, "", { expirationTtl: USER_NAME_TTL_SECONDS });
      return undefined;
    }
    throw err;
  }
}

/**
 * DELETE for the schedule gatekeeper's named shift-delete action. Not a
 * file delete and not an HR write — those stay forbidden (§8). Callers
 * outside the gatekeeper do not import this.
 */
export async function graphDelete(env: Env, path: string): Promise<void> {
  const token = await appToken(env);
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new GraphError(`DELETE ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
}

/**
 * Arcadia may never modify or delete a file, send anything to a client, or
 * take an HR action (§8). Planner task state is one write. Schedule shift
 * create and delete are the other, and they go through the schedule
 * gatekeeper as named actions. There is no generic user-profile PATCH here.
 */
export async function graphPatchPlannerTask<T>(
  env: Env,
  taskId: string,
  etag: string,
  patch: Record<string, unknown>
): Promise<T> {
  const token = await appToken(env);
  const res = await fetch(`${GRAPH_ROOT}/planner/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "If-Match": etag,
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new GraphError(
      `PATCH /planner/tasks/${taskId} → ${res.status} ${(await res.text()).slice(0, 300)}`,
      res.status
    );
  }
  return (await res.json()) as T;
}
