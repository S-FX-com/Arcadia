// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Microsoft Graph API Client
//
// Uses OAuth2 client credentials flow to obtain a bearer token, then caches
// it in KV until 60s before expiry to avoid redundant token requests.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const KV_TOKEN_KEY = "token:graph";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Returns a valid MS Graph access token.
 * Checks KV cache first; fetches a new one via client credentials if missing/expired.
 */
export async function getGraphToken(env: Env): Promise<string> {
  // Try cache first
  const cached = await env.ARCADIA_CACHE.get(KV_TOKEN_KEY);
  if (cached) return cached;

  // Fetch new token
  const url = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph token fetch failed (${res.status}): ${err}`);
  }

  const data = await res.json() as TokenResponse;

  // Cache with 60s safety margin
  const ttlSeconds = Math.max(0, data.expires_in - 60);
  await env.ARCADIA_CACHE.put(KV_TOKEN_KEY, data.access_token, {
    expirationTtl: ttlSeconds,
  });

  return data.access_token;
}

/**
 * Make an authenticated GET request to Microsoft Graph.
 */
export async function graphGet<T>(path: string, env: Env): Promise<T> {
  const token = await getGraphToken(env);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph GET ${path} failed (${res.status}): ${err}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Make an authenticated POST request to Microsoft Graph.
 */
export async function graphPost<T>(
  path: string,
  body: unknown,
  env: Env
): Promise<T> {
  const token = await getGraphToken(env);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph POST ${path} failed (${res.status}): ${err}`);
  }

  return res.json() as Promise<T>;
}
