// Microsoft Search — shared delegated /search/query helper.
//
// This is the single call site for Microsoft Graph's /search/query endpoint
// on the delegated (on-behalf-of) lane. Graph runs the query *as the
// signed-in user* and applies its own native security trimming, independent
// of (and behind) Arcadia's ACL derivation, so a gap in resource_acl can't
// leak results here.
//
// Two surfaces consume this helper:
//   - src/webapp/search-api.ts   — the standalone POST /api/webapp/search
//     endpoint (P2 item 5).
//   - src/webapp/chat-stream.ts  — Microsoft Search as a *recall surface*
//     that augments Arcadia's vector recall in chat (P3 item 3), so answers
//     draw on live Graph-trimmed content, not only ingested memory.
//
// The Graph client is an injectable seam (opts.graph) mirroring the
// SearchDeps pattern in search-api.ts, so integration tests substitute a
// stubbed Graph without touching a live tenant.

import type { Env } from "../env";
import { graph as defaultGraph, type GraphRequest } from "./client";

/** Entity types Microsoft Search queries by default across both surfaces. */
export const DEFAULT_ENTITY_TYPES = [
  "message",
  "chatMessage",
  "driveItem",
  "event",
  "site",
] as const;

/** Default page size when the caller doesn't specify one. */
export const DEFAULT_SEARCH_SIZE = 10;

export type GraphFn = <T = unknown>(env: Env, req: GraphRequest) => Promise<T>;

export interface MicrosoftSearchOptions {
  /** Entity types to search. Defaults to DEFAULT_ENTITY_TYPES. */
  entityTypes?: readonly string[];
  /** Page size. Defaults to DEFAULT_SEARCH_SIZE. */
  size?: number;
  /** Test seam: substitute the Graph client. Defaults to the real client. */
  graph?: GraphFn;
}

// ---------------------------------------------------------------------------
// Graph response shapes — the /search/query response shape varies per entity
// type (driveItem uses `name`, message/event use `subject`, site uses
// `displayName`), so every access is defensive.
// ---------------------------------------------------------------------------

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

/**
 * Run a Microsoft Search query on the delegated lane and return lean,
 * mapped hits. `oboToken` is a Graph access token already exchanged via
 * On-Behalf-Of (src/graph/delegated.ts::delegatedGraphToken).
 */
export async function microsoftSearch(
  env: Env,
  oboToken: string,
  query: string,
  opts: MicrosoftSearchOptions = {},
): Promise<SearchResultItem[]> {
  const entityTypes = opts.entityTypes ?? DEFAULT_ENTITY_TYPES;
  const size = opts.size ?? DEFAULT_SEARCH_SIZE;
  const graphFn = opts.graph ?? defaultGraph;

  const raw = await graphFn<GraphSearchResponse>(env, {
    method: "POST",
    path: "/search/query",
    token: oboToken,
    body: {
      requests: [
        {
          entityTypes: [...entityTypes],
          query: { queryString: query },
          from: 0,
          size,
        },
      ],
    },
  });

  return mapSearchResponse(raw);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Defensively flattens the Graph /search/query response
 * (value[].hitsContainers[].hits[]) into a lean shape. Every field access
 * tolerates a missing/malformed hit rather than throwing — we'd rather drop
 * a field than drop the whole hit.
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
  const title =
    resource.name ?? resource.subject ?? resource.displayName ?? null;
  const summary = hit.summary ?? null;
  const webUrl = resource.webUrl ?? null;
  const lastModified =
    resource.lastModifiedDateTime ?? resource.createdDateTime ?? null;
  return { type, id, title, summary, webUrl, lastModified };
}
