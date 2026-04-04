// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — AI Task Detection Pipeline
//
// Extracts actionable tasks from Teams channel messages using AI.
// Uses the existing model router (CF Workers AI → Claude Haiku → Sonnet).
// ─────────────────────────────────────────────────────────────────────────────

import { callAI } from "../ai/router.js";
import {
  buildTaskExtractionPrompt,
  buildDeadlineParsePrompt,
} from "../ai/prompts.js";
import { getTasksForThread } from "./store.js";
import type { ChannelMessage, Env, ExtractedTask, TaskPriority, TaskRow } from "../types.js";

// Raw shape returned by AI (before validation)
interface RawExtractedTask {
  description?: unknown;
  owner?: unknown;
  deadline?: unknown;
  priority?: unknown;
  confidence?: unknown;
  sourceMessageId?: unknown;
}

// ─── Deadline parsing ─────────────────────────────────────────────────────────

/**
 * Parse natural language deadline text to a Unix timestamp.
 * Uses regex first (fast, no AI cost), then falls back to AI.
 *
 * @param text       - Raw deadline string ("by Friday", "EOD tomorrow", etc.)
 * @param referenceTs - Unix timestamp of the source message (for relative dates)
 */
export function parseDeadlineText(
  text: string,
  referenceTs: number
): number | null {
  if (!text || text.trim().length === 0) return null;

  const ref = new Date(referenceTs * 1000);
  const lower = text.toLowerCase().trim();

  // Today
  if (/\b(today|eod|end of day|by tonight|this evening)\b/.test(lower)) {
    const d = new Date(ref);
    d.setHours(18, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Tomorrow
  if (/\b(tomorrow|tmr|next morning|by tomorrow)\b/.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() + 1);
    d.setHours(18, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // This week
  if (/\b(this week|end of week|eow)\b/.test(lower)) {
    const d = new Date(ref);
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    d.setHours(18, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Next week
  if (/\bnext week\b/.test(lower)) {
    const d = new Date(ref);
    d.setDate(d.getDate() + 7);
    d.setHours(18, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Named day of week: "by Monday", "this Thursday", "next Friday"
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < DAYS.length; i++) {
    const dayName = DAYS[i];
    if (!dayName) continue;
    if (new RegExp(`\\b(by\\s+|this\\s+|next\\s+)?${dayName}\\b`).test(lower)) {
      const d = new Date(ref);
      const targetDay = i;
      const currentDay = d.getDay();
      let diff = (targetDay - currentDay + 7) % 7;
      if (diff === 0) diff = 7; // Next occurrence of same day
      d.setDate(d.getDate() + diff);
      d.setHours(18, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
  }

  // Specific dates: "April 10", "10th", "4/10", "2026-04-10"
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T18:00:00`);
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }

  // Could not parse — return null (AI fallback handled in detectTasksInMessages)
  return null;
}

/**
 * AI-powered deadline parsing for cases regex cannot handle.
 * Always uses CF Workers AI tier (very short prompt).
 */
async function parseDeadlineWithAI(
  text: string,
  referenceTs: number,
  env: Env
): Promise<number | null> {
  const referenceDate = new Date(referenceTs * 1000).toISOString().slice(0, 10);
  const { system, user } = buildDeadlineParsePrompt(text, referenceDate, "en");
  try {
    const response = await callAI(system, user, env);
    const dateStr = response.text.trim();
    if (dateStr === "unknown" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
    const d = new Date(`${dateStr}T18:00:00`);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  } catch {
    return null;
  }
}

// ─── Task extraction ──────────────────────────────────────────────────────────

/**
 * Validate and type-check a raw AI-returned task object.
 */
function validateExtractedTask(
  raw: RawExtractedTask,
  messageIds: Set<string>
): ExtractedTask | null {
  if (typeof raw.description !== "string" || !raw.description.trim()) return null;
  if (typeof raw.confidence !== "number" || raw.confidence < 0.4) return null;
  if (typeof raw.sourceMessageId !== "string" || !messageIds.has(raw.sourceMessageId)) return null;

  const priority: TaskPriority =
    raw.priority === "high" || raw.priority === "low" ? raw.priority : "normal";

  return {
    description: (raw.description as string).trim(),
    ownerName: typeof raw.owner === "string" && raw.owner.trim() ? raw.owner.trim() : null,
    deadlineText: typeof raw.deadline === "string" && raw.deadline.trim() ? raw.deadline.trim() : null,
    deadlineUnix: null, // populated below
    priority,
    confidence: raw.confidence as number,
    sourceMessageId: raw.sourceMessageId as string,
  };
}

/**
 * Simple word-overlap similarity score for deduplication.
 * Returns 0–1; threshold of 0.6 = likely duplicate.
 */
function descriptionSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * Remove extracted tasks that are too similar to already-stored tasks.
 * Prevents duplicate rows when the same message is processed multiple times
 * (e.g., once via notification, once via scheduled scan).
 */
export function deduplicateAgainstExisting(
  extracted: ExtractedTask[],
  existing: TaskRow[]
): ExtractedTask[] {
  return extracted.filter((e) => {
    const isDuplicate = existing.some(
      (x) => descriptionSimilarity(e.description, x.description) >= 0.6
    );
    return !isDuplicate;
  });
}

/**
 * Main task detection pipeline.
 *
 * 1. Build AI prompt from messages
 * 2. Call AI → parse JSON response
 * 3. Validate each extracted task
 * 4. Parse deadlines (regex + AI fallback)
 * 5. Deduplicate against already-stored tasks for the same thread
 *
 * @param messages   - Normalized channel messages (ChannelMessage[])
 * @param env        - Cloudflare Worker env
 * @param threadId   - Root thread ID (for deduplication lookup)
 */
export async function detectTasksInMessages(
  messages: ChannelMessage[],
  env: Env,
  threadId?: string
): Promise<ExtractedTask[]> {
  // Skip if no human messages
  const humanMessages = messages.filter((m) => !m.isBot);
  if (humanMessages.length === 0) return [];

  // Detect language from messages
  const sampleText = humanMessages
    .slice(0, 5)
    .map((m) => m.text)
    .join(" ");

  const { detectLanguage } = await import("../intelligence/context.js");
  const language = detectLanguage(sampleText);

  // Build set of valid message IDs for validation
  const messageIds = new Set(messages.map((m) => m.id));

  // Call AI
  const { system, user } = buildTaskExtractionPrompt(messages, language);
  let rawItems: RawExtractedTask[] = [];

  try {
    const response = await callAI(system, user, env);
    // Strip any markdown fences if AI returned them
    const cleaned = response.text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    rawItems = JSON.parse(cleaned) as RawExtractedTask[];
    if (!Array.isArray(rawItems)) rawItems = [];
  } catch (err) {
    console.warn("[Arcadia] Task extraction JSON parse failed:", err);
    return [];
  }

  // Validate and resolve deadlines
  const tasks: ExtractedTask[] = [];

  for (const raw of rawItems) {
    const validated = validateExtractedTask(raw, messageIds);
    if (!validated) continue;

    // Find source message timestamp for relative deadline parsing
    const srcMsg = messages.find((m) => m.id === validated.sourceMessageId);
    const refTs = srcMsg
      ? Math.floor(new Date(srcMsg.timestamp).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    if (validated.deadlineText) {
      const regexResult = parseDeadlineText(validated.deadlineText, refTs);
      validated.deadlineUnix = regexResult ?? (await parseDeadlineWithAI(validated.deadlineText, refTs, env));
    }

    tasks.push(validated);
  }

  // Deduplicate against existing tasks in this thread
  if (threadId && tasks.length > 0) {
    try {
      const existing = await getTasksForThread(threadId, env);
      return deduplicateAgainstExisting(tasks, existing);
    } catch {
      // If dedup fails, return all (safe to have false positives vs. missing tasks)
      return tasks;
    }
  }

  return tasks;
}

/**
 * Convenience: detect tasks and persist new ones to D1.
 * Returns the list of newly created task IDs.
 */
export async function detectAndStoreTasks(
  teamId: string,
  channelId: string,
  threadId: string,
  messages: ChannelMessage[],
  env: Env
): Promise<string[]> {
  const { createTask } = await import("./store.js");
  const extracted = await detectTasksInMessages(messages, env, threadId);
  const createdIds: string[] = [];

  for (const task of extracted) {
    const id = crypto.randomUUID();
    await createTask(
      {
        id,
        team_id: teamId,
        channel_id: channelId,
        thread_id: threadId,
        description: task.description,
        owner_id: null, // owner name from AI → resolved to ID in assignment flow
        owner_name: task.ownerName,
        assigned_by: task.ownerName ? "arcadia" : null,
        assigned_at: task.ownerName ? Math.floor(Date.now() / 1000) : null,
        deadline: task.deadlineUnix,
        priority: task.priority,
        status: "open",
        detected_at: Math.floor(Date.now() / 1000),
        source_msg_id: task.sourceMessageId,
        last_nudge_at: null,
      },
      env
    );
    createdIds.push(id);
  }

  return createdIds;
}
