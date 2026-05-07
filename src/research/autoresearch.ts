// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Autoresearch Orchestrator
//
// The core research loop, adapted from Karpathy's Autoresearch pattern.
// Runs on a cron schedule (4x/day Mon-Fri) and executes one bounded cycle:
//
//   1. PLAN      — Load directives, select research focus
//   2. SCAN      — Fetch tenant data via Graph API (scanner.ts)
//   3. ANALYZE   — AI extracts findings, gaps, and questions (prompts.ts)
//   4. BRIDGE    — Detect channel↔chat conversation bridges (bridge.ts)
//   5. QUESTION  — Generate and queue questions for Shane (questions.ts)
//   6. STORE     — Record findings as memories, log cycle to D1
//
// Each cycle is bounded: ≤5 Graph API calls, ≤3 AI calls.
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import { buildResearchAnalysisPrompt, buildResearchSummaryPrompt } from "../ai/prompts.js";
import { recallMemories, recordMemory } from "../memory/long-term.js";
import { extractAndStoreEntities } from "../memory/knowledge-graph.js";
import { loadDirectives } from "./directives.js";
import { scanTenant, summarizeSnapshot } from "./scanner.js";
import { detectBridges, confirmBridge, storeBridge, bridgeToMemoryContent } from "./bridge.js";
import {
  generateQuestions,
  storeQuestion,
  canSendQuestions,
  getPendingQuestions,
  markQuestionAsked,
  expireOldQuestions,
  formatQuestionForDM,
} from "./questions.js";
import { features } from "../features.js";
import type {
  Env,
  KnowledgeGap,
  MemoryCategory,
  ResearchCycleResult,
  ResearchCycleRow,
  ResearchQuestion,
} from "../types.js";

// ─── Cycle logging ───────────────────────────────────────────────────────────

async function logCycleStart(env: Env): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.ARCADIA_DB.prepare(
    `INSERT INTO research_cycles
       (started_at, completed_at, status, channels_scanned, chats_scanned,
        users_scanned, memories_created, bridges_detected, questions_generated,
        knowledge_score_delta, summary)
     VALUES (?, NULL, 'running', 0, 0, 0, 0, 0, 0, 0, NULL)`
  )
    .bind(now)
    .run();
  return result.meta?.last_row_id as number;
}

async function completeCycle(
  cycleId: number,
  result: ResearchCycleResult,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE research_cycles
     SET completed_at = ?, status = 'completed',
         channels_scanned = ?, chats_scanned = ?, users_scanned = ?,
         memories_created = ?, bridges_detected = ?, questions_generated = ?,
         knowledge_score_delta = ?, summary = ?
     WHERE id = ?`
  )
    .bind(
      now,
      result.channelsScanned,
      result.chatsScanned,
      result.usersScanned,
      result.memoriesCreated,
      result.bridgesDetected,
      result.questionsGenerated,
      result.knowledgeScoreDelta,
      result.summary,
      cycleId
    )
    .run();
}

async function failCycle(cycleId: number, error: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE research_cycles SET completed_at = ?, status = 'failed', summary = ? WHERE id = ?`
  )
    .bind(now, `Error: ${error.slice(0, 500)}`, cycleId)
    .run();
}

// ─── Main research cycle ─────────────────────────────────────────────────────

/**
 * Run a single autonomous research cycle.
 * This is the main entry point, called from the cron handler.
 */
export async function runResearchCycle(env: Env): Promise<ResearchCycleResult | null> {
  // 1. PLAN — Load directives
  const directives = await loadDirectives(env);
  if (!directives.enabled) {
    console.log("[Arcadia] Research: directives disabled, skipping cycle.");
    return null;
  }

  const cycleId = await logCycleStart(env);
  let memoriesCreated = 0;
  let bridgesDetected = 0;
  let questionsGenerated = 0;

  try {
    // 2. SCAN — Fetch tenant data
    console.log("[Arcadia] Research cycle started:", cycleId);
    const snapshot = await scanTenant(directives, env);

    const channelsScanned = snapshot.channelMessages.size;
    const chatsScanned = snapshot.chatMessages.size;
    const usersScanned = snapshot.users.length;

    // 3. ANALYZE — AI extracts findings from snapshot
    const snapshotText = summarizeSnapshot(snapshot);

    // Load existing knowledge for novelty detection
    const existingMemories = await recallMemories("organization team project", env, 10);
    const existingKnowledge = existingMemories
      .map((m) => `[${m.category}] ${m.content}`)
      .join("\n") || "(no prior knowledge)";

    const { system, user } = buildResearchAnalysisPrompt(
      snapshotText,
      directives.priorities,
      existingKnowledge
    );
    const analysisResponse = await callAI(system, user, env);

    // Parse analysis results
    let findings: Array<{ category: string; content: string; importance: number; isNovel?: boolean }> = [];
    let knowledgeGaps: KnowledgeGap[] = [];
    let questionsForShane: string[] = [];
    let analysisSummary = "";

    try {
      const raw = analysisResponse.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(raw);
      findings = parsed.findings ?? [];
      const rawGaps = (parsed.knowledgeGaps ?? []) as Array<Partial<{ entity: string; gapType: KnowledgeGap["gapType"]; confidence: number }>>;
      knowledgeGaps = rawGaps.map((g) => ({
        entity: g.entity ?? "unknown",
        gapType: g.gapType ?? "unknown-status",
        confidence: g.confidence ?? 0.5,
        lastSeen: new Date().toISOString(),
      }));
      questionsForShane = parsed.questionsForShane ?? [];
      analysisSummary = parsed.summary ?? "";
    } catch {
      console.warn("[Arcadia] Research: failed to parse analysis response.");
    }

    // Store novel findings as memories
    const validCategories: MemoryCategory[] = ["semantic", "procedural", "observation"];
    for (const finding of findings.slice(0, 5)) {
      if (!finding.content || !validCategories.includes(finding.category as MemoryCategory)) continue;
      if (finding.isNovel === false) continue;

      await recordMemory(
        finding.category as MemoryCategory,
        finding.content,
        typeof finding.importance === "number" ? finding.importance : 0.6,
        null,
        null,
        env
      );
      memoriesCreated++;

      // Phase 6: Extract entities from research findings (fire-and-forget)
      if (features.knowledgeGraph(env)) {
        extractAndStoreEntities(finding.content, "research", env).catch((err) =>
          console.warn("[Arcadia] Research KG extraction failed:", err)
        );
      }
    }

    // 4. BRIDGE — Detect channel↔chat conversation bridges
    const bridges = await detectBridges(snapshot, env);

    // AI-confirm top bridges (max 1 confirmation per cycle to stay within AI budget)
    for (const bridge of bridges.slice(0, 1)) {
      const { confirmed, details } = await confirmBridge(bridge, snapshot, env);
      if (confirmed) {
        bridge.details = details || bridge.details;
        await storeBridge(bridge, env);
        bridgesDetected++;

        // Store bridge as a memory
        await recordMemory(
          "semantic",
          bridgeToMemoryContent(bridge),
          0.75,
          bridge.channelId,
          null,
          env
        );
        memoriesCreated++;
      }
    }

    // Also store unconfirmed high-score bridges (they're still noteworthy)
    for (const bridge of bridges.slice(1, 3)) {
      if (bridge.overallScore >= 0.4) {
        await storeBridge(bridge, env);
        bridgesDetected++;
      }
    }

    // 5. QUESTION — Generate and queue questions for Shane
    const questions = generateQuestions(bridges, knowledgeGaps, questionsForShane, directives);
    const { allowed } = await canSendQuestions(directives, env);

    if (allowed) {
      for (const q of questions) {
        await storeQuestion(q, env);
        questionsGenerated++;
      }
    }

    // Expire old unanswered questions
    await expireOldQuestions(env);

    // 6. SCORE — Generate cycle summary
    let summary = analysisSummary;
    let knowledgeScoreDelta = 0;

    if (!summary) {
      const cycleData = [
        `Channels scanned: ${channelsScanned}`,
        `Chats scanned: ${chatsScanned}`,
        `Findings: ${findings.length}`,
        `Memories created: ${memoriesCreated}`,
        `Bridges detected: ${bridgesDetected}`,
        `Questions generated: ${questionsGenerated}`,
      ].join("\n");

      try {
        const { system: sumSystem, user: sumUser } = buildResearchSummaryPrompt(cycleData);
        const sumResponse = await callAI(sumSystem, sumUser, env);
        const raw = sumResponse.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
        const parsed = JSON.parse(raw);
        summary = parsed.summary ?? `Research cycle completed: ${memoriesCreated} memories, ${bridgesDetected} bridges.`;
        knowledgeScoreDelta = parsed.knowledgeScoreDelta ?? 0;
      } catch {
        summary = `Research cycle completed: ${memoriesCreated} memories, ${bridgesDetected} bridges, ${questionsGenerated} questions.`;
      }
    }

    const result: ResearchCycleResult = {
      cycleId,
      channelsScanned,
      chatsScanned,
      usersScanned,
      memoriesCreated,
      bridgesDetected,
      questionsGenerated,
      knowledgeScoreDelta,
      summary,
    };

    await completeCycle(cycleId, result, env);

    console.log(
      `[Arcadia] Research cycle ${cycleId} complete: ` +
      `${memoriesCreated} memories, ${bridgesDetected} bridges, ${questionsGenerated} questions. ` +
      `Summary: ${summary.slice(0, 100)}`
    );

    return result;
  } catch (err) {
    console.error("[Arcadia] Research cycle failed:", err);
    await failCycle(cycleId, String(err), env);
    return null;
  }
}

// ─── Question delivery ───────────────────────────────────────────────────────

/**
 * Send pending research questions to Shane via DM.
 * Called from the morning cron to batch-deliver questions when Shane starts his day.
 *
 * The actual DM sending is handled by the caller (index.ts), which has access
 * to the Bot Framework service URL. This function prepares the messages and
 * marks them as asked.
 */
export async function prepareQuestionsForDelivery(
  env: Env
): Promise<Array<{ id: string; message: string }>> {
  const directives = await loadDirectives(env);
  const { allowed } = await canSendQuestions(directives, env);
  if (!allowed) return [];

  const pending = await getPendingQuestions(env, directives.questionThrottle.perCycle);
  const toSend: Array<{ id: string; message: string }> = [];

  for (const q of pending) {
    const questionObj: ResearchQuestion = {
      id: q.id,
      question: q.question,
      context: q.context ?? "",
      importance: q.importance,
      source: q.source as "bridge" | "gap" | "analysis",
      status: "pending",
      createdAt: new Date(q.created_at * 1000).toISOString(),
    };
    if (q.related_bridge_id) questionObj.relatedBridgeId = q.related_bridge_id;
    const formatted = formatQuestionForDM(questionObj);
    toSend.push({ id: q.id, message: formatted });
    await markQuestionAsked(q.id, env);
  }

  return toSend;
}

// ─── Research status ─────────────────────────────────────────────────────────

/**
 * Get recent research cycles for status display.
 */
export async function getRecentCycles(
  env: Env,
  limit = 5
): Promise<ResearchCycleRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM research_cycles ORDER BY started_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<ResearchCycleRow>();
  return result.results;
}

/**
 * Build a formatted research status summary for Shane.
 */
export async function buildResearchStatus(env: Env): Promise<string> {
  const [directives, recentCycles, pendingQuestions] = await Promise.all([
    loadDirectives(env),
    getRecentCycles(env, 3),
    getPendingQuestions(env),
  ]);

  const status = directives.enabled ? "**Active**" : "**Paused**";

  const cycleLines = recentCycles.map((c) => {
    const date = new Date((c.started_at ?? 0) * 1000).toISOString().slice(0, 16);
    const statusIcon = c.status === "completed" ? "+" : c.status === "failed" ? "x" : "~";
    return `[${statusIcon}] ${date} — ${c.summary?.slice(0, 80) ?? c.status}`;
  });

  const pendingLines = pendingQuestions.map((q) =>
    `- [${q.importance >= 0.7 ? "!" : " "}] ${q.question.slice(0, 80)}`
  );

  return [
    `**Research Status** — ${status}`,
    "",
    "**Recent Cycles:**",
    cycleLines.length > 0 ? cycleLines.join("\n") : "(no cycles yet)",
    "",
    "**Pending Questions for You:**",
    pendingLines.length > 0 ? pendingLines.join("\n") : "(none)",
    "",
    `**Priorities:** ${directives.priorities.length} active`,
    `**Focus:** ${directives.focus.join(", ")}`,
  ].join("\n");
}
