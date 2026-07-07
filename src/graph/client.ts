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
  /** Extra headers (e.g. If-Match for Planner PATCH). */
  headers?: Record<string, string>;
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
  // Absolute URLs (@odata.nextLink / @odata.deltaLink follow-ups) are used
  // verbatim — re-prefixing GRAPH_BASE here is the classic pagination bug
  // that turns page 2+ into https://graph…/v1.0/https://graph…/404.
  const raw = req.path.startsWith("https://")
    ? req.path
    : `${req.baseUrl ?? GRAPH_BASE}${req.path.startsWith("/") ? req.path : `/${req.path}`}`;
  const url = new URL(raw);
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
  const init: RequestInit = {
    method: req.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(req.headers ?? {}),
    },
  };
  if (req.body !== undefined) init.body = JSON.stringify(req.body);
  const res = await fetch(buildUrl(req), init);

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

interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphAllPagesOptions {
  /** Hard cap on pages walked per call (prevents runaway loops). */
  maxPages?: number;
}

/**
 * Walks a Graph collection to the end, following `@odata.nextLink`
 * accumulating every page's `value` array. Returns the final
 * `@odata.deltaLink` when the endpoint is a delta query, so callers can
 * persist a fresh cursor. Follow-up requests reuse the original request's
 * token + headers (delegated auth, ConsistencyLevel: eventual, …).
 */
export async function graphAllPages<T = unknown>(
  env: Env,
  req: GraphRequest,
  opts: GraphAllPagesOptions = {},
): Promise<{ items: T[]; deltaLink?: string }> {
  const maxPages = opts.maxPages ?? 20;
  const items: T[] = [];
  let deltaLink: string | undefined;
  let next: string | undefined;
  let pages = 0;

  do {
    let page: GraphCollection<T>;
    if (next) {
      const followReq: GraphRequest = { path: next };
      if (req.token !== undefined) followReq.token = req.token;
      if (req.headers !== undefined) followReq.headers = req.headers;
      page = await graph<GraphCollection<T>>(env, followReq);
    } else {
      page = await graph<GraphCollection<T>>(env, req);
    }

    if (page.value) items.push(...page.value);
    if (page["@odata.deltaLink"] !== undefined) {
      deltaLink = page["@odata.deltaLink"];
    }
    next = page["@odata.nextLink"];
    pages += 1;
  } while (next !== undefined && pages < maxPages);

  return deltaLink !== undefined ? { items, deltaLink } : { items };
}
