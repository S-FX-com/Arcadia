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
import type { Logger } from "../lib/logger";
import type { Session } from "./auth";

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

interface GraphSearchHitResource {
  "@odata.type"?: string;
  id?: string;
  name?: string;
  subject?: string;
  displayName?: string;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
}

interface GraphSearchHit {
  hitId?: string;
  summary?: string;
  resource?: GraphSearchHitResource;
}

interface GraphSearchHitsContainer {
  hits?: GraphSearchHit[];
}

interface GraphSearchResponseEntry {
  hitsContainers?: GraphSearchHitsContainer[];
}

interface GraphSearchResponse {
  value?: GraphSearchResponseEntry[];
}

export interface SearchResultItem {
  type: string;
  id: string;
  title: string | null;
  summary: string | null;
  webUrl: string | null;
  lastModified: string | null;
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

  let raw: GraphSearchResponse;
  try {
    raw = await deps.graph<GraphSearchResponse>(env, {
      method: "POST",
      path: "/search/query",
      token: oboToken,
      body: {
        requests: [
          {
            entityTypes,
            query: { queryString: query },
            from: 0,
            size: SEARCH_SIZE,
          },
        ],
      },
    });
  } catch (e) {
    log.error("webapp_search_graph_failed", {
      error: String(e),
      aadId: identity.aadId,
    });
    return Response.json({ error: "search_failed" }, { status: 502 });
  }

  return Response.json({ results: mapSearchResponse(raw) });
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

/**
 * Defensively flattens the Graph /search/query response
 * (value[].hitsContainers[].hits[]) into a lean, UI-friendly shape.
 * Every field access tolerates a missing/malformed hit rather than
 * throwing — Graph's search response shape varies per entity type
 * (driveItem uses `name`, message/event use `subject`, site uses
 * `displayName`) and we'd rather drop a field than drop the whole hit.
 */
function mapSearchResponse(raw: GraphSearchResponse): SearchResultItem[] {
  const results: SearchResultItem[] = [];
  const entries = raw.value ?? [];
  for (const entry of entries) {
    const containers = entry.hitsContainers ?? [];
    for (const container of containers) {
      const hits = container.hits ?? [];
      for (const hit of hits) {
        results.push(mapHit(hit));
      }
    }
  }
  return results;
}

function mapHit(hit: GraphSearchHit): SearchResultItem {
  const resource = hit.resource ?? {};
  const odataType = resource["@odata.type"] ?? "";
  const type = odataType.replace(/^#microsoft\.graph\./, "") || "unknown";
  const id = resource.id ?? hit.hitId ?? "";
  const title = resource.name ?? resource.subject ?? resource.displayName ?? null;
  const summary = hit.summary ?? null;
  const webUrl = resource.webUrl ?? null;
  const lastModified =
    resource.lastModifiedDateTime ?? resource.createdDateTime ?? null;
  return { type, id, title, summary, webUrl, lastModified };
}
