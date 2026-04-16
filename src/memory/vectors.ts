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

  const result = await env.AI.run(EMBEDDING_MODEL as Parameters<typeof env.AI.run>[0], {
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

  await index.upsert([
    {
      id: memoryId,
      values: embedding,
      metadata: {
        category: metadata.category,
        wing: metadata.wing,
        room: metadata.room ?? "",
        importance: metadata.importance,
      },
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
  filters?: { wing?: string; room?: string; category?: string }
): Promise<VectorMatch[]> {
  const index = getVectorIndex(env);
  if (!index) return [];

  const embedding = await generateEmbedding(query, env);

  // Build metadata filter
  const filter: Record<string, string> = {};
  if (filters?.wing) filter.wing = filters.wing;
  if (filters?.room) filter.room = filters.room;
  if (filters?.category) filter.category = filters.category;

  const results = await index.query(embedding, {
    topK: limit,
    returnMetadata: "all",
    ...(Object.keys(filter).length > 0 && { filter }),
  });

  return results.matches.map((match) => ({
    memoryId: match.id,
    score: match.score ?? 0,
    metadata: {
      category: (match.metadata?.category as string) ?? "semantic",
      wing: (match.metadata?.wing as string) ?? "general",
      room: (match.metadata?.room as string) || null,
      importance: (match.metadata?.importance as number) ?? 0.5,
    },
  }));
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
        .catch(() => {});
    }
  }

  if (indexed > 0) {
    console.log(`[Arcadia] Backfill: indexed ${indexed}/${result.results.length} memories.`);
  }

  return indexed;
}
