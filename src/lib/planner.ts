// Planner board shaping for the Objectives surface.
//
// Planner is the system of record for task state (CLAUDE.md §10, resolved
// question 1) — this module never invents state, it only arranges what Graph
// returned: which tasks count as open, which are overdue, which belong to the
// signed-in Specialist, and what order a human reads them in. Free of
// Cloudflare imports so every rule here is directly testable; the date math
// especially, because "overdue" is an accountability word and a task flagged
// overdue on its own due day teaches the team to ignore the flag.

import type { PlannerBoard, PlannerBucket, PlannerTaskDetail } from "../gatekeepers/graph";

export type TaskState = "not_started" | "in_progress" | "done";

export function taskState(task: Pick<PlannerTaskDetail, "percentComplete">): TaskState {
  if (task.percentComplete >= 100) return "done";
  return task.percentComplete > 0 ? "in_progress" : "not_started";
}

/**
 * Whole days between two instants, on the UTC calendar. Planner due dates are
 * midnight-UTC datetimes, so calendar comparison is the one that matches what
 * the person who set the date meant: due "today" is not overdue at lunch.
 */
export function calendarDaysUntil(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

/** Overdue: the due day has fully passed and the task is not done. */
export function isOverdue(
  task: Pick<PlannerTaskDetail, "percentComplete" | "dueDateTime">,
  now: Date
): boolean {
  if (!task.dueDateTime || taskState(task) === "done") return false;
  return calendarDaysUntil(now, new Date(task.dueDateTime)) < 0;
}

/**
 * Planner's documented priority bands: 0–1 urgent, 2–4 important, 5–7 medium,
 * 8–10 low. Medium is the default and low is a whisper — only the two bands
 * that ask for attention render as tags, or every row grows a label.
 */
export function priorityLabel(priority: number): "urgent" | "important" | undefined {
  if (priority <= 1) return "urgent";
  if (priority <= 4) return "important";
  return undefined;
}

export function isAssignedTo(task: Pick<PlannerTaskDetail, "assigneeIds">, aadId: string): boolean {
  return task.assigneeIds.includes(aadId);
}

/** The one-line reading of a due date. Never a bare number without its unit. */
export function dueLabel(
  task: Pick<PlannerTaskDetail, "percentComplete" | "dueDateTime">,
  now: Date
): string {
  if (!task.dueDateTime) return "no due date";
  const days = calendarDaysUntil(now, new Date(task.dueDateTime));
  if (taskState(task) === "done") return `was due ${task.dueDateTime.slice(0, 10)}`;
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} overdue`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days <= 14) return `due in ${days} days`;
  return `due ${task.dueDateTime.slice(0, 10)}`;
}

export interface TeamRollup {
  total: number;
  open: number;
  done: number;
  overdue: number;
  /** Open tasks nobody is assigned to — work that cannot ping anyone. */
  unassigned: number;
  /** Open tasks assigned to the viewer; 0 when their id is unknown. */
  mine: number;
}

export function rollup(tasks: PlannerTaskDetail[], now: Date, aadId?: string): TeamRollup {
  const open = tasks.filter((t) => taskState(t) !== "done");
  return {
    total: tasks.length,
    open: open.length,
    done: tasks.length - open.length,
    overdue: open.filter((t) => isOverdue(t, now)).length,
    unassigned: open.filter((t) => t.assigneeIds.length === 0).length,
    mine: aadId ? open.filter((t) => isAssignedTo(t, aadId)).length : 0,
  };
}

/**
 * Reading order for a board: overdue first (most overdue at the top), then
 * dated work by due date, then undated work oldest-first — an undated task
 * that has sat for a month is closer to a stall than one from this morning.
 */
export function boardOrder(a: PlannerTaskDetail, b: PlannerTaskDetail, now: Date): number {
  const aOver = isOverdue(a, now);
  const bOver = isOverdue(b, now);
  if (aOver !== bOver) return aOver ? -1 : 1;
  if (a.dueDateTime && b.dueDateTime && a.dueDateTime !== b.dueDateTime) {
    return a.dueDateTime < b.dueDateTime ? -1 : 1;
  }
  if (!a.dueDateTime !== !b.dueDateTime) return a.dueDateTime ? -1 : 1;
  if (!a.dueDateTime && a.createdDateTime !== b.createdDateTime) {
    return a.createdDateTime < b.createdDateTime ? -1 : 1;
  }
  return a.title.localeCompare(b.title);
}

export interface BucketGroup {
  id: string;
  name: string;
  tasks: PlannerTaskDetail[];
}

/**
 * Open tasks grouped under their buckets, in the plan's own bucket order.
 * Buckets with nothing open are dropped — a row of nothing says nothing — and
 * a task whose bucket no longer exists lands in a trailing "(no bucket)"
 * group rather than vanishing.
 */
export function groupByBucket(board: PlannerBoard, now: Date): BucketGroup[] {
  const open = board.tasks.filter((t) => taskState(t) !== "done").sort((a, b) => boardOrder(a, b, now));
  const known = new Set(board.buckets.map((b: PlannerBucket) => b.id));
  const groups = board.buckets.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    tasks: open.filter((t) => t.bucketId === bucket.id),
  }));
  const orphaned = open.filter((t) => !t.bucketId || !known.has(t.bucketId));
  if (orphaned.length > 0) groups.push({ id: "none", name: "(no bucket)", tasks: orphaned });
  return groups.filter((g) => g.tasks.length > 0);
}

/** Bucket-name lookup for rendering a task outside its board. */
export function bucketNames(board: PlannerBoard): Map<string, string> {
  return new Map(board.buckets.map((b) => [b.id, b.name]));
}
