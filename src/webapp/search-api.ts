// POST /api/webapp/search — Microsoft Search, delegated (P2 item 5 of
// EXECUTION-PLAN.md).
//
// This is the first live call site for the on-behalf-of lane in
// src/graph/delegated.ts. Unlike every other recall surface in this
// codebase (memory-api.ts, unified recall in memory/store.ts), which
// filter with our own ACL derivation, this endpoint asks Microsoft Graph
// to search *as the signed-in user* — Graph applies its own native
// security trimming, independent of (and behind) our ACL, so a gap in
// resource_acl derivation can't leak results here.
//
// Auth requires BOTH of:
//   - a valid session cookie (session.aadId) — same as every other
//     /api/webapp/* route, enforced by routes.ts before this handler runs
//   - a verified `x-graph-token` header (src/graph/delegated.ts) whose
//     token oid MATCHES session.aadId — a caller can't present their own
//     session cookie alongside someone else's Graph token to pivot into
//     that user's Graph-trimmed results.
//
//   POST /api/webapp/search
//     Body: { query: string, entityTypes?: string[] }
//     200: { results: SearchResultItem[] }
//     401: { error: 'missing_token' | <verify-failure reason> }  — no/bad x-graph-token
//     403: { error: 'identity_mismatch' }                        — token oid != session.aadId
//     502: { error: 'obo_failed' | 'search_failed' }             — OBO exchange or Graph call failed
//
// The OBO failure and Graph-call failure are both surfaced as 502 (not
// 401/403) so the frontend can tell "your session/token is fine but the
// live Graph hop broke" (e.g. missing admin consent for the OBO scope)
// apart from an identity problem.

import type { Env } from "../env";
import type { GraphRequest } from "../graph/client";
import { graph as defaultGraph } from "../graph/client";
import {
  DelegatedAuthError,
  delegatedGraphToken as defaultDelegatedGraphToken,
  resolveDelegated as defaultResolveDelegated,
  type DelegatedIdentity,
  type ResolveDelegatedOptions,
} from "../graph/delegated";
import { microsoftSearch, type SearchResultItem } from "../graph/search";
import type { Logger } from "../lib/logger";
import type { Session } from "./auth";

// Re-exported so existing importers (and the OpenAPI-shaped comment above)
// keep resolving SearchResultItem from this module after the mapping moved
// into src/graph/search.ts.
export type { SearchResultItem };

const DEFAULT_ENTITY_TYPES = [
  "driveItem",
  "message",
  "chatMessage",
  "event",
  "site",
] as const;

const SEARCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Injectable seam — mirrors ProducerDeps (src/ingest/producers/deps.ts) /
// RegistryDeps (src/graph/registry.ts): integration tests substitute a
// stubbed resolveDelegated/delegatedGraphToken/graph without touching a
// live Entra tenant or Graph.
// ---------------------------------------------------------------------------

export interface SearchDeps {
  resolveDelegated: (
    env: Env,
    request: Request,
    opts?: ResolveDelegatedOptions,
  ) => Promise<DelegatedIdentity>;
  delegatedGraphToken: (env: Env, userToken: string) => Promise<string>;
  graph: <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;
}

export const defaultSearchDeps: SearchDeps = {
  resolveDelegated: defaultResolveDelegated,
  delegatedGraphToken: defaultDelegatedGraphToken,
  graph: defaultGraph,
};

export type HandleSearchOptions = ResolveDelegatedOptions;

// ---------------------------------------------------------------------------
// Request / Graph response shapes
// ---------------------------------------------------------------------------

interface SearchRequestBody {
  query?: unknown;
  entityTypes?: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleSearch(
  request: Request,
  env: Env,
  session: Session,
  log: Logger,
  deps: SearchDeps = defaultSearchDeps,
  opts: HandleSearchOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let identity: DelegatedIdentity;
  try {
    identity = await deps.resolveDelegated(env, request, opts);
  } catch (e) {
    const reason =
      e instanceof DelegatedAuthError ? e.reason : "verification_failed";
    log.warn("webapp_search_delegated_auth_failed", {
      reason,
      error: String(e),
    });
    return Response.json({ error: reason }, { status: 401 });
  }

  if (identity.aadId !== session.aadId) {
    log.warn("webapp_search_identity_mismatch", {
      sessionAadId: session.aadId,
      tokenAadId: identity.aadId,
    });
    return Response.json({ error: "identity_mismatch" }, { status: 403 });
  }

  let body: SearchRequestBody;
  try {
    body = (await request.json()) as SearchRequestBody;
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return Response.json({ error: "missing_query" }, { status: 400 });
  }

  const entityTypes = parseEntityTypes(body.entityTypes);

  let oboToken: string;
  try {
    oboToken = await deps.delegatedGraphToken(env, identity.userToken);
  } catch (e) {
    log.error("webapp_search_obo_failed", {
      error: String(e),
      aadId: identity.aadId,
    });
    return Response.json({ error: "obo_failed" }, { status: 502 });
  }

  let results: SearchResultItem[];
  try {
    results = await microsoftSearch(env, oboToken, query, {
      entityTypes,
      size: SEARCH_SIZE,
      graph: deps.graph,
    });
  } catch (e) {
    log.error("webapp_search_graph_failed", {
      error: String(e),
      aadId: identity.aadId,
    });
    return Response.json({ error: "search_failed" }, { status: 502 });
  }

  return Response.json({ results });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseEntityTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_ENTITY_TYPES];
  }
  const filtered = value.filter((v): v is string => typeof v === "string");
  return filtered.length > 0 ? filtered : [...DEFAULT_ENTITY_TYPES];
}
