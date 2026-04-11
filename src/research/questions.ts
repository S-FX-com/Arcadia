// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Research Question Generation + Shane Interaction
//
// Manages the "ask when in doubt" behavior:
//   - Generates questions when research encounters ambiguity
//   - Queues questions in D1 with priority and throttling
//   - Delivers questions to Shane via DM
//   - Processes Shane's answers back into the memory system
//
// Throttling rules:
//   - Max perCycle questions per research cycle (default 3)
//   - Max perDay questions per day (default 5)
//   - Never send when there are 2+ unanswered questions pending
//   - Minimum 2-hour gap between question deliveries
// ─────────────────────────────────────────────────────────────────────────────

import { recordMemory } from "../memory/long-term.js";
import type {
  ConversationBridge,
  Env,
  KnowledgeGap,
  ResearchDirectives,
  ResearchQuestion,
  ResearchQuestionRow,
} from "../types.js";

// ─── Question generation ─────────────────────────────────────────────────────

/**
 * Generate research questions from bridges and knowledge gaps.
 * Returns prioritized questions, capped at the cycle limit.
 */
export function generateQuestions(
  bridges: ConversationBridge[],
  gaps: KnowledgeGap[],
  analysisInsights: string[],
  directives: ResearchDirectives
): ResearchQuestion[] {
  const questions: ResearchQuestion[] = [];

  // Questions from bridge detections (highest priority — channel↔chat gaps)
  for (const bridge of bridges) {
    if (bridge.overallScore < 0.3) continue;
    const topics = bridge.sharedTopics.join(", ");
    const participants = bridge.sharedParticipants.join(", ");
    const chatDesc = bridge.chatTopic ?? "a private chat";

    questions.push({
      id: crypto.randomUUID(),
      question:
        `I noticed a discussion about **${topics}** moved from **#${bridge.channelName}** ` +
        `to ${chatDesc} between ${participants}. ` +
        `Were any decisions made there that should be surfaced to the broader channel?`,
      context:
        `Bridge detection: score ${(bridge.overallScore * 100).toFixed(0)}%. ` +
        `Temporal correlation: ${(bridge.temporalCorrelation * 100).toFixed(0)}%. ` +
        bridge.details,
      importance: Math.min(0.9, bridge.overallScore + 0.2),
      source: "bridge",
      relatedBridgeId: bridge.id,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  }

  // Questions from knowledge gaps
  for (const gap of gaps) {
    questions.push({
      id: crypto.randomUUID(),
      question: buildGapQuestion(gap),
      context: `Knowledge gap: ${gap.entity} (${gap.gapType}), confidence: ${gap.confidence}`,
      importance: 0.6,
      source: "gap",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  }

  // Questions from analysis insights
  for (const insight of analysisInsights) {
    questions.push({
      id: crypto.randomUUID(),
      question: insight,
      context: "Generated during research cycle analysis.",
      importance: 0.5,
      source: "analysis",
      status: "pending",
      createdAt: new Date().toISOString(),
    });
  }

  // Sort by importance descending, cap at cycle limit
  questions.sort((a, b) => b.importance - a.importance);
  return questions.slice(0, directives.questionThrottle.perCycle);
}

function buildGapQuestion(gap: KnowledgeGap): string {
  switch (gap.gapType) {
    case "unknown-owner":
      return `I've seen **${gap.entity}** mentioned several times but I don't know who owns it. Can you tell me who is responsible for this?`;
    case "unknown-status":
      return `What's the current status of **${gap.entity}**? I'm seeing mentions but can't determine where things stand.`;
    case "fragmented-context":
      return `I have scattered context about **${gap.entity}** across multiple channels and chats. Can you give me a brief overview of what this is about and where the main discussion lives?`;
    case "stale-info":
      return `My understanding of **${gap.entity}** might be outdated. Has anything changed recently?`;
    default:
      return `Can you help me understand **${gap.entity}** better?`;
  }
}

// ─── Throttle checks ─────────────────────────────────────────────────────────

const KV_LAST_QUESTION_KEY = "research:last-question-sent";
const KV_DAILY_COUNT_KEY = "research:questions-today";

/**
 * Check whether we can send more questions (throttle enforcement).
 */
export async function canSendQuestions(
  directives: ResearchDirectives,
  env: Env
): Promise<{ allowed: boolean; reason?: string }> {
  // Check daily count
  const dailyCountStr = await env.ARCADIA_CACHE.get(KV_DAILY_COUNT_KEY);
  const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;
  if (dailyCount >= directives.questionThrottle.perDay) {
    return { allowed: false, reason: `Daily limit reached (${dailyCount}/${directives.questionThrottle.perDay})` };
  }

  // Check minimum gap (2 hours)
  const lastSentStr = await env.ARCADIA_CACHE.get(KV_LAST_QUESTION_KEY);
  if (lastSentStr) {
    const lastSent = parseInt(lastSentStr, 10);
    const hoursSince = (Date.now() / 1000 - lastSent) / 3600;
    if (hoursSince < 2) {
      return { allowed: false, reason: `Minimum gap not reached (${hoursSince.toFixed(1)}h < 2h)` };
    }
  }

  // Check pending unanswered questions
  const pendingResult = await env.ARCADIA_DB.prepare(
    `SELECT COUNT(*) as count FROM research_questions
     WHERE status IN ('pending', 'asked')`
  ).first<{ count: number }>();

  const pendingCount = pendingResult?.count ?? 0;
  if (pendingCount >= 2) {
    return { allowed: false, reason: `${pendingCount} unanswered questions pending` };
  }

  return { allowed: true };
}

/**
 * Record that a question was sent (update throttle counters).
 */
async function recordQuestionSent(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_CACHE.put(KV_LAST_QUESTION_KEY, String(now), { expirationTtl: 86400 });

  // Increment daily counter (resets at midnight UTC via TTL)
  const dailyCountStr = await env.ARCADIA_CACHE.get(KV_DAILY_COUNT_KEY);
  const dailyCount = dailyCountStr ? parseInt(dailyCountStr, 10) : 0;
  // TTL: seconds until midnight UTC
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(24, 0, 0, 0);
  const ttl = Math.max(60, Math.floor((midnightUtc.getTime() - Date.now()) / 1000));
  await env.ARCADIA_CACHE.put(KV_DAILY_COUNT_KEY, String(dailyCount + 1), { expirationTtl: ttl });
}

// ─── Question persistence ────────────────────────────────────────────────────

/**
 * Store a question in D1.
 */
export async function storeQuestion(
  question: ResearchQuestion,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `INSERT INTO research_questions
       (id, question, context, importance, source, related_bridge_id, status, answer, created_at, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
  )
    .bind(
      question.id,
      question.question,
      question.context,
      question.importance,
      question.source,
      question.relatedBridgeId ?? null,
      question.status,
      now
    )
    .run();
}

/**
 * Mark a question as "asked" (sent to Shane).
 */
export async function markQuestionAsked(id: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE research_questions SET status = 'asked' WHERE id = ?`
  )
    .bind(id)
    .run();
  await recordQuestionSent(env);
}

/**
 * Get the most recent pending/asked question (for matching Shane's DM replies).
 */
export async function getLatestPendingQuestion(
  env: Env
): Promise<ResearchQuestionRow | null> {
  return env.ARCADIA_DB.prepare(
    `SELECT * FROM research_questions
     WHERE status IN ('pending', 'asked')
     ORDER BY importance DESC, created_at ASC LIMIT 1`
  ).first<ResearchQuestionRow>();
}

/**
 * Get all pending questions ready to send.
 */
export async function getPendingQuestions(
  env: Env,
  limit = 3
): Promise<ResearchQuestionRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM research_questions
     WHERE status = 'pending'
     ORDER BY importance DESC, created_at ASC LIMIT ?`
  )
    .bind(limit)
    .all<ResearchQuestionRow>();
  return result.results;
}

/**
 * Process Shane's answer to a research question.
 * Records the answer in D1 and stores it as a high-importance semantic memory.
 */
export async function processAnswer(
  questionId: string,
  answerText: string,
  env: Env
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Get the original question for context
  const question = await env.ARCADIA_DB.prepare(
    `SELECT * FROM research_questions WHERE id = ?`
  )
    .bind(questionId)
    .first<ResearchQuestionRow>();

  if (!question) return "Could not find the original question.";

  // Update question record
  await env.ARCADIA_DB.prepare(
    `UPDATE research_questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`
  )
    .bind(answerText, now, questionId)
    .run();

  // Record Shane's answer as a high-importance semantic memory
  const memoryContent = `Shane confirmed (research question): ${answerText.slice(0, 400)}. ` +
    `Context: ${question.question.slice(0, 200)}`;

  await recordMemory("semantic", memoryContent, 0.85, null, null, env);

  return `Got it — I've recorded that and it will inform my next research cycle.`;
}

/**
 * Get recent answered questions (for research status display).
 */
export async function getRecentAnsweredQuestions(
  env: Env,
  limit = 5
): Promise<ResearchQuestionRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM research_questions
     WHERE status = 'answered'
     ORDER BY answered_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<ResearchQuestionRow>();
  return result.results;
}

/**
 * Expire old pending questions (older than 72 hours).
 */
export async function expireOldQuestions(env: Env): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - 86400 * 3; // 72 hours ago
  const result = await env.ARCADIA_DB.prepare(
    `UPDATE research_questions SET status = 'expired'
     WHERE status IN ('pending', 'asked') AND created_at < ?`
  )
    .bind(cutoff)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Format a research question for delivery to Shane via DM.
 */
export function formatQuestionForDM(question: ResearchQuestion): string {
  const importanceTag = question.importance >= 0.7 ? "high" : question.importance >= 0.4 ? "medium" : "low";

  return [
    `**Research Question** [importance: ${importanceTag}]`,
    "",
    "I've been analysing conversations across your tenant and have a question.",
    "",
    `**Context:** ${question.context}`,
    "",
    `**Question:** ${question.question}`,
    "",
    "_Reply to this message and I'll incorporate your answer into my understanding._",
  ].join("\n");
}
