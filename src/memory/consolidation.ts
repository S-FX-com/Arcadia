// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Memory Consolidation ("Dreaming")
//
// Three phases aligned with the working day's natural rhythm:
//
//   light  — twice daily (morning + evening crons)
//            Summarise recent episodic memories into durable semantic facts.
//            Deduplicate. Fast pass.
//
//   deep   — daily (8am cron)
//            Cross-reference semantic and high-recall memories for patterns.
//            Promote important memories. Prune expired ones.
//
//   rem    — weekly (Monday 8am cron)
//            Synthesise behavioral trends. Update Arcadia's self-model.
//            Deepest consolidation pass.
//
// All phases are gated by env.MEMORY_CONSOLIDATION_ENABLED === "true".
// Errors are caught and logged — never propagated to block cron execution.
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import {
  buildLightConsolidationPrompt,
  buildDeepConsolidationPrompt,
  buildREMSynthesisPrompt,
} from "../ai/prompts.js";
import {
  getRecentMemories,
  getMemoriesByCategory,
  getHighRecallMemories,
  recordMemory,
  markConsolidated,
  pruneExpiredMemories,
  deleteMemory,
  findSelfModel,
  extractKeywords,
} from "./long-term.js";
import { getAllUserProfiles } from "./d1.js";
// Phase 6 imports
import { backfillPendingEmbeddings } from "./vectors.js";
import { discoverTunnels, cleanupOrphanedLinks } from "./palace.js";
import { generateL1 } from "./layers.js";
import { expireStaleKGFacts } from "./knowledge-graph.js";
import type { Env, DreamPhase, MemoryDreamRow } from "../types.js";
import { features } from "../features.js";

// ─── Dream log helpers ────────────────────────────────────────────────────────

async function logDreamStart(phase: DreamPhase, env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ARCADIA_DB.prepare(
    `INSERT INTO memory_dreams (phase, started_at, completed_at, summary, memories_processed, memories_created, memories_pruned)
     VALUES (?, ?, NULL, NULL, 0, 0, 0)`,
  )
    .bind(phase, now)
    .run();
  return result.meta?.last_row_id as number;
}

async function completeDream(
  id: number,
  summary: string,
  processed: number,
  created: number,
  pruned: number,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE memory_dreams
     SET completed_at = ?, summary = ?, memories_processed = ?, memories_created = ?, memories_pruned = ?
     WHERE id = ?`,
  )
    .bind(now, summary, processed, created, pruned, id)
    .run();
}

/**
 * Get the most recent dream of a given phase.
 */
export async function getLastDream(
  phase: DreamPhase,
  env: Env
): Promise<MemoryDreamRow | null> {
  const row = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memory_dreams WHERE phase = ? ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(phase)
    .first<MemoryDreamRow>();
  return row ?? null;
}

/**
 * Get recent dreams across all phases (for heartbeat + self-model).
 */
export async function getRecentDreams(env: Env, limit = 6): Promise<MemoryDreamRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM memory_dreams WHERE completed_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<MemoryDreamRow>();
  return result.results;
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

function stripJson(text: string): string {
  return text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
}

// ─── Phase 1: Light consolidation ────────────────────────────────────────────

/**
 * Light consolidation: runs twice daily (morning and evening crons).
 *
 * Fetches episodic memories from the last 12 hours, asks AI to distil them
 * into semantic facts, records new semantic memories, and marks the episodic
 * originals as consolidated.
 */
export async function runLightConsolidation(env: Env): Promise<void> {
  const dreamId = await logDreamStart("light", env);
  let created = 0;
  let processed = 0;

  try {
    const since = Math.floor(Date.now() / 1000) - 43200; // 12 hours ago
    const episodic = await getRecentMemories(since, env, 20);

    // Filter to only episodic, un-consolidated memories
    const pending = episodic.filter(
      (m) => m.category === "episodic" && !m.consolidatedAt
    );

    if (pending.length < 3) {
      await completeDream(dreamId, "Skipped — fewer than 3 un-consolidated episodic memories.", 0, 0, 0, env);
      return;
    }

    processed = pending.length;

    const formatted = pending
      .map((m, i) => `${i + 1}. [${m.createdAt.slice(0, 16)}] ${m.content}`)
      .join("\n");

    const { system, user } = buildLightConsolidationPrompt(formatted);
    const response = await callAI(system, user, env);

    let extracted: Array<{ content: string; importance: number }> = [];
    try {
      extracted = JSON.parse(stripJson(response.text));
    } catch {
      // AI returned non-JSON; proceed without creating new memories
    }

    if (Array.isArray(extracted)) {
      for (const item of extracted.slice(0, 5)) {
        if (!item.content) continue;
        await recordMemory(
          "semantic",
          item.content,
          item.importance ?? 0.6,
          null,
          null,
          env
        );
        created++;
      }
    }

    // Mark original episodic memories as consolidated
    for (const mem of pending) {
      await markConsolidated(mem.id, env);
    }

    // Phase 6: Backfill pending embeddings (20 per light cycle)
    let backfilled = 0;
    if (features.vectorize(env)) {
      try {
        backfilled = await backfillPendingEmbeddings(env, 20);
      } catch (err) {
        console.warn("[Arcadia] Light consolidation: backfill failed:", err);
      }
    }

    await completeDream(
      dreamId,
      `Light consolidation: processed ${processed} episodic memories, created ${created} semantic facts${backfilled > 0 ? `, backfilled ${backfilled} embeddings` : ""}.`,
      processed,
      created,
      0,
      env
    );

    console.log(`[Arcadia] Light consolidation: ${processed} processed, ${created} created${backfilled > 0 ? `, ${backfilled} backfilled` : ""}.`);
  } catch (err) {
    console.error("[Arcadia] Light consolidation error:", err);
    await completeDream(dreamId, `Error: ${String(err)}`, processed, created, 0, env).catch(() => {});
  }
}

// ─── Phase 2: Deep consolidation ─────────────────────────────────────────────

/**
 * Deep consolidation: runs daily (8am cron).
 *
 * Cross-references semantic and frequently-recalled memories to find patterns.
 * Records new procedural/observation memories. Prunes expired memories.
 */
export async function runDeepConsolidation(env: Env): Promise<void> {
  const dreamId = await logDreamStart("deep", env);
  let created = 0;
  let pruned = 0;

  try {
    const [semantic, highRecall] = await Promise.all([
      getMemoriesByCategory("semantic", env, 50),
      getHighRecallMemories(3, env, 20),
    ]);

    const semanticFormatted = semantic
      .slice(0, 30)
      .map((m, i) => `${i + 1}. [importance:${m.importance.toFixed(2)}] ${m.content}`)
      .join("\n");

    const highRecallFormatted = highRecall
      .map((m, i) => `${i + 1}. [recalled:${m.recallCount}x] ${m.content}`)
      .join("\n");

    if (!semanticFormatted && !highRecallFormatted) {
      await completeDream(dreamId, "Skipped — no semantic or high-recall memories.", 0, 0, 0, env);
      return;
    }

    const { system, user } = buildDeepConsolidationPrompt(
      semanticFormatted || "(none)",
      highRecallFormatted || "(none)"
    );

    const response = await callAI(system, user, env);

    let result: { newMemories?: Array<{ category: string; content: string; importance: number }> } = {};
    try {
      result = JSON.parse(stripJson(response.text));
    } catch {
      // Continue with pruning even if AI output is malformed
    }

    const newMems = result.newMemories ?? [];
    for (const item of newMems.slice(0, 3)) {
      if (!item.content || !["procedural", "observation"].includes(item.category)) continue;
      await recordMemory(
        item.category as "procedural" | "observation",
        item.content,
        item.importance ?? 0.65,
        null,
        null,
        env
      );
      created++;
    }

    // Always prune expired memories during deep consolidation
    pruned = await pruneExpiredMemories(env);

    // Phase 6: Regenerate L1 essential context, discover tunnels, backfill, KG maintenance
    let tunnelsCreated = 0;
    let backfilled = 0;
    let kgExpired = 0;

    try {
      // Regenerate L1 essential story (cached in KV)
      await generateL1(env);
    } catch (err) {
      console.warn("[Arcadia] Deep consolidation: L1 generation failed:", err);
    }

    if (features.vectorize(env)) {
      try {
        // Discover cross-wing tunnels and create memory_links
        tunnelsCreated = await discoverTunnels(env);
      } catch (err) {
        console.warn("[Arcadia] Deep consolidation: tunnel discovery failed:", err);
      }
      try {
        // Backfill remaining pending embeddings (50 per deep cycle)
        backfilled = await backfillPendingEmbeddings(env, 50);
      } catch (err) {
        console.warn("[Arcadia] Deep consolidation: backfill failed:", err);
      }
    }

    if (features.knowledgeGraph(env)) {
      try {
        // Expire stale, low-confidence KG facts
        kgExpired = await expireStaleKGFacts(env);
      } catch (err) {
        console.warn("[Arcadia] Deep consolidation: KG maintenance failed:", err);
      }
    }

    const p6Summary = [
      tunnelsCreated > 0 ? `${tunnelsCreated} tunnels` : null,
      backfilled > 0 ? `${backfilled} backfilled` : null,
      kgExpired > 0 ? `${kgExpired} KG facts expired` : null,
    ].filter(Boolean).join(", ");

    await completeDream(
      dreamId,
      `Deep consolidation: ${semantic.length} semantic reviewed, ${highRecall.length} high-recall reviewed, ${created} patterns recorded, ${pruned} expired pruned${p6Summary ? `, ${p6Summary}` : ""}.`,
      semantic.length + highRecall.length,
      created,
      pruned,
      env
    );

    console.log(`[Arcadia] Deep consolidation: ${created} patterns, ${pruned} pruned${p6Summary ? `, ${p6Summary}` : ""}.`);
  } catch (err) {
    console.error("[Arcadia] Deep consolidation error:", err);
    await completeDream(dreamId, `Error: ${String(err)}`, 0, created, pruned, env).catch(() => {});
  }
}

// ─── Phase 3: REM synthesis ───────────────────────────────────────────────────

/**
 * REM synthesis: runs weekly (Monday 8am cron).
 *
 * Synthesises behavioral trends across observation memories, cross-references
 * with user profiles, and generates high-level insights about the team.
 */
export async function runREMSynthesis(env: Env): Promise<void> {
  const dreamId = await logDreamStart("rem", env);
  let created = 0;

  try {
    const [observations, semantic, allProfiles] = await Promise.all([
      getMemoriesByCategory("observation", env, 30),
      getMemoriesByCategory("semantic", env, 30),
      getAllUserProfiles("", env).catch(() => []), // empty string returns all (or fails gracefully)
    ]);

    const obsFormatted = observations
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join("\n");

    const semFormatted = semantic
      .slice(0, 20)
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join("\n");

    const profileSummary = allProfiles
      .slice(0, 10)
      .map((p) => {
        const style = p.insights?.communicationStyle?.summary ?? "unknown";
        const focus = p.insights?.focusAreas?.primary?.join(", ") ?? "unknown";
        return `- ${p.displayName}: ${p.messageCount} messages, style: ${style}, focus: ${focus}`;
      })
      .join("\n");

    if (!obsFormatted && !semFormatted) {
      await completeDream(dreamId, "Skipped — insufficient memories for REM synthesis.", 0, 0, 0, env);
      return;
    }

    const { system, user } = buildREMSynthesisPrompt(
      obsFormatted || "(none)",
      semFormatted || "(none)",
      profileSummary || "(no profiles yet)"
    );

    const response = await callAI(system, user, env);

    let result: { insights?: Array<{ content: string; importance: number }> } = {};
    try {
      result = JSON.parse(stripJson(response.text));
    } catch {
      // Nothing to record
    }

    const insights = result.insights ?? [];
    for (const item of insights.slice(0, 5)) {
      if (!item.content) continue;
      await recordMemory(
        "semantic",
        item.content,
        item.importance ?? 0.75,
        null,
        null,
        env
      );
      created++;
    }

    // Phase 6: Clean up orphaned memory_links
    let orphansCleaned = 0;
    try {
      orphansCleaned = await cleanupOrphanedLinks(env);
      if (orphansCleaned > 0) {
        console.log(`[Arcadia] REM: cleaned ${orphansCleaned} orphaned memory links.`);
      }
    } catch (err) {
      console.warn("[Arcadia] REM: orphan link cleanup failed:", err);
    }

    await completeDream(
      dreamId,
      `REM synthesis: ${observations.length} observations + ${semantic.length} semantic memories reviewed, ${created} insights generated${orphansCleaned > 0 ? `, ${orphansCleaned} orphaned links cleaned` : ""}.`,
      observations.length + semantic.length,
      created,
      0,
      env
    );

    console.log(`[Arcadia] REM synthesis complete: ${created} insights created.`);
  } catch (err) {
    console.error("[Arcadia] REM synthesis error:", err);
    await completeDream(dreamId, `Error: ${String(err)}`, 0, created, 0, env).catch(() => {});
  }
}
