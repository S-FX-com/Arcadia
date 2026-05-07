// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 6: 4-Layer Context Assembly
//
// Adapted from MemPalace's memory stack:
//   L0 — Identity (~100 tokens, always loaded, static)
//   L1 — Essential Story (~500-800 tokens, always loaded, cached in KV)
//   L2 — On-demand keyword recall (current recallMemories())
//   L3 — Deep semantic search (Vectorize, when enabled)
//
// assembleLayeredContext()  — Build the full layered context for a query
// generateL1()             — Regenerate L1 essential context from top memories
// getL0()                  — Return the static identity layer
//
// L0+L1 are always loaded (~600-900 tokens).
// L2+L3 fill the remaining memory budget per mode.
// Results are deduplicated across layers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, Memory, MemoryCategory, LayeredContext, AgentMode } from "../types.js";
import { features } from "../features.js";
import { recallMemories } from "./long-term.js";
import { semanticRecall } from "./vectors.js";
import { buildL1GenerationPrompt } from "../ai/prompts-phase6.js";

// ─── L0: Identity (static) ─────────────────────────────────────────────────

const L0_IDENTITY = `I am Arcadia — operational intelligence for S-FX.com. I watch conversations, hold context, surface what matters, and keep things moving. I am not a chatbot. I am a persistent, learning presence — a chief of staff with perfect recall.`;

export function getL0(): string {
  return L0_IDENTITY;
}

// ─── Token estimation ───────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── KV keys ────────────────────────────────────────────────────────────────

const L1_KV_KEY = "layer1:essential";

// ─── L1: Essential Story (cached in KV) ─────────────────────────────────────

/**
 * Retrieve the cached L1 essential story from KV.
 * Returns empty string if not yet generated.
 */
async function getL1(env: Env): Promise<string> {
  const cached = await env.ARCADIA_CACHE.get(L1_KV_KEY);
  return cached ?? "";
}

/**
 * Regenerate the L1 essential story from the highest-importance memories.
 * Groups by wing, compresses into a structured summary, caches to KV.
 *
 * Called during deep consolidation (daily).
 */
export async function generateL1(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Fetch top 15 memories by importance * recall_count
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memories
     WHERE (expires_at IS NULL OR expires_at > ?)
     ORDER BY importance DESC, recall_count DESC, created_at DESC
     LIMIT 15`
  )
    .bind(now)
    .all<import("../types.js").MemoryRow>();

  if (result.results.length === 0) {
    await env.ARCADIA_CACHE.put(L1_KV_KEY, "", { expirationTtl: 86400 * 7 });
    return "";
  }

  // Convert rows to Memory objects
  const memories: Memory[] = result.results.map((row) => ({
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
    wing: row.wing ?? null,
    room: row.room ?? null,
    embeddingStatus: row.embedding_status ?? null,
  }));

  // Group by wing
  const wingGroups = new Map<string, Memory[]>();
  for (const row of result.results) {
    const wing = row.wing ?? "general";
    const mem = memories.find((m) => m.id === row.id)!;
    if (!wingGroups.has(wing)) wingGroups.set(wing, []);
    wingGroups.get(wing)!.push(mem);
  }

  // Build prompt and call AI
  const prompt = buildL1GenerationPrompt(memories, wingGroups);

  try {
    const { runAI } = await import("../ai/gateway.js");
    const aiResult = await runAI(
      env,
      "@cf/meta/llama-3.1-8b-instruct" as Parameters<typeof env.AI.run>[0],
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: 600,
        temperature: 0.2,
      } as Parameters<typeof env.AI.run>[1]
    );

    const r = aiResult as { response?: string };
    const l1Text = r.response ?? "";

    // Cache for 7 days (regenerated daily during deep consolidation)
    await env.ARCADIA_CACHE.put(L1_KV_KEY, l1Text, { expirationTtl: 86400 * 7 });

    console.log(`[Arcadia] L1: regenerated essential story (${estimateTokens(l1Text)} tokens).`);
    return l1Text;
  } catch (err) {
    console.warn("[Arcadia] L1: generation failed:", err);
    return await getL1(env); // Fall back to cached version
  }
}

// ─── Layered context assembly ───────────────────────────────────────────────

/** Memory budget for L2+L3 after L0+L1 are loaded. */
const L0_L1_MAX_TOKENS = 900;

/** Mode-specific recall limits for L2 (keyword) and L3 (vector). */
const MODE_RECALL_LIMITS: Record<AgentMode, { l2Limit: number; l3Limit: number }> = {
  conversation: { l2Limit: 5, l3Limit: 5 },
  analysis:     { l2Limit: 3, l3Limit: 3 },
  task:         { l2Limit: 2, l3Limit: 2 },
  background:   { l2Limit: 5, l3Limit: 10 },
};

/**
 * Assemble the 4-layer context for a query.
 *
 * L0 (Identity) + L1 (Essential Story) are always loaded.
 * L2 (keyword recall) + L3 (vector search) fill the remaining budget.
 * Memories are deduplicated across L2 and L3.
 */
export async function assembleLayeredContext(
  query: string,
  env: Env,
  mode: AgentMode = "conversation",
  filters?: {
    category?: MemoryCategory;
    channelId?: string;
    userId?: string;
    wing?: string;
    room?: string;
  }
): Promise<LayeredContext> {
  const l0 = getL0();
  const l1 = await getL1(env);
  const limits = MODE_RECALL_LIMITS[mode];

  // L2: Keyword recall (always available)
  // Build filters carefully — exactOptionalPropertyTypes means we can't pass undefined
  const l2Filters: { category?: MemoryCategory; channelId?: string; userId?: string } = {};
  if (filters?.category) l2Filters.category = filters.category;
  if (filters?.channelId) l2Filters.channelId = filters.channelId;
  if (filters?.userId) l2Filters.userId = filters.userId;
  const l2Memories = await recallMemories(query, env, limits.l2Limit, l2Filters);

  // Promote recalled memories
  for (const mem of l2Memories) {
    // Fire-and-forget promotion
    env.ARCADIA_DB.prepare(
      `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ?, importance = MIN(1.0, importance + 0.05) WHERE id = ?`
    )
      .bind(Math.floor(Date.now() / 1000), mem.id)
      .run()
      .catch(() => {});
  }

  // L3: Vector search (only if VECTORIZE_ENABLED)
  let l3Memories: Memory[] = [];
  const l2Ids = new Set(l2Memories.map((m) => m.id));

  if (features.vectorize(env)) {
    try {
      const l3Filters: { wing?: string; room?: string; category?: string } = {};
      if (filters?.wing) l3Filters.wing = filters.wing;
      if (filters?.room) l3Filters.room = filters.room;
      if (filters?.category) l3Filters.category = filters.category;
      const vectorMatches = await semanticRecall(query, env, limits.l3Limit, l3Filters);

      // Fetch full memory objects for vector matches, excluding L2 duplicates
      const newMatchIds = vectorMatches
        .filter((vm) => !l2Ids.has(vm.memoryId))
        .map((vm) => vm.memoryId);

      if (newMatchIds.length > 0) {
        // Fetch from D1 by IDs
        const placeholders = newMatchIds.map(() => "?").join(",");
        const result = await env.ARCADIA_DB.prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders})
           AND (expires_at IS NULL OR expires_at > ?)`
        )
          .bind(...newMatchIds, Math.floor(Date.now() / 1000))
          .all<import("../types.js").MemoryRow>();

        l3Memories = result.results.map((row) => ({
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
          wing: row.wing ?? null,
          room: row.room ?? null,
          embeddingStatus: row.embedding_status ?? null,
        }));
      }
    } catch (err) {
      console.warn("[Arcadia] L3: semantic recall failed, degrading to L2 only:", err);
    }
  }

  const totalTokens =
    estimateTokens(l0) +
    estimateTokens(l1) +
    l2Memories.reduce((sum, m) => sum + estimateTokens(m.content) + 10, 0) +
    l3Memories.reduce((sum, m) => sum + estimateTokens(m.content) + 10, 0);

  return {
    l0Identity: l0,
    l1Essential: l1,
    l2KeywordMemories: l2Memories,
    l3SemanticMemories: l3Memories,
    totalTokens,
  };
}

// ─── Format layered context for prompt injection ────────────────────────────

/**
 * Format the assembled layered context into a prompt-ready string.
 * Respects the given token budget.
 */
export function formatLayeredContextForPrompt(
  ctx: LayeredContext,
  maxTokens: number
): string {
  const sections: string[] = [];
  let used = 0;

  // L0: Always include
  const l0Cost = estimateTokens(ctx.l0Identity);
  if (l0Cost <= maxTokens) {
    sections.push(`**Core identity:** ${ctx.l0Identity}`);
    used += l0Cost;
  }

  // L1: Always include
  if (ctx.l1Essential) {
    const l1Cost = estimateTokens(ctx.l1Essential);
    if (used + l1Cost <= maxTokens) {
      sections.push(`**Essential context:**\n${ctx.l1Essential}`);
      used += l1Cost;
    }
  }

  // L2: Keyword memories
  if (ctx.l2KeywordMemories.length > 0) {
    const l2Lines: string[] = [];
    for (const mem of ctx.l2KeywordMemories) {
      const line = `- [${mem.category}] ${mem.content}`;
      const cost = estimateTokens(line) + 2;
      if (used + cost > maxTokens) break;
      l2Lines.push(line);
      used += cost;
    }
    if (l2Lines.length > 0) {
      sections.push(`**What I remember (keyword match):**\n${l2Lines.join("\n")}`);
    }
  }

  // L3: Semantic memories
  if (ctx.l3SemanticMemories.length > 0) {
    const l3Lines: string[] = [];
    for (const mem of ctx.l3SemanticMemories) {
      const line = `- [${mem.category}] ${mem.content}`;
      const cost = estimateTokens(line) + 2;
      if (used + cost > maxTokens) break;
      l3Lines.push(line);
      used += cost;
    }
    if (l3Lines.length > 0) {
      sections.push(`**Related context (semantic match):**\n${l3Lines.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}
