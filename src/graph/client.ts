// Microsoft Graph HTTP client.
//
// Thin wrapper around fetch that:
//   - prefixes the Graph base URL
//   - sets bearer auth (app-only by default; pass req.token for delegated)
//   - parses JSON responses
//   - retries on 429 / 503 with Retry-After
//   - normalises errors into GraphError

import type { Env } from "../env";
import { appToken } from "./auth";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES = 4;

export interface GraphRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Pre-acquired bearer token (delegated). Omit for app-only. */
  token?: string;
  /** Override base URL for beta or $batch endpoints. */
  baseUrl?: string;
}

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`graph_${status}: ${body.slice(0, 200)}`);
  }
}

function buildUrl(req: GraphRequest): string {
  const base = req.baseUrl ?? GRAPH_BASE;
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  const url = new URL(`${base}${path}`);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function graph<T = unknown>(
  env: Env,
  req: GraphRequest,
  attempt = 0,
): Promise<T> {
  const token = req.token ?? (await appToken(env));
  const res = await fetch(buildUrl(req), {
    method: req.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });

  if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
    return graph(env, req, attempt + 1);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!res.ok) throw new GraphError(res.status, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
