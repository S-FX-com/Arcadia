// Delegated Microsoft Graph — the signed-in Specialist's own mailbox, chats,
// calendar, and Planner. App-only Graph (src/integrations/graph.ts) stays
// the Radar path and must not import this file.
//
// Tokens live in CONTROL KV, never in the session cookie. Nothing outside
// src/gatekeepers/user-graph.ts may import this client.

import { GraphError } from "./graph";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

export const GRAPH_USER_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Chat.Read",
  "ChannelMessage.Read.All",
  "Tasks.Read",
  "Calendars.Read",
].join(" ");

export interface UserGraphTokens {
  access_token: string;
  refresh_token: string;
  exp: number;
  scope: string;
}

export function userGraphTokenKey(aadId: string): string {
  return `graph:user:${aadId}`;
}

export async function readUserGraphTokens(env: Env, aadId: string): Promise<UserGraphTokens | null> {
  const raw = await env.CONTROL.get(userGraphTokenKey(aadId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserGraphTokens;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeUserGraphTokens(env: Env, aadId: string, tokens: UserGraphTokens): Promise<void> {
  await env.CONTROL.put(userGraphTokenKey(aadId), JSON.stringify(tokens));
}

export async function clearUserGraphTokens(env: Env, aadId: string): Promise<void> {
  await env.CONTROL.delete(userGraphTokenKey(aadId));
}

export function userGraphConnected(tokens: UserGraphTokens | null): boolean {
  return Boolean(tokens?.refresh_token);
}

async function refreshUserToken(env: Env, aadId: string, tokens: UserGraphTokens): Promise<UserGraphTokens> {
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_CLIENT_SECRET) {
    throw new GraphError("Graph credentials are not configured (CLAUDE.md §9.7)", 401);
  }
  const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GRAPH_CLIENT_ID,
      client_secret: env.GRAPH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      scope: GRAPH_USER_SCOPES,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new GraphError(`user token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new GraphError("user token refresh returned no access_token", 401);
  }
  const next: UserGraphTokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || tokens.refresh_token,
    exp: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    scope: body.scope ?? tokens.scope,
  };
  await writeUserGraphTokens(env, aadId, next);
  return next;
}

export async function userGraphAccessToken(env: Env, aadId: string): Promise<string> {
  const stored = await readUserGraphTokens(env, aadId);
  if (!stored) {
    throw new GraphError("Specialist has not connected delegated Graph", 401);
  }
  const freshEnough = stored.exp - 120 > Math.floor(Date.now() / 1000);
  const tokens = freshEnough ? stored : await refreshUserToken(env, aadId, stored);
  return tokens.access_token;
}

export async function graphUserGet<T>(env: Env, aadId: string, path: string): Promise<T> {
  const token = await userGraphAccessToken(env, aadId);
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new GraphError(`GET ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}
