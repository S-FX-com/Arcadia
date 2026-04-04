// ─────────────────────────────────────────────────────────────────────────────
// Arcadia Phase 2 — Task & Ownership D1 Store
//
// All CRUD for tasks and ownership_history tables.
// Mirrors patterns from src/memory/d1.ts (thin typed wrappers over D1 prepare().bind().run()).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Env,
  OwnershipHistoryRow,
  OwnershipReason,
  TaskPriority,
  TaskRow,
  TaskStatus,
} from "../types.js";

const MAX_NUDGE_COUNT = 10; // Hard ceiling to prevent runaway nudging

// ─── Task creation ────────────────────────────────────────────────────────────

/**
 * Insert a new task into D1. Generates a UUID for the primary key.
 * Returns the generated task ID.
 */
export async function createTask(
  task: Omit<TaskRow, "nudge_count">,
  env: Env
): Promise<string> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO tasks
       (id, team_id, channel_id, thread_id, description, owner_id, owner_name,
        assigned_by, assigned_at, deadline, priority, status, detected_at,
        source_msg_id, last_nudge_at, nudge_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      task.id,
      task.team_id,
      task.channel_id,
      task.thread_id,
      task.description,
      task.owner_id,
      task.owner_name,
      task.assigned_by,
      task.assigned_at,
      task.deadline,
      task.priority,
      task.status,
      task.detected_at,
      task.source_msg_id,
      task.last_nudge_at
    )
    .run();
  return task.id;
}

// ─── Task queries ─────────────────────────────────────────────────────────────

/** All non-done tasks in a channel, ordered by priority then detected_at. */
export async function getOpenTasksForChannel(
  teamId: string,
  channelId: string,
  env: Env
): Promise<TaskRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks
     WHERE team_id = ? AND channel_id = ? AND status != 'done'
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       detected_at ASC`
  )
    .bind(teamId, channelId)
    .all<TaskRow>();
  return result.results;
}

/** Tasks by owner across all channels (for "my tasks" view). */
export async function getTasksByOwner(
  ownerId: string,
  env: Env
): Promise<TaskRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks
     WHERE owner_id = ? AND status != 'done'
     ORDER BY deadline ASC NULLS LAST, detected_at ASC`
  )
    .bind(ownerId)
    .all<TaskRow>();
  return result.results;
}

/**
 * Tasks eligible for a nudge:
 *   - status != 'done'
 *   - last_nudge_at IS NULL OR last_nudge_at < now - cooldownSeconds
 *   - nudge_count < MAX_NUDGE_COUNT
 */
export async function getTasksNeedingNudge(
  cooldownSeconds: number,
  env: Env
): Promise<TaskRow[]> {
  const cutoff = Math.floor(Date.now() / 1000) - cooldownSeconds;
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks
     WHERE status != 'done'
       AND nudge_count < ?
       AND (last_nudge_at IS NULL OR last_nudge_at < ?)
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       detected_at ASC`
  )
    .bind(MAX_NUDGE_COUNT, cutoff)
    .all<TaskRow>();
  return result.results;
}

/** Tasks with deadlines within the next N hours (excluding done tasks). */
export async function getTasksDueWithin(hours: number, env: Env): Promise<TaskRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const horizon = now + hours * 3600;
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks
     WHERE deadline IS NOT NULL
       AND deadline <= ?
       AND deadline >= ?
       AND status != 'done'
     ORDER BY deadline ASC`
  )
    .bind(horizon, now)
    .all<TaskRow>();
  return result.results;
}

/** Tasks in a given thread (for deduplication during detection). */
export async function getTasksForThread(
  threadId: string,
  env: Env
): Promise<TaskRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM tasks WHERE thread_id = ? AND status != 'done'`
  )
    .bind(threadId)
    .all<TaskRow>();
  return result.results;
}

// ─── Task updates ─────────────────────────────────────────────────────────────

/** Update a task's status. */
export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  env: Env
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `UPDATE tasks SET status = ? WHERE id = ?`
  )
    .bind(status, taskId)
    .run();
}

/** Update a task's priority. */
export async function updateTaskPriority(
  taskId: string,
  priority: TaskPriority,
  env: Env
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `UPDATE tasks SET priority = ? WHERE id = ?`
  )
    .bind(priority, taskId)
    .run();
}

/**
 * Assign (or reassign) ownership of a task.
 * Atomically updates tasks.owner_* AND appends to ownership_history.
 */
export async function assignTaskOwner(
  taskId: string,
  ownerId: string | null,
  ownerName: string | null,
  assignedBy: string,
  reason: OwnershipReason,
  env: Env
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await env.ARCADIA_DB.batch([
    env.ARCADIA_DB.prepare(
      `UPDATE tasks
       SET owner_id = ?, owner_name = ?, assigned_by = ?, assigned_at = ?
       WHERE id = ?`
    ).bind(ownerId, ownerName, assignedBy, now, taskId),

    env.ARCADIA_DB.prepare(
      `INSERT INTO ownership_history
         (task_id, owner_id, owner_name, assigned_by, reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(taskId, ownerId, ownerName, assignedBy, reason, now),
  ]);
}

/**
 * Increment nudge_count and update last_nudge_at.
 * Called after a nudge message is successfully posted.
 */
export async function recordNudgeSent(taskId: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.ARCADIA_DB.prepare(
    `UPDATE tasks
     SET nudge_count = nudge_count + 1, last_nudge_at = ?
     WHERE id = ?`
  )
    .bind(now, taskId)
    .run();
}

// ─── Ownership history ────────────────────────────────────────────────────────

/** Full ownership audit trail for a task, newest first. */
export async function getOwnershipHistory(
  taskId: string,
  env: Env
): Promise<OwnershipHistoryRow[]> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM ownership_history
     WHERE task_id = ?
     ORDER BY occurred_at DESC`
  )
    .bind(taskId)
    .all<OwnershipHistoryRow>();
  return result.results;
}

// ─── Graph subscriptions ──────────────────────────────────────────────────────

/**
 * Upsert a Graph subscription record.
 * Called after createSubscription() or renewSubscription() succeeds.
 */
export async function upsertGraphSubscription(
  id: string,
  teamId: string,
  channelId: string,
  resource: string,
  expirationDatetime: number,
  clientState: string,
  env: Env,
  isRenewal = false
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (isRenewal) {
    await env.ARCADIA_DB.prepare(
      `UPDATE graph_subscriptions
       SET expiration_datetime = ?, renewed_at = ?
       WHERE id = ?`
    )
      .bind(expirationDatetime, now, id)
      .run();
  } else {
    await env.ARCADIA_DB.prepare(
      `INSERT INTO graph_subscriptions
         (id, team_id, channel_id, resource, expiration_datetime, client_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         expiration_datetime = excluded.expiration_datetime,
         renewed_at = ?`
    )
      .bind(id, teamId, channelId, resource, expirationDatetime, clientState, now, now)
      .run();
  }
}

/** Subscriptions expiring within the next `bufferSeconds` — need renewal. */
export async function getExpiringSubscriptions(
  bufferSeconds: number,
  env: Env
): Promise<import("../types.js").GraphSubscriptionRow[]> {
  const cutoff = Math.floor(Date.now() / 1000) + bufferSeconds;
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM graph_subscriptions WHERE expiration_datetime <= ?`
  )
    .bind(cutoff)
    .all<import("../types.js").GraphSubscriptionRow>();
  return result.results;
}

/** Look up a subscription by its Graph subscription ID. */
export async function getSubscriptionById(
  id: string,
  env: Env
): Promise<import("../types.js").GraphSubscriptionRow | null> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM graph_subscriptions WHERE id = ?`
  )
    .bind(id)
    .first<import("../types.js").GraphSubscriptionRow>();
  return result ?? null;
}

/** Delete a subscription record (after Graph DELETE or expiry). */
export async function deleteGraphSubscription(id: string, env: Env): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `DELETE FROM graph_subscriptions WHERE id = ?`
  )
    .bind(id)
    .run();
}

/** Find existing subscription for a channel. */
export async function getSubscriptionForChannel(
  teamId: string,
  channelId: string,
  env: Env
): Promise<import("../types.js").GraphSubscriptionRow | null> {
  const result = await env.ARCADIA_DB.prepare(
    `SELECT * FROM graph_subscriptions WHERE team_id = ? AND channel_id = ? LIMIT 1`
  )
    .bind(teamId, channelId)
    .first<import("../types.js").GraphSubscriptionRow>();
  return result ?? null;
}

// ─── Weekly report log ────────────────────────────────────────────────────────

/** Log a posted weekly report. */
export async function logWeeklyReport(
  teamId: string,
  channelId: string,
  weekStart: string,
  content: string,
  env: Env
): Promise<void> {
  await env.ARCADIA_DB.prepare(
    `INSERT INTO weekly_report_log (team_id, channel_id, week_start, posted_at, content)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(teamId, channelId, weekStart, Math.floor(Date.now() / 1000), content)
    .run();
}
