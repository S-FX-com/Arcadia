// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Long-Term Memory
//
// Four memory categories:
//   episodic    — specific events with timestamp and source context
//   semantic    — distilled facts extracted from episodic memories
//   procedural  — process knowledge and how-to information
//   observation — behavioural patterns about people and the team
//
// Phase 4: Recall uses keyword overlap + importance + recency scoring.
// Phase 6: Adds vector dedup, wing/room classification, KG extraction,
//          and Vectorize indexing (all gated behind feature flags).
// Default expiry: episodic=30d, observation=90d, semantic/procedural=permanent.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, Memory, MemoryCategory, MemoryRow } from "../types.js";
import { classifyWingRoom, assignWingRoom } from "./palace.js";
import { checkDuplicate, storeMemoryVector, deleteMemoryVector } from "./vectors.js";
import { extractAndStoreEntities } from "./knowledge-graph.js";

// ─── Stop words for keyword extraction ───────────────────────────────────────

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","as","is","was","are","were","be","been","being","have",
  "has","had","do","does","did","will","would","could","should","may",
  "might","shall","can","need","dare","ought","used","not","no","nor",
  "so","yet","both","either","neither","each","few","more","most","other",
  "some","such","than","then","that","this","these","those","what","which",
  "who","whom","whose","when","where","why","how","all","any","both","each",
  "every","few","if","its","it","they","them","their","there","here","i",
  "we","you","he","she","me","us","my","our","your","his","her","our",
  "about","above","after","before","between","into","through","during",
  "while","although","because","since","unless","until","up","out","off",
  "over","under","again","further","once","just","very","also","too",
]);

// ─── Default expiry by category (seconds) ─────────────────────────────────────

const DEFAULT_EXPIRY_SECONDS: Record<MemoryCategory, number | null> = {
  episodic:    86400 * 30,  // 30 days
  semantic:    null,         // permanent
  procedural:  null,         // permanent
  observation: 86400 * 90,  // 90 days
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Extract up to 15 meaningful keywords from content text.
 * Returns a comma-separated lowercase string for D1 storage.
 */
export function extractKeywords(content: string): string {
  const words = content
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

  // Deduplicate and take top 15
  const unique = [...new Set(words)].slice(0, 15);
  return unique.join(",");
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    category: row.category as MemoryCategory,
    content: row.content,
    keywords: row.keywords ? row.keywords.split(",").filter(Boolean) : [],
    importance: row.importance,
    sourceChannelId: row.source_channel_id,
    sourceUserId: row.source_user_id,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    lastRecalledAt: row.last_recalled_at
      ? new Date(row.last_recalled_at * 1000).toISOString()
      : null,
    recallCount: row.recall_count,
    consolidatedAt: row.consolidated_at
      ? new Date(row.consolidated_at * 1000).toISOString()
      : null,
    expiresAt: row.expires_at
      ? new Date(row.expires_at * 1000).toISOString()
      : null,
    // Phase 6: palace hierarchy + embedding status
    wing: row.wing ?? null,
    room: row.room ?? null,
    embeddingStatus: row.embedding_status ?? null,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Record a new memory to D1.
 * Generates a UUID, extracts keywords, and sets the default expiry for its category.
 *
 * Phase 6 additions:
 *   - Classifies wing/room via palace heuristics
 *   - If VECTORIZE_ENABLED, checks for duplicates via embedding similarity (500ms timeout)
 *   - If VECTORIZE_ENABLED, indexes embedding to Vectorize (fire-and-forget)
 *   - If KNOWLEDGE_GRAPH_ENABLED, extracts entities (fire-and-forget)
 *
 * Returns the new memory's ID, or the existing memory's ID if a duplicate is detected.
 */
export async function recordMemory(
  category: MemoryCategory,
  content: string,
  importance: number,
  sourceChannelId: string | null,
  sourceUserId: string | null,
  env: Env
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const clampedImportance = Math.max(0, Math.min(1, importance));

  // Phase 6: Vector-based dedup check (500ms racing timeout)
  if (env.VECTORIZE_ENABLED === "true") {
    try {
      const dupeResult = await Promise.race([
        checkDuplicate(content, env),
        new Promise<{ isDuplicate: false }>((resolve) =>
          setTimeout(() => resolve({ isDuplicate: false }), 500)
        ),
      ]);
      if (dupeResult.isDuplicate && dupeResult.existingId) {
        // Promote existing memory instead of creating a duplicate
        await promoteMemory(dupeResult.existingId, env);
        console.log(`[Arcadia] Memory dedup: skipped duplicate, promoted ${dupeResult.existingId}`);
        return dupeResult.existingId;
      }
    } catch {
      // Dedup check failed — proceed with insert
    }
  }

  const id = crypto.randomUUID();
  const keywords = extractKeywords(content);
  const expirySeconds = DEFAULT_EXPIRY_SECONDS[category];
  const expiresAt = expirySeconds !== null ? now + expirySeconds : null;

  // Phase 6: Classify wing/room
  const { wing, room } = classifyWingRoom(content, {
    sourceChannelId,
    sourceUserId,
    category,
  });

  await env.ARCADIA_DB.prepare(
    `INSERT INTO memories
       (id, category, content, keywords, importance, source_channel_id, source_user_id,
        created_at, last_recalled_at, recall_count, consolidated_at, expires_at,
        wing, room, embedding_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, 'pending')`,
  )
    .bind(id, category, content, keywords, clampedImportance, sourceChannelId, sourceUserId, now, expiresAt, wing, room)
    .run();

  // Phase 6: Assign wing/room (redundant with INSERT but keeps palace.ts API clean)
  // Phase 6: Index embedding in Vectorize (fire-and-forget)
  if (env.VECTORIZE_ENABLED === "true") {
    storeMemoryVector(id, content, { category, wing, room, importance: clampedImportance }, env).catch((err) => {
      console.warn(`[Arcadia] Memory vector indexing failed for ${id}:`, err);
    });
  }

  // Phase 6: Extract entities for knowledge graph (fire-and-forget)
  if (env.KNOWLEDGE_GRAPH_ENABLED === "true") {
    extractAndStoreEntities(content, "conversation", env).catch((err) => {
      console.warn(`[Arcadia] KG extraction failed for ${id}:`, err);
    });
  }

  return id;
}

/**
 * Recall memories relevant to a query.
 *
 * Strategy:
 * 1. Fetch up to 50 candidates from D1 using category + optional source filters, ordered by importance DESC.
 * 2. Score each candidate in JS: keyword overlap (40%) + importance (30%) + recency (20%) + recall bonus (10%).
 * 3. Return the top `limit` scored memories.
 */
export async function recallMemories(
  query: string,
  env: Env,
  limit = 5,
  filters?: {
    category?: MemoryCategory;
    channelId?: string;
    userId?: string;
  }
): Promise<Memory[]> {
  const queryKeywords = new Set(
    extractKeywords(query)
      .split(",")
      .filter(Boolean)
  );

  // Build SQL with optional filters
  let sql = `SELECT * FROM memories WHERE (expires_at IS NULL OR expires_at > ?)`;
  const params: unknown[] = [Math.floor(Date.now() / 1000)];

  if (filters?.category) {
    sql += ` AND category = ?`;
    params.push(filters.category);
  }
  if (filters?.channelId) {
    sql += ` AND (source_channel_id = ? OR source_channel_id IS NULL)`;
    params.push(filters.channelId);
  }
  if (filters?.userId) {
    sql += ` AND (source_user_id = ? OR source_user_id IS NULL)`;
    params.push(filters.userId);
  }

  sql += ` ORDER BY importance DESC, created_at DESC LIMIT 50`;

  const result = await env.ARCADIA_DB.prepare(sql)
    .bind(...params)
    .all<MemoryRow>();

  const now = Math.floor(Date.now() / 1000);

  const scored = result.results.map((row) => {
    // Keyword overlap score
    const memKeywords = row.keywords ? new Set(row.keywords.split(",").filter(Boolean)) : new Set<string>();
    let overlap = 0;
    for (const kw of queryKeywords) {
      if (memKeywords.has(kw)) overlap++;
    }
    const maxPossible = Math.max(queryKeywords.size, 1);
    const keywordScore = (overlap / maxPossible) * 0.4;

    // Importance score
    const importanceScore = row.importance * 0.3;

    // Recency score: linear decay from 1.0 at 0 days to 0 at 30 days
    const ageSeconds = now - row.created_at;
    const ageDays = ageSeconds / 86400;
    const recencyScore = Math.max(0, 1 - ageDays / 30) * 0.2;

    // Recall bonus: ever been recalled?
    const recallBonus = row.recall_count > 0 ? 0.1 : 0;

    const totalScore = keywordScore + importanceScore + recencyScore + recallBonus;

    return { row, totalScore };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);

  return scored.slice(0, limit).map((s) => rowToMemory(s.row));
}

/**
 * Promote a memory when it is recalled.
 * Increments recall_count, updates last_recalled_at, boosts importance by 0.05 (cap 1.0).
 */
export async function promoteMemory(id: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE memories
     SET recall_count = recall_count + 1,
         last_recalled_at = ?,
         importance = MIN(1.0, importance + 0.05)
     WHERE id = ?`,
  )
    .bind(now, id)
    .run();
}

/**
 * Delete all memories past their expires_at timestamp.
 * Returns count of pruned memories.
 */
export async function pruneExpiredMemories(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ARCADIA_DB.prepare(
    `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`,
  )
    .bind(now)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Mark a memory as consolidated (sets consolidated_at to now).
 */
export async function markConsolidated(id: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE memories SET consolidated_at = ? WHERE id = ?`,
  )
    .bind(now, id)
    .run();
}

/**
 * Get memory counts by category (for heartbeat health check).
 */
export async function getMemoryStats(
  env: Env
): Promise<Record<MemoryCategory, number>> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT category, COUNT(*) as count FROM memories
     WHERE expires_at IS NULL OR expires_at > ?
     GROUP BY category`,
  )
    .bind(Math.floor(Date.now() / 1000))
    .all<{ category: string; count: number }>();

  const stats: Record<MemoryCategory, number> = {
    episodic: 0,
    semantic: 0,
    procedural: 0,
    observation: 0,
  };

  for (const row of result.results) {
    if (row.category in stats) {
      stats[row.category as MemoryCategory] = row.count;
    }
  }

  return stats;
}

/**
 * Get memories created since a given Unix timestamp (for consolidation).
 */
export async function getRecentMemories(
  sinceUnix: number,
  env: Env,
  limit = 30
): Promise<Memory[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memories
     WHERE created_at >= ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(sinceUnix, Math.floor(Date.now() / 1000), limit)
    .all<MemoryRow>();
  return result.results.map(rowToMemory);
}

/**
 * Get memories by category, sorted by importance DESC.
 */
export async function getMemoriesByCategory(
  category: MemoryCategory,
  env: Env,
  limit = 50
): Promise<Memory[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memories
     WHERE category = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY importance DESC, created_at DESC LIMIT ?`,
  )
    .bind(category, Math.floor(Date.now() / 1000), limit)
    .all<MemoryRow>();
  return result.results.map(rowToMemory);
}

/**
 * Get memories with recall_count >= threshold (high-value memories for consolidation).
 */
export async function getHighRecallMemories(
  minRecallCount: number,
  env: Env,
  limit = 20
): Promise<Memory[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memories
     WHERE recall_count >= ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY recall_count DESC, importance DESC LIMIT ?`,
  )
    .bind(minRecallCount, Math.floor(Date.now() / 1000), limit)
    .all<MemoryRow>();
  return result.results.map(rowToMemory);
}

/**
 * Delete a memory by ID. Used for self-model replacement during REM synthesis.
 * Phase 6: Also cleans up Vectorize embedding and memory_links.
 */
export async function deleteMemory(id: string, env: Env): Promise<void> {
  await env.ARCADIA_DB.prepare(`DELETE FROM memories WHERE id = ?`)
    .bind(id)
    .run();

  // Phase 6: Clean up Vectorize embedding
  if (env.VECTORIZE_ENABLED === "true") {
    deleteMemoryVector(id, env).catch(() => {});
  }

  // Phase 6: Clean up memory_links referencing this memory
  await env.ARCADIA_DB.prepare(
    `DELETE FROM memory_links WHERE memory_a_id = ? OR memory_b_id = ?`
  )
    .bind(id, id)
    .run()
    .catch(() => {});
}

/**
 * Find the current self-model memory (if any).
 * Identified by the keyword "arcadia-self-model" in the keywords column.
 */
export async function findSelfModel(env: Env): Promise<Memory | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memories
     WHERE category = 'procedural' AND keywords LIKE '%arcadia-self-model%'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .first<MemoryRow>();
  return row ? rowToMemory(row) : null;
}

/**
 * Get total count of active (non-expired) memories.
 */
export async function getTotalMemoryCount(env: Env): Promise<number> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) as count FROM memories
     WHERE expires_at IS NULL OR expires_at > ?`,
  )
    .bind(Math.floor(Date.now() / 1000))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Get count of memories expiring within the next N seconds.
 */
export async function getExpiringSoonCount(withinSeconds: number, env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) as count FROM memories
     WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at < ?`,
  )
    .bind(now, now + withinSeconds)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Get the most recent memory creation time for each category.
 * Used to detect stale categories (no new memories in 7+ days).
 */
export async function getLatestMemoryByCategory(
  env: Env
): Promise<Record<MemoryCategory, number | null>> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT category, MAX(created_at) as latest FROM memories GROUP BY category`,
  )
    .all<{ category: string; latest: number }>();

  const latest: Record<MemoryCategory, number | null> = {
    episodic: null,
    semantic: null,
    procedural: null,
    observation: null,
  };

  for (const row of result.results) {
    if (row.category in latest) {
      latest[row.category as MemoryCategory] = row.latest;
    }
  }

  return latest;
}
