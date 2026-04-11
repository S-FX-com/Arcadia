// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Heartbeat
//
// Periodic self-monitoring system. Runs during the daily cron.
//
// Three responsibilities:
//   1. Memory health check — are all categories active and balanced?
//   2. Proactive opportunity scan — deadlines approaching, silent users, stale threads
//   3. Self-model update (weekly) — what has Arcadia learned about this team?
//
// The heartbeat does NOT act on opportunities (no unsolicited messages from
// this layer). It surfaces findings to logs and stores them as memories for
// context in future interactions.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getMemoryStats,
  getTotalMemoryCount,
  getExpiringSoonCount,
  getLatestMemoryByCategory,
  findSelfModel,
  deleteMemory,
  recordMemory,
  getMemoriesByCategory,
} from "../memory/long-term.js";
import { getRecentDreams } from "../memory/consolidation.js";
import { getAllUserProfiles, getAllChannels } from "../memory/d1.js";
import { callAI } from "../ai/router.js";
import { buildSelfModelPrompt } from "../ai/prompts.js";
import type {
  Env,
  MemoryCategory,
  MemoryDream,
  MemoryDreamRow,
  MemoryHealthReport,
  ProactiveOpportunity,
} from "../types.js";

// ─── Memory health check ─────────────────────────────────────────────────────

/**
 * Check the health of Arcadia's memory system.
 * Flags categories that have had no new memories in 7+ days.
 */
export async function checkMemoryHealth(env: Env): Promise<MemoryHealthReport> {
  const [stats, total, expiringSoon, latestByCategory, lastDreamRow] = await Promise.all([
    getMemoryStats(env),
    getTotalMemoryCount(env),
    getExpiringSoonCount(86400 * 2, env), // expiring within 48h
    getLatestMemoryByCategory(env),
    getRecentDreams(env, 1).then((rows: MemoryDreamRow[]) => rows[0] ?? null),
  ]);

  const staleThreshold = Math.floor(Date.now() / 1000) - 86400 * 7; // 7 days ago
  const staleCategories: MemoryCategory[] = [];

  const categories: MemoryCategory[] = ["episodic", "semantic", "procedural", "observation"];
  for (const cat of categories) {
    const latest = latestByCategory[cat];
    if (latest === null || latest < staleThreshold) {
      staleCategories.push(cat);
    }
  }

  let lastDream: MemoryDream | null = null;
  if (lastDreamRow) {
    lastDream = {
      id: lastDreamRow.id,
      phase: lastDreamRow.phase as MemoryDream["phase"],
      startedAt: new Date(lastDreamRow.started_at * 1000).toISOString(),
      completedAt: lastDreamRow.completed_at
        ? new Date(lastDreamRow.completed_at * 1000).toISOString()
        : null,
      summary: lastDreamRow.summary,
      memoriesProcessed: lastDreamRow.memories_processed,
      memoriesCreated: lastDreamRow.memories_created,
      memoriesPruned: lastDreamRow.memories_pruned,
    };
  }

  return {
    totalMemories: total,
    byCategory: stats,
    staleCategories,
    expiringSoon,
    lastDream,
  };
}

// ─── Proactive opportunity scan ───────────────────────────────────────────────

/**
 * Scan for situations Arcadia should be aware of.
 * Returns structured opportunities — these are logged but not acted on automatically.
 *
 * Current scans:
 * - Approaching task deadlines (next 48h)
 * - Users not seen in 48h+ (potentially silent/overloaded)
 * - Unowned high-priority tasks
 */
export async function scanProactiveOpportunities(env: Env): Promise<ProactiveOpportunity[]> {
  const opportunities: ProactiveOpportunity[] = [];
  const now = Math.floor(Date.now() / 1000);

  try {
    // Approaching deadlines (next 48 hours)
    const deadline48h = now + 86400 * 2;
    const deadlineResult = await env.ARCADIA_DB.prepare(
      `SELECT id, description, owner_name, deadline, team_id, channel_id
       FROM tasks
       WHERE status NOT IN ('done') AND deadline IS NOT NULL AND deadline > ? AND deadline < ?
       ORDER BY deadline ASC LIMIT 5`,
    )
      .bind(now, deadline48h)
      .all<{ id: string; description: string; owner_name: string | null; deadline: number; team_id: string; channel_id: string }>();

    for (const task of deadlineResult.results) {
      const hoursLeft = Math.round((task.deadline - now) / 3600);
      opportunities.push({
        type: "approaching-deadline",
        description: `"${task.description}" is due in ${hoursLeft}h (owner: ${task.owner_name ?? "unassigned"})`,
        urgency: hoursLeft < 12 ? "high" : "medium",
        channelId: task.channel_id,
        taskId: task.id,
      });
    }
  } catch (err) {
    console.error("[Arcadia] Heartbeat: deadline scan failed:", err);
  }

  try {
    // Users not seen in 48h (potentially silent / overloaded)
    const cutoff = now - 86400 * 2;
    const profiles = await getAllUserProfiles("", env).catch(() => []);

    for (const profile of profiles.slice(0, 20)) {
      const lastSeenUnix = Math.floor(new Date(profile.lastSeen).getTime() / 1000);
      if (lastSeenUnix < cutoff) {
        const hoursAgo = Math.round((now - lastSeenUnix) / 3600);
        opportunities.push({
          type: "silent-user",
          description: `${profile.displayName} has not been active for ${hoursAgo}h`,
          urgency: hoursAgo > 96 ? "medium" : "low",
          userId: profile.userId,
        });
      }
    }
  } catch (err) {
    console.error("[Arcadia] Heartbeat: silent user scan failed:", err);
  }

  try {
    // Unowned high-priority tasks
    const unownedResult = await env.ARCADIA_DB.prepare(
      `SELECT id, description, channel_id, detected_at
       FROM tasks
       WHERE status NOT IN ('done') AND owner_id IS NULL AND priority = 'high'
       ORDER BY detected_at ASC LIMIT 5`,
    )
      .all<{ id: string; description: string; channel_id: string; detected_at: number }>();

    for (const task of unownedResult.results) {
      const ageHours = Math.round((now - task.detected_at) / 3600);
      opportunities.push({
        type: "unowned-task",
        description: `High-priority task "${task.description}" has no owner (${ageHours}h old)`,
        urgency: ageHours > 24 ? "high" : "medium",
        channelId: task.channel_id,
        taskId: task.id,
      });
    }
  } catch (err) {
    console.error("[Arcadia] Heartbeat: unowned task scan failed:", err);
  }

  return opportunities;
}

// ─── Self-model update ────────────────────────────────────────────────────────

/**
 * Generate and store Arcadia's self-model: what she has learned about this team.
 * Runs during the weekly Monday cron. Replaces any previous self-model.
 */
export async function updateSelfModel(env: Env): Promise<void> {
  try {
    const [stats, dreams, profiles] = await Promise.all([
      getMemoryStats(env),
      getRecentDreams(env, 6),
      getAllUserProfiles("", env).catch(() => []),
    ]);

    const memStatsText = Object.entries(stats)
      .map(([cat, count]) => `${cat}: ${count}`)
      .join(", ");

    const dreamsText = dreams
      .filter((d: MemoryDreamRow) => d.completed_at)
      .slice(0, 4)
      .map((d: MemoryDreamRow) => `[${d.phase}] ${d.summary ?? "completed"}`)
      .join("\n") || "No recent consolidation cycles.";

    const profileText = profiles
      .slice(0, 8)
      .map((p: { displayName: string; messageCount: number; insights?: { communicationStyle?: { summary?: string } } }) => {
        const style = p.insights?.communicationStyle?.summary ?? "not yet profiled";
        return `- ${p.displayName}: ${p.messageCount} messages, ${style}`;
      })
      .join("\n") || "No user profiles yet.";

    const { system, user } = buildSelfModelPrompt(memStatsText, dreamsText, profileText);
    const response = await callAI(system, user, env);

    let result: { selfModel?: string } = {};
    try {
      const raw = response.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      result = JSON.parse(raw);
    } catch {
      // Use raw text as fallback
      result = { selfModel: response.text.trim().slice(0, 500) };
    }

    if (!result.selfModel) return;

    // Replace existing self-model (atomic: delete old, insert new)
    const existing = await findSelfModel(env);
    if (existing) {
      await deleteMemory(existing.id, env);
    }

    // Record new self-model as a procedural memory
    // The keyword "arcadia-self-model" makes it findable for replacement next week
    await env.ARCADIA_DB.prepare(
      `INSERT INTO memories
         (id, category, content, keywords, importance, source_channel_id, source_user_id,
          created_at, last_recalled_at, recall_count, consolidated_at, expires_at)
       VALUES (?, 'procedural', ?, 'arcadia-self-model,self,model,team,arcadia', 0.9, NULL, NULL, ?, NULL, 0, NULL, NULL)`,
    )
      .bind(crypto.randomUUID(), result.selfModel, Math.floor(Date.now() / 1000))
      .run();

    console.log("[Arcadia] Self-model updated:", result.selfModel.slice(0, 100));
  } catch (err) {
    console.error("[Arcadia] updateSelfModel error:", err);
  }
}

// ─── Full heartbeat run ───────────────────────────────────────────────────────

/**
 * Run the complete heartbeat check.
 * Called from the daily cron. Returns health report for logging.
 */
export async function runHeartbeat(env: Env): Promise<MemoryHealthReport> {
  const health = await checkMemoryHealth(env);

  // Log health summary
  console.log(
    `[Arcadia] Heartbeat: ${health.totalMemories} memories total.`,
    `Categories: episodic=${health.byCategory.episodic}, semantic=${health.byCategory.semantic},`,
    `procedural=${health.byCategory.procedural}, observation=${health.byCategory.observation}.`,
    health.staleCategories.length > 0
      ? `Stale: ${health.staleCategories.join(", ")}.`
      : "All categories active.",
    health.expiringSoon > 0 ? `${health.expiringSoon} expiring within 48h.` : "",
  );

  // Scan for proactive opportunities and log them
  try {
    const opportunities = await scanProactiveOpportunities(env);
    if (opportunities.length > 0) {
      console.log(`[Arcadia] Heartbeat: ${opportunities.length} proactive opportunities identified:`);
      for (const opp of opportunities) {
        console.log(`  [${opp.urgency}/${opp.type}] ${opp.description}`);
      }
    }
  } catch (err) {
    console.error("[Arcadia] Heartbeat opportunity scan failed:", err);
  }

  return health;
}
