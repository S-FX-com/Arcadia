// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Microsoft Graph API Client
//
// Uses OAuth2 client credentials flow to obtain a bearer token, then caches
// it in KV until 60s before expiry to avoid redundant token requests.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import { GRAPH } from "../constants.js";
import { GraphTokenProvider } from "../auth/token-manager.js";

/**
 * Returns a valid MS Graph access token.
 * Delegates to the unified token manager; retained as a thin wrapper so
 * existing callers keep their import paths.
 */
export function getGraphToken(env: Env): Promise<string> {
  return new GraphTokenProvider(env).getToken();
}

/**
 * Make an authenticated GET request to Microsoft Graph.
 */
export async function graphGet<T>(path: string, env: Env): Promise<T> {
  const token = await getGraphToken(env);
  const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Arcadia] Graph GET ${path} failed (${res.status}):`, err);
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
  const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
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
