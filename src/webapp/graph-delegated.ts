// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — User-Delegated Graph Client (Phase 7)
//
// Parallel to src/graph/client.ts but uses user access tokens (delegated
// permissions) instead of the app-level client credentials token.
// Microsoft Graph enforces per-user permission boundaries.
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../constants.js";

const GRAPH_BASE = GRAPH.BASE_URL;

/**
 * Makes an authenticated GET request to Microsoft Graph using a user's token.
 */
export async function userGraphGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Arcadia Webapp] User Graph GET ${path} failed (${res.status}):`, err);
    throw new Error(`User Graph GET ${path} failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}

/**
 * Makes an authenticated POST request to Microsoft Graph using a user's token.
 */
export async function userGraphPost<T>(
  path: string,
  body: unknown,
  accessToken: string
): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[Arcadia Webapp] User Graph POST ${path} failed (${res.status}):`, err);
    throw new Error(`User Graph POST ${path} failed (${res.status})`);
  }

  return res.json() as Promise<T>;
}
