// Natural-language task detection.
//
// Given a Teams message + light context (who said it, which channel),
// asks the AI router whether anything in the text is a task and, if
// so, extracts a structured candidate (title, owner mention, deadline,
// priority). The router runs `tier: "balanced"` because Haiku is plenty
// for this — extraction, not generation.
//
// The detector is permissive on the parsing side: it tries strict
// JSON first, then a tolerant fallback for the common case where the
// model wraps JSON in markdown fences or prose.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { Router } from "../ai/router";
import type { Priority } from "./types";

export interface DetectionContext {
  authorAadId?: string;
  authorDisplayName?: string;
  channelDisplayName?: string;
  mentionedAadIds?: string[];
  /** Map of mentioned-display-name → AAD id for owner resolution. */
  mentionRoster?: Record<string, string>;
}

export interface DetectedTask {
  title: string;
  description?: string;
  ownerAadId?: string;
  ownerHint?: string;
  deadlineAt?: string;
  priority: Priority;
  confidence: number;
}

const SYSTEM_PROMPT = `You are Arcadia, scanning a Teams message for actionable work.

A task is something a person owes someone else: a deliverable, a decision they
have to make, a follow-up they promised. Casual mentions, opinions, jokes,
status-only updates ("done", "FYI"), and questions without a clear ask are
NOT tasks.

Output strict JSON with this shape and nothing else:

  {
    "tasks": [
      {
        "title": "<imperative phrase, leads with the verb, under 100 chars>",
        "description": "<one line of context, optional>",
        "ownerHint": "<display name or 'me' or null>",
        "deadlineHint": "<natural-language deadline or null>",
        "priority": "low" | "normal" | "high" | "urgent",
        "confidence": 0.0-1.0
      }
    ]
  }

If nothing is a task, return { "tasks": [] }.
Be conservative — better to miss a task than invent one.`;

export async function detectTasks(
  env: Env,
  text: string,
  context: DetectionContext,
  log: Logger,
): Promise<DetectedTask[]> {
  if (text.trim().length < 10) return [];

  const userBlock = buildUserBlock(text, context);

  const router = new Router(env);
  let raw: string;
  try {
    const reply = await router.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userBlock }],
      tier: "balanced",
      maxTokens: 500,
      temperature: 0,
    });
    raw = reply.text;
  } catch (e) {
    log.warn("task_detect_router_failed", { error: String(e) });
    return [];
  }

  const parsed = parseDetection(raw);
  if (!parsed) {
    log.info("task_detect_unparsable", { raw: raw.slice(0, 200) });
    return [];
  }

  const tasks: DetectedTask[] = [];
  for (const candidate of parsed.tasks ?? []) {
    if (!candidate || typeof candidate.title !== "string") continue;
    const priority = normalisePriority(candidate.priority);
    const ownerAadId = resolveOwner(candidate.ownerHint, context);
    const deadlineAt = parseDeadline(candidate.deadlineHint);
    const task: DetectedTask = {
      title: candidate.title.trim().slice(0, 160),
      priority,
      confidence:
        typeof candidate.confidence === "number"
          ? Math.max(0, Math.min(1, candidate.confidence))
          : 0.5,
      ...(typeof candidate.description === "string" && candidate.description
        ? { description: candidate.description.trim().slice(0, 400) }
        : {}),
      ...(typeof candidate.ownerHint === "string" && candidate.ownerHint
        ? { ownerHint: candidate.ownerHint.trim() }
        : {}),
      ...(ownerAadId ? { ownerAadId } : {}),
      ...(deadlineAt ? { deadlineAt } : {}),
    };
    tasks.push(task);
  }

  log.info("task_detect", { count: tasks.length });
  return tasks;
}

function buildUserBlock(text: string, context: DetectionContext): string {
  const parts: string[] = [];
  if (context.channelDisplayName) parts.push(`Channel: ${context.channelDisplayName}`);
  if (context.authorDisplayName) parts.push(`Author: ${context.authorDisplayName}`);
  if (context.mentionRoster && Object.keys(context.mentionRoster).length > 0) {
    const roster = Object.keys(context.mentionRoster).join(", ");
    parts.push(`Mentioned: ${roster}`);
  }
  parts.push("");
  parts.push("Message:");
  parts.push(text);
  return parts.join("\n");
}

interface RawCandidate {
  title?: unknown;
  description?: unknown;
  ownerHint?: unknown;
  deadlineHint?: unknown;
  priority?: unknown;
  confidence?: unknown;
}

interface RawDetection {
  tasks?: RawCandidate[];
}

function parseDetection(raw: string): RawDetection | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as RawDetection;
  } catch {
    return null;
  }
}

function normalisePriority(v: unknown): Priority {
  if (v === "low" || v === "normal" || v === "high" || v === "urgent") return v;
  return "normal";
}

function resolveOwner(
  hint: unknown,
  context: DetectionContext,
): string | undefined {
  if (typeof hint !== "string") return undefined;
  const trimmed = hint.trim();
  if (!trimmed) return undefined;
  if (trimmed === "me" || trimmed.toLowerCase() === "self") {
    return context.authorAadId;
  }
  const roster = context.mentionRoster ?? {};
  if (roster[trimmed]) return roster[trimmed];
  const lc = trimmed.toLowerCase();
  for (const [name, aadId] of Object.entries(roster)) {
    if (name.toLowerCase() === lc) return aadId;
  }
  return undefined;
}

// Very small natural-language deadline parser.
// Handles "today", "tomorrow", "EOD", "by Friday", "in N days", and
// ISO strings. Returns ISO timestamp or undefined.
function parseDeadline(hint: unknown): string | undefined {
  if (typeof hint !== "string") return undefined;
  const text = hint.trim().toLowerCase();
  if (!text) return undefined;

  // ISO date — let it through.
  const iso = text.match(/\d{4}-\d{2}-\d{2}(t\d{2}:\d{2})?/);
  if (iso) return new Date(iso[0]).toISOString();

  const now = new Date();
  const eod = (d: Date) => {
    const x = new Date(d);
    x.setUTCHours(23, 0, 0, 0);
    return x.toISOString();
  };

  if (text.includes("today") || text.includes("eod")) return eod(now);
  if (text.includes("tomorrow")) {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() + 1);
    return eod(t);
  }
  if (text.includes("this week") || text.includes("end of week")) {
    const t = new Date(now);
    const daysToFri = (5 - t.getUTCDay() + 7) % 7;
    t.setUTCDate(t.getUTCDate() + (daysToFri || 7));
    return eod(t);
  }
  const days = text.match(/in (\d+) day/);
  if (days?.[1]) {
    const n = Number(days[1]);
    if (Number.isFinite(n) && n > 0 && n < 90) {
      const t = new Date(now);
      t.setUTCDate(t.getUTCDate() + n);
      return eod(t);
    }
  }
  const weekday = text.match(
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/,
  );
  if (weekday?.[1]) {
    const target = WEEKDAYS.indexOf(weekday[1]);
    if (target >= 0) {
      const t = new Date(now);
      const delta = (target - t.getUTCDay() + 7) % 7 || 7;
      t.setUTCDate(t.getUTCDate() + delta);
      return eod(t);
    }
  }
  return undefined;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
