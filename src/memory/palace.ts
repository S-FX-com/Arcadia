// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Phase 6: Palace Hierarchy (Wing/Room Classification)
//
// Adapted from MemPalace's hierarchical palace metaphor:
//   Wings  → top-level domains (teams, people, projects, customers)
//   Rooms  → topics within domains (standup, billing, auth, etc.)
//
// Classification is heuristic — no AI call required.
// Adapted from MemPalace's room_detector_local.py (50+ keyword patterns).
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, MemoryCategory, MemoryLinkRow } from "../types.js";

// ─── Room keyword patterns ───────────────────────────────────────────────────
// Adapted from MemPalace's room_detector_local.py keyword sets.

const ROOM_PATTERNS: Array<{ room: string; keywords: string[] }> = [
  // Technical
  { room: "frontend", keywords: ["react", "vue", "angular", "css", "html", "ui", "component", "layout", "responsive", "tailwind"] },
  { room: "backend", keywords: ["api", "server", "endpoint", "controller", "middleware", "route", "express", "fastify"] },
  { room: "database", keywords: ["sql", "query", "table", "migration", "schema", "d1", "sqlite", "postgres", "index"] },
  { room: "auth", keywords: ["authentication", "authorization", "oauth", "jwt", "token", "login", "sso", "credential", "permission"] },
  { room: "infrastructure", keywords: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "terraform", "cloudflare", "worker"] },
  { room: "testing", keywords: ["test", "spec", "assert", "mock", "coverage", "jest", "vitest", "e2e", "integration"] },
  { room: "performance", keywords: ["latency", "throughput", "cache", "optimization", "benchmark", "slow", "fast", "bottleneck"] },
  { room: "security", keywords: ["vulnerability", "exploit", "patch", "audit", "compliance", "encryption", "firewall"] },
  // Business
  { room: "standup", keywords: ["standup", "stand-up", "daily", "scrum", "blocker", "yesterday", "today", "sprint"] },
  { room: "planning", keywords: ["roadmap", "milestone", "quarter", "okr", "goal", "priority", "backlog", "sprint-planning"] },
  { room: "meeting", keywords: ["meeting", "agenda", "minutes", "action-item", "follow-up", "sync", "1-on-1", "retro"] },
  { room: "decisions", keywords: ["decision", "decided", "agreed", "approved", "rejected", "vote", "consensus"] },
  { room: "budget", keywords: ["budget", "cost", "invoice", "expense", "pricing", "revenue", "margin", "forecast"] },
  { room: "hiring", keywords: ["hiring", "recruit", "candidate", "interview", "offer", "onboard", "role", "position"] },
  // Customer / Sales
  { room: "customer-support", keywords: ["support", "ticket", "escalation", "sla", "resolution", "complaint"] },
  { room: "sales", keywords: ["deal", "pipeline", "prospect", "lead", "demo", "proposal", "contract", "renewal"] },
  { room: "product", keywords: ["feature", "launch", "release", "feedback", "requirement", "spec", "mvp", "beta"] },
  // Documentation
  { room: "documentation", keywords: ["docs", "readme", "guide", "tutorial", "wiki", "reference", "changelog"] },
  { room: "design", keywords: ["design", "figma", "mockup", "wireframe", "ux", "prototype", "brand"] },
];

// ─── Wing/Room classification ────────────────────────────────────────────────

export interface WingRoomContext {
  sourceChannelId?: string | null;
  sourceUserId?: string | null;
  channelName?: string | null;
  userName?: string | null;
  category: MemoryCategory;
}

/**
 * Classify a memory into a wing and room based on its content and context.
 * Fast heuristic — no AI call.
 *
 * Wing priority:
 *   1. Observation about a person → person:{userId}
 *   2. From a specific channel → channel:{channelId}
 *   3. Default → general
 *
 * Room: keyword matching against ROOM_PATTERNS.
 */
export function classifyWingRoom(
  content: string,
  context: WingRoomContext
): { wing: string; room: string | null } {
  // Determine wing
  let wing = "general";

  if (context.category === "observation" && context.sourceUserId) {
    wing = `person:${context.sourceUserId}`;
  } else if (context.sourceChannelId) {
    wing = `channel:${context.sourceChannelId}`;
  }

  // Determine room via keyword matching
  const lower = content.toLowerCase();
  let bestRoom: string | null = null;
  let bestScore = 0;

  for (const { room, keywords } of ROOM_PATTERNS) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestRoom = room;
    }
  }

  // Require at least 2 keyword matches for room assignment
  return { wing, room: bestScore >= 2 ? bestRoom : null };
}

/**
 * Update the wing and room columns on an existing memory.
 */
export async function assignWingRoom(
  memoryId: string,
  wing: string,
  room: string | null,
  env: Env
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `UPDATE memories SET wing = ?, room = ? WHERE id = ?`
  )
    .bind(wing, room, memoryId)
    .run();
}

// ─── Tunnel discovery ────────────────────────────────────────────────────────

/**
 * Discover rooms that appear in multiple wings and create memory links.
 * This is MemPalace's "tunnel" concept: shared topics bridging different domains.
 *
 * Returns the number of new links created.
 */
export async function discoverTunnels(env: Env): Promise<number> {
  // Find rooms that appear in 2+ distinct wings
  const result = await env.ARCADIA_DB.prepare(
    `SELECT room, COUNT(DISTINCT wing) as wing_count
     FROM memories
     WHERE room IS NOT NULL AND wing != 'general'
       AND (expires_at IS NULL OR expires_at > ?)
     GROUP BY room
     HAVING wing_count >= 2
     LIMIT 20`
  )
    .bind(Math.floor(Date.now() / 1000))
    .all<{ room: string; wing_count: number }>();

  let linksCreated = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const { room } of result.results) {
    // Get one representative memory per wing for this room
    const mems = await env.ARCADIA_DB.prepare(
      `SELECT id, wing FROM memories
       WHERE room = ? AND wing != 'general'
         AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY wing
       ORDER BY importance DESC
       LIMIT 5`
    )
      .bind(room, now)
      .all<{ id: string; wing: string }>();

    const ids = mems.results.map((m) => m.id);

    // Create links between memories from different wings sharing this room
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        try {
          await env.ARCADIA_DB.prepare(
            `INSERT OR IGNORE INTO memory_links (id, memory_a_id, memory_b_id, link_type, strength, created_at)
             VALUES (?, ?, ?, 'related', 0.6, ?)`
          )
            .bind(crypto.randomUUID(), a, b, now)
            .run();
          linksCreated++;
        } catch {
          // UNIQUE constraint — link already exists
        }
      }
    }
  }

  if (linksCreated > 0) {
    console.log(`[Arcadia] Tunnel discovery: created ${linksCreated} cross-wing links.`);
  }

  return linksCreated;
}

/**
 * Clean up orphaned memory links where one side has been deleted.
 */
export async function cleanupOrphanedLinks(env: Env): Promise<number> {
  const result = await env.ARCADIA_DB.prepare(
    `DELETE FROM memory_links
     WHERE memory_a_id NOT IN (SELECT id FROM memories)
        OR memory_b_id NOT IN (SELECT id FROM memories)`
  ).run();

  return result.meta?.changes ?? 0;
}
