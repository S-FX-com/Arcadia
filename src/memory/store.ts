// Four-layer memory store on D1 + Vectorize.
//
// Public API:
//   add(memory)               write a memory, generate + index its embedding
//   recall(text, opts)        semantic search via Vectorize + filter + ACL
//   recent(scope, kind, n)    time-based recall
//   byId(id)                  direct lookup
//   link(from, to, kind, w)   create graph edge
//   edges(id)                 edges touching this memory
//   forget(id)                soft delete (sets expires_at = now)
//   prune()                   hard delete expired rows + their vectors
//
// ACL: recall() accepts an optional viewer AAD id. When passed, memories
// whose subject is a different user are filtered out (permissive mode).
// Strict ACL lands when src/acl/ + group_membership ship.

import type { Env } from "../env";
import type {
  Edge,
  EdgeKind,
  Kind,
  Memory,
  NewMemory,
  RecallHit,
  RecallOpts,
  Scope,
} from "./types";
import {
  deleteVector,
  embed,
  queryVectors,
  upsertVector,
  type VectorHit,
} from "./vector";
import { ResourceAcl } from "../acl/resource-acl";
import {
  applyPolicy,
  policyFor,
  requiresExplicitAcl,
} from "../acl/sensitivity";

/**
 * Injectable vector-search seam. Embeds `text` and queries the shared
 * Vectorize index, returning raw matches (both `mem:` and `doc:` ids).
 * Defaults to the real embed + queryVectors path; tests pass a stub because
 * Vectorize + Workers AI are not simulatable under miniflare.
 */
export type VectorSearchFn = (
  text: string,
  opts: { topK?: number; filter?: Record<string, string | number> },
) => Promise<VectorHit[]>;

export class MemoryStore {
  private readonly search: VectorSearchFn;

  constructor(
    private readonly env: Env,
    search?: VectorSearchFn,
  ) {
    this.search =
      search ??
      (async (text, opts) => {
        const vector = await embed(this.env, text);
        return queryVectors(this.env, vector, opts);
      });
  }

  async add(input: NewMemory): Promise<Memory> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const embeddingId = `mem:${id}`;

    const vector = await embed(this.env, input.content);
    await upsertVector(this.env, embeddingId, vector, {
      memory_id: id,
      kind: input.kind,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      ...(input.subjectAadId ? { subject_aad_id: input.subjectAadId } : {}),
    });

    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO memories (
         id, kind, scope_type, scope_id, subject_aad_id, content,
         source_resource_type, source_resource_id, source_message_id,
         embedding_id, confidence, sensitivity_label,
         occurred_at, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.kind,
        input.scopeType,
        input.scopeId,
        input.subjectAadId ?? null,
        input.content,
        input.sourceResourceType ?? null,
        input.sourceResourceId ?? null,
        input.sourceMessageId ?? null,
        embeddingId,
        input.confidence ?? 1.0,
        input.sensitivityLabel ?? null,
        input.occurredAt ?? null,
        input.expiresAt ?? null,
        now,
        now,
      )
      .run();

    return {
      id,
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      content: input.content,
      embeddingId,
      confidence: input.confidence ?? 1.0,
      createdAt: now,
      updatedAt: now,
      ...(input.subjectAadId ? { subjectAadId: input.subjectAadId } : {}),
      ...(input.sourceResourceType
        ? { sourceResourceType: input.sourceResourceType }
        : {}),
      ...(input.sourceResourceId
        ? { sourceResourceId: input.sourceResourceId }
        : {}),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
      ...(input.sensitivityLabel
        ? { sensitivityLabel: input.sensitivityLabel }
        : {}),
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
  }

  async recall(text: string, opts: RecallOpts = {}): Promise<RecallHit[]> {
    const filter: Record<string, string> = {};
    if (opts.scopeType) filter.scope_type = opts.scopeType;
    if (opts.scopeId) filter.scope_id = opts.scopeId;
    // "document" is not a Vectorize metadata value — doc vectors carry no
    // `kind` field — so a single-kind "document" filter would exclude
    // everything. Only push real memory kinds; the document surface is
    // gated by kindAllowed() below.
    if (typeof opts.kind === "string" && opts.kind !== "document") {
      filter.kind = opts.kind;
    }
    if (opts.subjectAadId) filter.subject_aad_id = opts.subjectAadId;

    const topK = opts.limit ?? 20;
    const hits = await this.search(text, {
      topK,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    });

    const min = opts.minScore ?? 0;
    const scored = hits.filter((h) => h.score >= min);
    if (scored.length === 0) return [];

    // Partition by vector-id prefix: `mem:` → memories table; `doc:` →
    // document_chunks + documents. A legacy match with neither prefix but a
    // memory_id in metadata is treated as a memory (back-compat).
    const memHits: VectorHit[] = [];
    const docHits: VectorHit[] = [];
    for (const h of scored) {
      if (h.id.startsWith("doc:")) docHits.push(h);
      else memHits.push(h);
    }

    const kindAllowed = (kind: Kind): boolean => {
      if (opts.kind === undefined) return true;
      if (typeof opts.kind === "string") return opts.kind === kind;
      return opts.kind.includes(kind);
    };

    const now = new Date().toISOString();
    const out: RecallHit[] = [];

    // --- Memory hits (existing hydration) -----------------------------------
    if (memHits.length > 0) {
      const ids = memHits.map(
        (h) => (h.metadata?.memory_id as string) ?? h.id.replace(/^mem:/, ""),
      );
      const placeholders = ids.map(() => "?").join(",");
      const rows = await this.env.ARCADIA_DB.prepare(
        `SELECT * FROM memories WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .all<MemoryRow>();

      const byId = new Map(rows.results.map((r) => [r.id, fromRow(r)]));
      for (const h of memHits) {
        const memId =
          (h.metadata?.memory_id as string) ?? h.id.replace(/^mem:/, "");
        const mem = byId.get(memId);
        if (!mem) continue;
        if (mem.expiresAt && mem.expiresAt < now) continue;
        if (!kindAllowed(mem.kind)) continue;
        out.push({ memory: mem, score: h.score });
      }
    }

    // --- Document hits (chunk + document join, adapted to Memory shape) ------
    if (docHits.length > 0 && kindAllowed("document")) {
      const docs = await this.hydrateDocuments(docHits);
      for (const hit of docs) out.push(hit);
    }

    // topK ordering by score across BOTH kinds.
    out.sort((a, b) => b.score - a.score);

    if (!opts.viewer) return out;

    // Strict ACL by default. Callers without identity can opt out via
    // strict:false (the consolidation cycle, internal cron paths).
    const strict = opts.strict !== false;
    if (!strict) return out;

    return this.filterByAcl(out, opts.viewer, opts.tenantId);
  }

  /**
   * Hydrate `doc:` matches into RecallHits shaped exactly like memory hits so
   * they flow through the same ACL gate. The chunk's owner_aad_id becomes the
   * hit's subjectAadId (so redact/confidential subject rules apply), and the
   * scope is resolved fail-closed:
   *   1. documents.scope_type/scope_id  (written since migration 0003)
   *   2. else the vector metadata scope  (legacy rows, if present)
   *   3. else user:<owner_aad_id>
   *   4. else the hit is dropped (never surface an unscoped doc)
   */
  private async hydrateDocuments(docHits: VectorHit[]): Promise<RecallHit[]> {
    const chunkIds = docHits.map(
      (h) => (h.metadata?.chunk_id as string) ?? h.id.replace(/^doc:/, ""),
    );
    const placeholders = chunkIds.map(() => "?").join(",");
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT c.id            AS chunk_id,
              c.text          AS chunk_text,
              c.document_id   AS document_id,
              c.sensitivity_label AS chunk_sensitivity,
              c.created_at    AS created_at,
              d.title         AS title,
              d.source        AS source,
              d.owner_aad_id  AS owner_aad_id,
              d.sensitivity_label AS doc_sensitivity,
              d.scope_type    AS scope_type,
              d.scope_id      AS scope_id
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.id IN (${placeholders})`,
    )
      .bind(...chunkIds)
      .all<DocChunkRow>();

    const byId = new Map(rows.results.map((r) => [r.chunk_id, r]));
    const out: RecallHit[] = [];
    for (const h of docHits) {
      const chunkId =
        (h.metadata?.chunk_id as string) ?? h.id.replace(/^doc:/, "");
      const row = byId.get(chunkId);
      if (!row) continue;

      const scope = resolveDocScope(row, h.metadata);
      if (!scope) continue; // fail closed: unscoped docs are unretrievable

      const title = row.title?.trim();
      const content =
        title && title.length > 0
          ? `«${title}» ${row.chunk_text}`
          : row.chunk_text;
      const sensitivity = row.chunk_sensitivity ?? row.doc_sensitivity;

      const memory: Memory = {
        id: row.chunk_id,
        kind: "document",
        scopeType: scope.resourceType as Scope,
        scopeId: scope.resourceId,
        content,
        confidence: 1.0,
        createdAt: row.created_at,
        updatedAt: row.created_at,
        embeddingId: `doc:${row.chunk_id}`,
        sourceResourceType: "document",
        sourceResourceId: row.document_id,
        ...(row.owner_aad_id ? { subjectAadId: row.owner_aad_id } : {}),
        ...(sensitivity ? { sensitivityLabel: sensitivity } : {}),
      };
      out.push({ memory, score: h.score });
    }
    return out;
  }

  private async filterByAcl(
    hits: RecallHit[],
    viewer: string,
    tenantId: string | undefined,
  ): Promise<RecallHit[]> {
    if (hits.length === 0) return hits;

    const acl = new ResourceAcl(this.env);

    // The relevant resource for a memory is its scope (channel/chat/
    // user/tenant/project/customer). We dedupe to one ACL check per
    // distinct (scopeType, scopeId).
    type Scoped = { resourceType: string; resourceId: string };
    const scoped = new Map<string, Scoped>();
    for (const h of hits) {
      const key = `${h.memory.scopeType}|${h.memory.scopeId}`;
      if (!scoped.has(key)) {
        scoped.set(key, {
          resourceType: h.memory.scopeType,
          resourceId: h.memory.scopeId,
        });
      }
    }

    const allowedScopes = new Set<string>(
      (
        await acl.filterAccessible([...scoped.values()], {
          viewerAadId: viewer,
          ...(tenantId ? { tenantId } : {}),
        })
      ).map((r) => `${r.resourceType}|${r.resourceId}`),
    );

    const out: RecallHit[] = [];
    for (const h of hits) {
      const policy = policyFor(h.memory.sensitivityLabel);
      const isSubject =
        h.memory.subjectAadId !== undefined &&
        h.memory.subjectAadId === viewer;

      // Subject always sees own memory in full.
      if (isSubject) {
        out.push(h);
        continue;
      }

      // Subject-privacy (SOUL.md §privacy, EXECUTION-PLAN §2 item 4): a
      // behavioral *observation* about a third party is never surfaced to a
      // non-subject, even when the scope is otherwise accessible. filterByAcl
      // only runs for non-admin viewers (recall() skips ACL entirely for the
      // admin path), so dropping here == dropping for every non-admin. Other
      // kinds (semantic/episodic/procedural) from the same scope are kept.
      if (
        h.memory.kind === "observation" &&
        h.memory.subjectAadId !== undefined &&
        h.memory.subjectAadId !== viewer
      ) {
        continue;
      }

      const scopeAllowed = allowedScopes.has(
        `${h.memory.scopeType}|${h.memory.scopeId}`,
      );

      // confidential / redact require explicit grants — empty ACL is
      // deny. ResourceAcl.filterAccessible already includes empty-ACL
      // resources in the allowed set; we need a second pass for the
      // confidential class.
      if (requiresExplicitAcl(policy)) {
        const explicit = await this.hasExplicitGrant(
          h.memory.scopeType,
          h.memory.scopeId,
        );
        if (!explicit) continue;
        if (!scopeAllowed) continue;
      } else {
        if (!scopeAllowed) continue;
      }

      const safeContent = applyPolicy(
        h.memory.content,
        policy,
        viewer,
        h.memory.subjectAadId,
      );
      if (safeContent === h.memory.content) {
        out.push(h);
      } else {
        out.push({
          score: h.score,
          memory: { ...h.memory, content: safeContent },
        });
      }
    }
    return out;
  }

  private async hasExplicitGrant(
    resourceType: string,
    resourceId: string,
  ): Promise<boolean> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT 1 AS x FROM resource_acl
        WHERE resource_type = ? AND resource_id = ?
        LIMIT 1`,
    )
      .bind(resourceType, resourceId)
      .first<{ x: number }>();
    return row !== null;
  }

  async recent(
    scopeType: Scope,
    scopeId: string,
    kind: Kind | undefined,
    n: number,
  ): Promise<Memory[]> {
    const stmt = kind
      ? this.env.ARCADIA_DB.prepare(
          `SELECT * FROM memories
             WHERE scope_type = ? AND scope_id = ? AND kind = ?
             ORDER BY COALESCE(occurred_at, created_at) DESC
             LIMIT ?`,
        ).bind(scopeType, scopeId, kind, n)
      : this.env.ARCADIA_DB.prepare(
          `SELECT * FROM memories
             WHERE scope_type = ? AND scope_id = ?
             ORDER BY COALESCE(occurred_at, created_at) DESC
             LIMIT ?`,
        ).bind(scopeType, scopeId, n);
    const rows = await stmt.all<MemoryRow>();
    return rows.results.map(fromRow);
  }

  async byId(id: string): Promise<Memory | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM memories WHERE id = ?`,
    )
      .bind(id)
      .first<MemoryRow>();
    return row ? fromRow(row) : null;
  }

  async link(
    fromId: string,
    toId: string,
    kind: EdgeKind,
    weight = 1.0,
  ): Promise<Edge> {
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT OR REPLACE INTO memory_edges (from_id, to_id, kind, weight, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(fromId, toId, kind, weight, now)
      .run();
    return { fromId, toId, kind, weight, createdAt: now };
  }

  async edges(memoryId: string): Promise<Edge[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ?`,
    )
      .bind(memoryId, memoryId)
      .all<EdgeRow>();
    return rows.results.map(edgeFromRow);
  }

  async forget(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, now, id)
      .run();
  }

  async prune(): Promise<number> {
    const now = new Date().toISOString();
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT id, embedding_id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`,
    )
      .bind(now)
      .all<{ id: string; embedding_id: string | null }>();

    for (const r of rows.results) {
      if (r.embedding_id) await deleteVector(this.env, r.embedding_id);
    }

    const ids = rows.results.map((r) => r.id);
    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => "?").join(",");
    await this.env.ARCADIA_DB.prepare(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .run();
    return ids.length;
  }
}

interface MemoryRow {
  id: string;
  kind: string;
  scope_type: string;
  scope_id: string;
  subject_aad_id: string | null;
  content: string;
  source_resource_type: string | null;
  source_resource_id: string | null;
  source_message_id: string | null;
  embedding_id: string | null;
  confidence: number;
  sensitivity_label: string | null;
  occurred_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  kind: string;
  weight: number;
  created_at: string;
}

interface DocChunkRow {
  chunk_id: string;
  chunk_text: string;
  document_id: string;
  chunk_sensitivity: string | null;
  created_at: string;
  title: string | null;
  source: string;
  owner_aad_id: string | null;
  doc_sensitivity: string | null;
  scope_type: string | null;
  scope_id: string | null;
}

/**
 * Fail-closed scope resolution for a document chunk. Prefers the columns
 * added in migration 0003, falls back to the legacy vector-metadata scope,
 * then to the owner's user scope, and finally gives up (null → drop the hit).
 */
function resolveDocScope(
  row: DocChunkRow,
  metadata: Record<string, unknown> | undefined,
): { resourceType: string; resourceId: string } | null {
  if (row.scope_type && row.scope_id) {
    return { resourceType: row.scope_type, resourceId: row.scope_id };
  }
  const mType = metadata?.scope_type;
  const mId = metadata?.scope_id;
  if (typeof mType === "string" && mType && typeof mId === "string" && mId) {
    return { resourceType: mType, resourceId: mId };
  }
  if (row.owner_aad_id) {
    return { resourceType: "user", resourceId: row.owner_aad_id };
  }
  return null;
}

function fromRow(r: MemoryRow): Memory {
  return {
    id: r.id,
    kind: r.kind as Kind,
    scopeType: r.scope_type as Scope,
    scopeId: r.scope_id,
    content: r.content,
    confidence: r.confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.subject_aad_id ? { subjectAadId: r.subject_aad_id } : {}),
    ...(r.source_resource_type
      ? { sourceResourceType: r.source_resource_type }
      : {}),
    ...(r.source_resource_id
      ? { sourceResourceId: r.source_resource_id }
      : {}),
    ...(r.source_message_id
      ? { sourceMessageId: r.source_message_id }
      : {}),
    ...(r.embedding_id ? { embeddingId: r.embedding_id } : {}),
    ...(r.sensitivity_label
      ? { sensitivityLabel: r.sensitivity_label }
      : {}),
    ...(r.occurred_at ? { occurredAt: r.occurred_at } : {}),
    ...(r.expires_at ? { expiresAt: r.expires_at } : {}),
  };
}

function edgeFromRow(r: EdgeRow): Edge {
  return {
    fromId: r.from_id,
    toId: r.to_id,
    kind: r.kind as EdgeKind,
    weight: r.weight,
    createdAt: r.created_at,
  };
}
