// Microsoft Graph token acquisition.
//
// Two flows:
//   appToken()        client_credentials — app-only, used by crons +
//                     webhook fan-out + subscription management
//   userToken(jwt)    on-behalf-of      — delegated, used by the webapp
//                     HTTP API to act as the signed-in user
//
// Tokens cache in KV. Cache key includes the scope set so multiple
// scope combinations don't collide.

import type { Env } from "../env";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const TOKEN_KV_PREFIX = "graph_token:";
const TOKEN_KV_SKEW_SECONDS = 300;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function fetchToken(
  env: Env,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const url = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`graph_auth_${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function appToken(
  env: Env,
  scope: string = GRAPH_DEFAULT_SCOPE,
): Promise<string> {
  const key = `${TOKEN_KV_PREFIX}app:${scope}`;
  const cached = await env.ARCADIA_CACHE.get(key);
  if (cached) return cached;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope,
  });
  const token = await fetchToken(env, body);

  await env.ARCADIA_CACHE.put(key, token.access_token, {
    expirationTtl: Math.max(60, token.expires_in - TOKEN_KV_SKEW_SECONDS),
  });
  return token.access_token;
}

export async function userToken(
  env: Env,
  assertion: string,
  scope: string = GRAPH_DEFAULT_SCOPE,
  userId?: string,
): Promise<string> {
  if (userId) {
    const key = `${TOKEN_KV_PREFIX}user:${userId}:${scope}`;
    const cached = await env.ARCADIA_CACHE.get(key);
    if (cached) return cached;
  }

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: env.WEBAPP_CLIENT_ID,
    client_secret: env.WEBAPP_CLIENT_SECRET,
    assertion,
    scope,
    requested_token_use: "on_behalf_of",
  });
  const token = await fetchToken(env, body);

  if (userId) {
    const key = `${TOKEN_KV_PREFIX}user:${userId}:${scope}`;
    await env.ARCADIA_CACHE.put(key, token.access_token, {
      expirationTtl: Math.max(60, token.expires_in - TOKEN_KV_SKEW_SECONDS),
    });
  }
  return token.access_token;
}
