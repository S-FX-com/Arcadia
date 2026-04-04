// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — Explicit Assignment Command Handler
//
// Handles "assign [task] to [person]" commands.
// Resolves target person against Graph API, matches against open tasks,
// and records the assignment in D1.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveUser } from "../graph/users.js";
import { loadCachedMessages } from "../memory/kv.js";
import {
  assignTaskOwner,
  createTask,
  getOpenTasksForChannel,
} from "./store.js";
import type { Env, TaskRow, TeamsActivity } from "../types.js";

// ─── Command parsing ──────────────────────────────────────────────────────────

export interface ParsedAssignCommand {
  taskDescription: string;
  targetName: string;
}

/**
 * Parse "assign X to Y" or "X should be assigned to Y" patterns.
 * Returns null if the text doesn't match an assignment command.
 */
export function parseAssignCommand(
  text: string
): ParsedAssignCommand | null {
  // Pattern 1: "assign [task] to [person]"
  const assignTo = /\bassign\s+(.+?)\s+to\s+([^.!?]+)/i.exec(text);
  if (assignTo && assignTo[1] && assignTo[2]) {
    return {
      taskDescription: assignTo[1].trim(),
      targetName: assignTo[2].trim(),
    };
  }

  // Pattern 2: "[task] should be (owned|assigned|handled) by [person]"
  const shouldBe = /(.+?)\s+should\s+be\s+(?:owned|assigned|handled)\s+by\s+([^.!?]+)/i.exec(text);
  if (shouldBe && shouldBe[1] && shouldBe[2]) {
    return {
      taskDescription: shouldBe[1].trim(),
      targetName: shouldBe[2].trim(),
    };
  }

  // Pattern 3: "give [task] to [person]" / "hand [task] to [person]"
  const giveTo = /\b(?:give|hand)\s+(.+?)\s+to\s+([^.!?]+)/i.exec(text);
  if (giveTo && giveTo[1] && giveTo[2]) {
    return {
      taskDescription: giveTo[1].trim(),
      targetName: giveTo[2].trim(),
    };
  }

  return null;
}

// ─── Fuzzy task matching ──────────────────────────────────────────────────────

/**
 * Find the best-matching open task for a description string.
 * Uses word-overlap similarity — same approach as detect.ts deduplication.
 */
function findBestMatchingTask(
  description: string,
  tasks: TaskRow[]
): TaskRow | null {
  let best: TaskRow | null = null;
  let bestScore = 0.35; // Minimum threshold to consider a match

  const queryWords = new Set(
    description.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  );

  for (const task of tasks) {
    const taskWords = new Set(
      task.description.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
    );
    let overlap = 0;
    for (const word of queryWords) {
      if (taskWords.has(word)) overlap++;
    }
    const score =
      queryWords.size > 0 ? overlap / Math.min(queryWords.size, taskWords.size) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }

  return best;
}

// ─── User resolution ──────────────────────────────────────────────────────────

/**
 * Try to resolve a display name to an AAD user ID.
 * First checks recent message participants, then falls back to a Graph search.
 *
 * Note: Graph /users?$search requires Directory.Read.All or User.Read.All.
 * The name search here is best-effort — if it fails, we still record the name.
 */
async function resolveTargetUser(
  targetName: string,
  teamId: string,
  channelId: string,
  env: Env
): Promise<{ userId: string | null; displayName: string }> {
  // Check recent message participants for name match
  const cachedMessages = await loadCachedMessages(teamId, channelId, env);
  const lowerTarget = targetName.toLowerCase();

  for (const msg of cachedMessages) {
    if (
      !msg.isBot &&
      msg.authorName.toLowerCase().includes(lowerTarget)
    ) {
      return { userId: msg.authorId, displayName: msg.authorName };
    }
  }

  // Try Graph user search (best-effort)
  try {
    const { graphGet } = await import("../graph/client.js");
    const result = await graphGet<{
      value: { id: string; displayName: string }[];
    }>(
      `/users?$search="displayName:${encodeURIComponent(targetName)}"&$select=id,displayName&$top=1`,
      env
    );
    const found = result.value[0];
    if (found) {
      return { userId: found.id, displayName: found.displayName };
    }
  } catch {
    // Graph search unavailable — proceed with name only
  }

  return { userId: null, displayName: targetName };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handle an `assign` command intent.
 * Resolves target, matches task, updates D1, returns reply text.
 */
export async function handleAssignCommand(
  activity: TeamsActivity,
  parsed: ParsedAssignCommand,
  env: Env
): Promise<string> {
  const teamId =
    activity.channelData?.teamsTeamId ??
    activity.channelData?.team?.id ??
    "unknown";
  const channelId =
    activity.channelData?.teamsChannelId ??
    activity.channelData?.channel?.id ??
    activity.conversation.id;
  const assignerName = activity.from.name ?? "Unknown";

  // Resolve target person
  const { userId: ownerId, displayName: ownerName } = await resolveTargetUser(
    parsed.targetName,
    teamId,
    channelId,
    env
  );

  // Find existing open tasks to match against
  const openTasks = await getOpenTasksForChannel(teamId, channelId, env);
  const matchedTask = findBestMatchingTask(parsed.taskDescription, openTasks);

  if (matchedTask) {
    // Assign existing task
    await assignTaskOwner(
      matchedTask.id,
      ownerId,
      ownerName,
      assignerName,
      "explicit-command",
      env
    );

    return [
      `**Assigned:** ${matchedTask.description}`,
      `**Owner:** ${ownerName}`,
      ownerName !== parsed.targetName ? `_(resolved from "${parsed.targetName}")_` : "",
      "",
      "Ownership recorded. I'll flag this if it goes quiet.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // No existing task matches — create a new one and assign
  const newTaskId = crypto.randomUUID();
  const threadId = activity.replyToId ?? activity.id;

  await createTask(
    {
      id: newTaskId,
      team_id: teamId,
      channel_id: channelId,
      thread_id: threadId,
      description: parsed.taskDescription,
      owner_id: ownerId,
      owner_name: ownerName,
      assigned_by: assignerName,
      assigned_at: Math.floor(Date.now() / 1000),
      deadline: null,
      priority: "normal",
      status: "open",
      detected_at: Math.floor(Date.now() / 1000),
      source_msg_id: activity.id,
      last_nudge_at: null,
    },
    env
  );

  // Log to ownership history as well
  await assignTaskOwner(newTaskId, ownerId, ownerName, assignerName, "explicit-command", env);

  return [
    `**New task created and assigned:**`,
    `**Task:** ${parsed.taskDescription}`,
    `**Owner:** ${ownerName}`,
    "",
    "Task is now being tracked. I'll nudge if it stalls.",
  ].join("\n");
}

/**
 * Generate an ambiguity notice when ownership is unclear.
 * Called when AI detects a task but can't confidently identify the owner.
 */
export function buildAmbiguityNotice(taskDescription: string): string {
  return [
    `No clear owner identified for: _"${taskDescription}"_`,
    "",
    "Use `@Arcadia assign [task] to [name]` to assign it explicitly.",
    "Nothing alarming — just quietly waiting for someone to take ownership.",
  ].join("\n");
}
