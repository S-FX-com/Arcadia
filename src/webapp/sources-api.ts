// /api/webapp/sources — ingest observability + indexed-document browser.
//
// P1 item 7 of EXECUTION-PLAN.md ("is Arcadia seeing everything, and how
// fresh is it?"). Backs the /sources page in the web app.
//
//   GET    /api/webapp/sources[?limit=200]
//     Returns:
//       sources     — indexed documents (Forget-able). Owner-scoped for
//                     non-admins (owner_aad_id = session.aadId), tenant-
//                     wide for admins.
//       ingest      — per-cycle health for every known ingest source
//                     ('registry','messages','drives','sharepoint','mail',
//                     'calendar','meetings','consumer'): the latest
//                     ingest_runs row plus a rolling 24h aggregate
//                     (sum enqueued/processed/failures, run count).
//                     Admin-only — non-admins get `[]`. Interim rule
//                     until P2 ACL derivation lands: ingest cycles are a
//                     tenant-wide operational detail, not a per-user
//                     scope, so we don't have a principled way to trim
//                     it per viewer yet.
//       freshness   — documents.source -> row count + most recent
//                     indexed_at. Owner-scoped for non-admins, same as
//                     `sources`.
//       deltaState  — delta_state row counts + most recent sync per
//                     resource. Admin-only, same rationale as `ingest`.
//
//   DELETE /api/webapp/sources/:id
//     "Forget" — removes a document and its chunks from the local index
//     (so unified recall in src/memory/store.ts stops hydrating it; the
//     Vectorize vector may still exist but the join to `documents` will
//     miss and the hit is dropped). The backing M365 artifact is
//     unaffected; it can be re-indexed on the next sync. Subject
//     (owner_aad_id) or admin only.

import type { Env } from "../env";
import type { Session } from "./auth";

/** Every known ingest cycle name — producers + registry + queue consumer. */
const INGEST_SOURCES = [
  "registry",
  "messages",
  "drives",
  "sharepoint",
  "mail",
  "calendar",
  "meetings",
  "consumer",
] as const;
type IngestSourceName = (typeof INGEST_SOURCES)[number];

interface IngestLatest {
  startedAt: string;
  finishedAt: string | null;
  enqueued: number;
  processed: number;
  failures: number;
}

interface Ingest24h {
  enqueued: number;
  processed: number;
  failures: number;
  runs: number;
}

interface IngestSourceStatus {
  source: IngestSourceName;
  latest: IngestLatest | null;
  last24h: Ingest24h;
}

interface FreshnessRow {
  source: string;
  count: number;
  latestIndexedAt: string | null;
}

interface DeltaStateSummary {
  resource: string;
  count: number;
  lastRunAt: string | null;
}

interface SourceDoc {
  id: string;
  resourceType: string;
  resourceId: string;
  title: string | null;
  uri: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sensitivityLabel: string | null;
  updatedAt: number;
}

export async function handleSources(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/webapp/sources        -> ['api','webapp','sources']
  // /api/webapp/sources/:id    -> [..., id]
  const id = segments[3];

  if (!id) {
    if (request.method === "GET") return listSources(url, env, session);
    return methodNotAllowed();
  }

  if (request.method === "DELETE") return forgetSource(id, env, session);
  return methodNotAllowed();
}

async function listSources(
  url: URL,
  env: Env,
  session: Session,
): Promise<Response> {
  const limit = clampInt(url.searchParams.get("limit"), 200, 1, 500);
  const isAdmin = session.isAdmin === true;

  const sources = await fetchDocumentSources(env, session, isAdmin, limit);
  const freshness = await fetchFreshness(env, session, isAdmin);
  const ingest = isAdmin ? await fetchIngestStatus(env) : [];
  const deltaState = isAdmin ? await fetchDeltaState(env) : [];

  return Response.json({ sources, ingest, freshness, deltaState });
}

// ---------------------------------------------------------------------------
// Document index (existing per-source browse + forget)
// ---------------------------------------------------------------------------

interface DocumentRow {
  id: string;
  source: string;
  resource_id: string;
  owner_aad_id: string | null;
  title: string | null;
  uri: string | null;
  mime_type: string | null;
  sensitivity_label: string | null;
  last_modified_at: string | null;
  indexed_at: string;
}

async function fetchDocumentSources(
  env: Env,
  session: Session,
  isAdmin: boolean,
  limit: number,
): Promise<SourceDoc[]> {
  const stmt = isAdmin
    ? env.ARCADIA_DB.prepare(
        `SELECT id, source, resource_id, owner_aad_id, title, uri, mime_type,
                sensitivity_label, last_modified_at, indexed_at
           FROM documents
          ORDER BY indexed_at DESC
          LIMIT ?`,
      ).bind(limit)
    : env.ARCADIA_DB.prepare(
        `SELECT id, source, resource_id, owner_aad_id, title, uri, mime_type,
                sensitivity_label, last_modified_at, indexed_at
           FROM documents
          WHERE owner_aad_id = ?
          ORDER BY indexed_at DESC
          LIMIT ?`,
      ).bind(session.aadId, limit);

  const { results } = await stmt.all<DocumentRow>();
  return results.map((r) => ({
    id: r.id,
    resourceType: r.source,
    resourceId: r.resource_id,
    title: r.title,
    uri: r.uri,
    mimeType: r.mime_type,
    sizeBytes: null,
    sensitivityLabel: r.sensitivity_label,
    updatedAt: toUnixSeconds(r.last_modified_at ?? r.indexed_at),
  }));
}

async function forgetSource(
  id: string,
  env: Env,
  session: Session,
): Promise<Response> {
  const doc = await env.ARCADIA_DB.prepare(
    `SELECT owner_aad_id FROM documents WHERE id = ?`,
  )
    .bind(id)
    .first<{ owner_aad_id: string | null }>();
  if (!doc) return Response.json({ error: "not_found" }, { status: 404 });

  const isOwner =
    doc.owner_aad_id !== null && doc.owner_aad_id === session.aadId;
  if (!isOwner && session.isAdmin !== true) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Explicit chunk cleanup — don't rely on SQLite FK cascade being
  // enabled for this connection.
  await env.ARCADIA_DB.prepare(
    `DELETE FROM document_chunks WHERE document_id = ?`,
  )
    .bind(id)
    .run();
  await env.ARCADIA_DB.prepare(`DELETE FROM documents WHERE id = ?`)
    .bind(id)
    .run();

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Freshness — documents.source -> count + max(indexed_at)
// ---------------------------------------------------------------------------

interface FreshnessRawRow {
  source: string;
  count: number;
  latest_indexed_at: string | null;
}

async function fetchFreshness(
  env: Env,
  session: Session,
  isAdmin: boolean,
): Promise<FreshnessRow[]> {
  const stmt = isAdmin
    ? env.ARCADIA_DB.prepare(
        `SELECT source, COUNT(*) AS count, MAX(indexed_at) AS latest_indexed_at
           FROM documents
          GROUP BY source
          ORDER BY source`,
      )
    : env.ARCADIA_DB.prepare(
        `SELECT source, COUNT(*) AS count, MAX(indexed_at) AS latest_indexed_at
           FROM documents
          WHERE owner_aad_id = ?
          GROUP BY source
          ORDER BY source`,
      ).bind(session.aadId);

  const { results } = await stmt.all<FreshnessRawRow>();
  return results.map((r) => ({
    source: r.source,
    count: r.count,
    latestIndexedAt: r.latest_indexed_at,
  }));
}

// ---------------------------------------------------------------------------
// Ingest cycle health — admin only
// ---------------------------------------------------------------------------

interface LatestRunRow {
  source: string;
  started_at: string;
  finished_at: string | null;
  enqueued: number;
  processed: number;
  failures: number;
}

interface AggRow {
  source: string;
  enqueued: number;
  processed: number;
  failures: number;
  runs: number;
}

async function fetchIngestStatus(env: Env): Promise<IngestSourceStatus[]> {
  const placeholders = INGEST_SOURCES.map(() => "?").join(",");

  const latestRows = await env.ARCADIA_DB.prepare(
    `SELECT source, started_at, finished_at, enqueued, processed, failures
       FROM ingest_runs
      WHERE source IN (${placeholders})
      ORDER BY started_at DESC`,
  )
    .bind(...INGEST_SOURCES)
    .all<LatestRunRow>();

  const latestBySource = new Map<string, LatestRunRow>();
  for (const row of latestRows.results) {
    if (!latestBySource.has(row.source)) latestBySource.set(row.source, row);
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const aggRows = await env.ARCADIA_DB.prepare(
    `SELECT source,
            COALESCE(SUM(enqueued), 0)  AS enqueued,
            COALESCE(SUM(processed), 0) AS processed,
            COALESCE(SUM(failures), 0)  AS failures,
            COUNT(*)                    AS runs
       FROM ingest_runs
      WHERE source IN (${placeholders}) AND started_at >= ?
      GROUP BY source`,
  )
    .bind(...INGEST_SOURCES, since)
    .all<AggRow>();

  const aggBySource = new Map<string, AggRow>();
  for (const row of aggRows.results) aggBySource.set(row.source, row);

  return INGEST_SOURCES.map((source) => {
    const latestRow = latestBySource.get(source);
    const aggRow = aggBySource.get(source);
    return {
      source,
      latest: latestRow
        ? {
            startedAt: latestRow.started_at,
            finishedAt: latestRow.finished_at,
            enqueued: latestRow.enqueued,
            processed: latestRow.processed,
            failures: latestRow.failures,
          }
        : null,
      last24h: {
        enqueued: aggRow?.enqueued ?? 0,
        processed: aggRow?.processed ?? 0,
        failures: aggRow?.failures ?? 0,
        runs: aggRow?.runs ?? 0,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// delta_state — admin only
// ---------------------------------------------------------------------------

interface DeltaStateRawRow {
  resource: string;
  count: number;
  last_run_at: string | null;
}

async function fetchDeltaState(env: Env): Promise<DeltaStateSummary[]> {
  const { results } = await env.ARCADIA_DB.prepare(
    `SELECT resource, COUNT(*) AS count, MAX(last_run_at) AS last_run_at
       FROM delta_state
      GROUP BY resource
      ORDER BY resource`,
  ).all<DeltaStateRawRow>();
  return results.map((r) => ({
    resource: r.resource,
    count: r.count,
    lastRunAt: r.last_run_at,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUnixSeconds(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function clampInt(
  v: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
