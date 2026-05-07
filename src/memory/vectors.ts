// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 6: Vector Embedding Operations
//
// Provides semantic memory capabilities via Cloudflare Vectorize + Workers AI.
// Adapted from MemPalace's ChromaDB layer to Cloudflare's native services.
//
//   generateEmbedding     — Workers AI bge-base-en-v1.5 (768-dim)
//   storeMemoryVector     — Upsert memory embedding to Vectorize
//   semanticRecall        — Query Vectorize for semantically similar memories
//   checkDuplicate        — Pre-insert dedup via embedding similarity
//   deleteMemoryVector    — Remove embedding from Vectorize
//   backfillPendingEmbeddings — Batch-index memories with pending embedding_status
//
// All operations are gated behind env.VECTORIZE_ENABLED === "true" AND the
// presence of the ARCADIA_VECTORS binding. Failures are non-fatal — the system
// degrades to keyword-based recall.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, MemoryRow, VectorMatch, VectorMetadata } from "../types.js";
import { aclEnforcementMode, filterByAcl, resolveUserPrincipalSet } from "../graph/acl.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "memory-vectors" });

/** Workers AI embedding model — 768 dimensions, cosine similarity. */
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

/** Maximum input length for bge-base-en-v1.5 (~512 tokens ≈ 2000 chars). */
const MAX_EMBEDDING_INPUT_CHARS = 2000;

/**
 * Type guard: returns the ARCADIA_VECTORS binding if present, else null.
 * Callers skip vector operations cleanly when the binding is missing
 * (e.g. in local dev or before the Vectorize index has been created).
 */
function getVectorIndex(env: Env): VectorizeIndex | null {
  return env.ARCADIA_VECTORS ?? null;
}

// ─── Embedding generation ────────────────────────────────────────────────────

/**
 * Generate a 768-dimensional embedding for the given text.
 * Truncates input to fit within the model's context window.
 */
export async function generateEmbedding(
  text: string,
  env: Env
): Promise<number[]> {
  const truncated = text.slice(0, MAX_EMBEDDING_INPUT_CHARS);

  const { runAI } = await import("../ai/gateway.js");
  const result = await runAI(env, EMBEDDING_MODEL as Parameters<typeof env.AI.run>[0], {
    text: [truncated],
  } as Parameters<typeof env.AI.run>[1]);

  const r = result as { data?: number[][] };
  if (!r.data?.[0]) throw new Error("Embedding model returned empty result");
  return r.data[0];
}

// ─── Vectorize CRUD ──────────────────────────────────────────────────────────

/**
 * Store a memory's embedding in Vectorize.
 * The memory ID is used as the vector ID for 1:1 mapping.
 * Updates embedding_status in D1 on success.
 */
export async function storeMemoryVector(
  memoryId: string,
  content: string,
  metadata: VectorMetadata,
  env: Env
): Promise<void> {
  const index = getVectorIndex(env);
  if (!index) return;

  const embedding = await generateEmbedding(content, env);

  // Vectorize metadata only accepts primitive values; null becomes empty string.
  // Phase 13: source_resource_* fields ride along so semanticRecall can
  // post-filter results against resource_acl without a second DB hop per match.
  const upsertMetadata: Record<string, string | number> = {
    category: metadata.category,
    wing: metadata.wing,
    room: metadata.room ?? "",
    importance: metadata.importance,
    source_resource_type: metadata.sourceResourceType ?? "",
    source_resource_id: metadata.sourceResourceId ?? "",
  };

  await index.upsert([
    {
      id: memoryId,
      values: embedding,
      metadata: upsertMetadata,
    },
  ]);

  // Mark as indexed in D1
  await env.ARCADIA_DB.prepare(
    `UPDATE memories SET embedding_status = 'indexed' WHERE id = ?`
  )
    .bind(memoryId)
    .run();
}

/**
 * Query Vectorize for memories semantically similar to the query text.
 * Returns scored matches with memory IDs and metadata.
 */
export async function semanticRecall(
  query: string,
  env: Env,
  limit = 10,
  filters?: {
    wing?: string;
    room?: string;
    category?: string;
    /**
     * Phase 13: AAD object id of the asking user. When set together with
     * ACL_ENFORCEMENT != "off", the post-vector candidates are filtered
     * against resource_acl. We over-fetch by a factor when this is
     * supplied so the post-filter can drop denied matches without
     * starving the result.
     */
    aclUserAadId?: string;
  }
): Promise<VectorMatch[]> {
  const index = getVectorIndex(env);
  if (!index) return [];

  const embedding = await generateEmbedding(query, env);

  // Build metadata filter
  const filter: Record<string, string> = {};
  if (filters?.wing) filter.wing = filters.wing;
  if (filters?.room) filter.room = filters.room;
  if (filters?.category) filter.category = filters.category;

  const enforcement = aclEnforcementMode(env);
  const aclEnabled = enforcement !== "off" && Boolean(filters?.aclUserAadId);

  // When ACL is enforced, over-fetch so post-filter has headroom.
  const fetchLimit = aclEnabled ? Math.max(limit * 4, 20) : limit;

  const results = await index.query(embedding, {
    topK: fetchLimit,
    returnMetadata: "all",
    ...(Object.keys(filter).length > 0 && { filter }),
  });

  const matches: VectorMatch[] = results.matches.map((match) => ({
    memoryId: match.id,
    score: match.score ?? 0,
    metadata: {
      category: (match.metadata?.category as string) ?? "semantic",
      wing: (match.metadata?.wing as string) ?? "general",
      room: (match.metadata?.room as string) || null,
      importance: (match.metadata?.importance as number) ?? 0.5,
      sourceResourceType: (match.metadata?.source_resource_type as string) || null,
      sourceResourceId: (match.metadata?.source_resource_id as string) || null,
    },
  }));

  if (!aclEnabled) return matches.slice(0, limit);

  // Project metadata into the shape filterByAcl expects.
  const projected = matches.map((m) => ({
    match: m,
    sourceResourceType: m.metadata.sourceResourceType,
    sourceResourceId: m.metadata.sourceResourceId,
  }));
  const principals = await resolveUserPrincipalSet(filters!.aclUserAadId!, env);
  const allowed = await filterByAcl(projected, enforcement, principals, env);

  return allowed.slice(0, limit).map((p) => p.match);
}

/**
 * Check if content is a duplicate of an existing memory.
 * Returns the existing memory ID if similarity exceeds threshold.
 *
 * Default threshold: 0.92 (stricter than MemPalace's 0.85 because
 * Arcadia's memories are shorter and more varied).
 */
export async function checkDuplicate(
  content: string,
  env: Env,
  threshold = 0.92
): Promise<{ isDuplicate: boolean; existingId?: string }> {
  const index = getVectorIndex(env);
  if (!index) return { isDuplicate: false };

  const embedding = await generateEmbedding(content, env);

  const results = await index.query(embedding, {
    topK: 1,
    returnMetadata: "none",
  });

  if (results.matches.length > 0) {
    const top = results.matches[0]!;
    if ((top.score ?? 0) >= threshold) {
      return { isDuplicate: true, existingId: top.id };
    }
  }

  return { isDuplicate: false };
}

/**
 * Remove a memory's embedding from Vectorize.
 */
export async function deleteMemoryVector(
  memoryId: string,
  env: Env
): Promise<void> {
  const index = getVectorIndex(env);
  if (!index) return;
  await index.deleteByIds([memoryId]);
}

// ─── Backfill ────────────────────────────────────────────────────────────────

/**
 * Batch-index memories that have embedding_status = 'pending'.
 * Called during consolidation crons to gradually index existing memories.
 * Returns count of successfully indexed memories.
 */
export async function backfillPendingEmbeddings(
  env: Env,
  batchSize = 20
): Promise<number> {
  if (!getVectorIndex(env)) return 0;

  const result = await env.ARCADIA_DB.prepare(
    `SELECT id, content, category, wing, room, importance
     FROM memories
     WHERE embedding_status = 'pending'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY importance DESC, created_at DESC
     LIMIT ?`
  )
    .bind(Math.floor(Date.now() / 1000), batchSize)
    .all<Pick<MemoryRow, "id" | "content" | "category" | "wing" | "room" | "importance">>();

  let indexed = 0;

  for (const row of result.results) {
    try {
      await storeMemoryVector(
        row.id,
        row.content,
        {
          category: row.category,
          wing: row.wing ?? "general",
          room: row.room ?? null,
          importance: row.importance,
        },
        env
      );
      indexed++;
    } catch (err) {
      console.warn(`[Arcadia] Backfill: failed to index memory ${row.id}:`, err);
      // Mark as failed so we don't retry endlessly
      await env.ARCADIA_DB.prepare(
        `UPDATE memories SET embedding_status = 'failed' WHERE id = ?`
      )
        .bind(row.id)
        .run()
        .catch(swallow(log, "embedding_status_update_failed", undefined, { memoryId: row.id }));
    }
  }

  if (indexed > 0) {
    console.log(`[Arcadia] Backfill: indexed ${indexed}/${result.results.length} memories.`);
  }

  return indexed;
}
