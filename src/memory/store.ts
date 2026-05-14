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
import { deleteVector, embed, queryVectors, upsertVector } from "./vector";

export class MemoryStore {
  constructor(private readonly env: Env) {}

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
      subjectAadId: input.subjectAadId,
      content: input.content,
      sourceResourceType: input.sourceResourceType,
      sourceResourceId: input.sourceResourceId,
      sourceMessageId: input.sourceMessageId,
      embeddingId,
      confidence: input.confidence ?? 1.0,
      sensitivityLabel: input.sensitivityLabel,
      occurredAt: input.occurredAt,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
  }

  async recall(text: string, opts: RecallOpts = {}): Promise<RecallHit[]> {
    const vector = await embed(this.env, text);

    const filter: Record<string, string> = {};
    if (opts.scopeType) filter.scope_type = opts.scopeType;
    if (opts.scopeId) filter.scope_id = opts.scopeId;
    if (typeof opts.kind === "string") filter.kind = opts.kind;
    if (opts.subjectAadId) filter.subject_aad_id = opts.subjectAadId;

    const hits = await queryVectors(this.env, vector, {
      topK: opts.limit ?? 20,
      filter: Object.keys(filter).length ? filter : undefined,
    });

    const min = opts.minScore ?? 0;
    const ids = hits
      .filter((h) => h.score >= min)
      .map(
        (h) =>
          (h.metadata?.memory_id as string) ??
          h.id.replace(/^mem:/, ""),
      );
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<MemoryRow>();

    const byId = new Map(rows.results.map((r) => [r.id, fromRow(r)]));
    const now = new Date().toISOString();
    const out: RecallHit[] = [];
    for (const h of hits) {
      const memId =
        (h.metadata?.memory_id as string) ?? h.id.replace(/^mem:/, "");
      const mem = byId.get(memId);
      if (!mem) continue;
      if (mem.expiresAt && mem.expiresAt < now) continue;
      if (Array.isArray(opts.kind) && !opts.kind.includes(mem.kind)) continue;
      out.push({ memory: mem, score: h.score });
    }

    if (opts.viewer) {
      return out.filter(
        (h) =>
          !h.memory.subjectAadId ||
          h.memory.subjectAadId === opts.viewer ||
          h.memory.scopeType === "channel" ||
          h.memory.scopeType === "chat" ||
          h.memory.scopeType === "tenant",
      );
    }
    return out;
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

function fromRow(r: MemoryRow): Memory {
  return {
    id: r.id,
    kind: r.kind as Kind,
    scopeType: r.scope_type as Scope,
    scopeId: r.scope_id,
    subjectAadId: r.subject_aad_id ?? undefined,
    content: r.content,
    sourceResourceType: r.source_resource_type ?? undefined,
    sourceResourceId: r.source_resource_id ?? undefined,
    sourceMessageId: r.source_message_id ?? undefined,
    embeddingId: r.embedding_id ?? undefined,
    confidence: r.confidence,
    sensitivityLabel: r.sensitivity_label ?? undefined,
    occurredAt: r.occurred_at ?? undefined,
    expiresAt: r.expires_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
