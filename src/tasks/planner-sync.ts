// Bi-directional Microsoft Planner sync.
//
// `pullForOwner(env, ownerAadId)` walks the Planner tasks a user owns
// (via /me/planner/tasks for delegated, or /users/{id}/planner/tasks
// for app-only) and reflects each Planner task into Arcadia's `tasks`
// table, keyed by `planner_task_id`. New Planner tasks become Arcadia
// rows; existing rows are updated with the latest title / dueDateTime
// / percentComplete.
//
// `pushTask(env, task)` mirrors an Arcadia-native task back to Planner.
// It picks the configured plan + bucket (resolution lands when the
// charter store ships its plan-id mapping); for now planId/bucketId
// arrive as arguments.
//
// Planner permissions: `Tasks.ReadWrite.All` for app-only, or
// `Group.ReadWrite.All` for tasks tied to a plan in a group. The Graph
// client is configured upstream — this module only formats requests.

import type { Env } from "../env";
import type { Logger } from "../lib/logger";
import { graph } from "../graph/client";
import type { Priority, Status, Task } from "./types";
import { TaskStore } from "./store";

interface PlannerTask {
  id: string;
  planId: string;
  bucketId?: string;
  title: string;
  dueDateTime?: string;
  startDateTime?: string;
  percentComplete: number;
  priority: number;
  assignments: Record<string, PlannerAssignment>;
  createdBy?: { user?: { id?: string } };
  createdDateTime?: string;
}

interface PlannerAssignment {
  assignedBy?: { user?: { id?: string } };
  assignedDateTime?: string;
  orderHint?: string;
}

interface PlannerPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface PullResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
}

export async function pullForOwner(
  env: Env,
  ownerAadId: string,
  log: Logger,
): Promise<PullResult> {
  const store = new TaskStore(env);
  const result: PullResult = { fetched: 0, created: 0, updated: 0, skipped: 0 };

  let nextUrl: string | undefined;
  do {
    let page: PlannerPage<PlannerTask>;
    try {
      page = nextUrl
        ? await graph<PlannerPage<PlannerTask>>(env, { path: nextUrl })
        : await graph<PlannerPage<PlannerTask>>(env, {
            path: `/users/${ownerAadId}/planner/tasks`,
            query: { $top: 50 },
          });
    } catch (e) {
      log.warn("planner_pull_failed", { ownerAadId, error: String(e) });
      return result;
    }

    for (const pt of page.value) {
      result.fetched += 1;
      try {
        await reflect(store, pt, ownerAadId, result);
      } catch (e) {
        result.skipped += 1;
        log.warn("planner_reflect_failed", {
          plannerTaskId: pt.id,
          error: String(e),
        });
      }
    }

    nextUrl = page["@odata.nextLink"];
  } while (nextUrl);

  log.info("planner_pull", { ownerAadId, ...result });
  return result;
}

async function reflect(
  store: TaskStore,
  pt: PlannerTask,
  ownerAadId: string,
  result: PullResult,
): Promise<void> {
  const status = statusFromPercent(pt.percentComplete);
  const priority = priorityFromPlanner(pt.priority);

  const existing = await store.byPlannerId(pt.id);
  if (existing) {
    await store.update(existing.id, {
      title: pt.title,
      priority,
      status,
      ...(pt.dueDateTime !== undefined
        ? { deadlineAt: pt.dueDateTime || null }
        : {}),
    });
    result.updated += 1;
    return;
  }

  await store.create(
    {
      title: pt.title,
      priority,
      status,
      ownerAadId,
      plannerTaskId: pt.id,
      ...(pt.createdBy?.user?.id
        ? { createdByAadId: pt.createdBy.user.id }
        : {}),
      ...(pt.dueDateTime ? { deadlineAt: pt.dueDateTime } : {}),
    },
    "planner_sync",
  );
  result.created += 1;
}

function statusFromPercent(percent: number): Status {
  if (percent >= 100) return "done";
  if (percent > 0) return "in_progress";
  return "open";
}

function percentFromStatus(status: Status): number {
  switch (status) {
    case "done":
      return 100;
    case "in_progress":
      return 50;
    case "cancelled":
      return 100;
    default:
      return 0;
  }
}

// Planner priority is a 1–10 scale: 1=urgent, 3=high, 5=normal/medium,
// 9=low. We round to the nearest of Arcadia's four buckets.
function priorityFromPlanner(p: number): Priority {
  if (p <= 1) return "urgent";
  if (p <= 4) return "high";
  if (p <= 7) return "normal";
  return "low";
}

function priorityToPlanner(p: Priority): number {
  switch (p) {
    case "urgent":
      return 1;
    case "high":
      return 3;
    case "normal":
      return 5;
    case "low":
      return 9;
  }
}

export interface PushOpts {
  planId: string;
  bucketId?: string;
}

export async function pushTask(
  env: Env,
  task: Task,
  opts: PushOpts,
  log: Logger,
): Promise<string | null> {
  if (task.plannerTaskId) {
    await patchPlanner(env, task, log);
    return task.plannerTaskId;
  }

  try {
    const body: Record<string, unknown> = {
      planId: opts.planId,
      title: task.title,
      priority: priorityToPlanner(task.priority),
      percentComplete: percentFromStatus(task.status),
      ...(opts.bucketId ? { bucketId: opts.bucketId } : {}),
      ...(task.deadlineAt ? { dueDateTime: task.deadlineAt } : {}),
      ...(task.ownerAadId
        ? {
            assignments: {
              [task.ownerAadId]: {
                "@odata.type": "#microsoft.graph.plannerAssignment",
                orderHint: " !",
              },
            },
          }
        : {}),
    };

    const created = await graph<PlannerTask>(env, {
      method: "POST",
      path: "/planner/tasks",
      body,
    });

    const store = new TaskStore(env);
    await store.update(task.id, { plannerTaskId: created.id });
    log.info("planner_push_created", {
      taskId: task.id,
      plannerTaskId: created.id,
    });
    return created.id;
  } catch (e) {
    log.warn("planner_push_failed", { taskId: task.id, error: String(e) });
    return null;
  }
}

async function patchPlanner(env: Env, task: Task, log: Logger): Promise<void> {
  try {
    await graph(env, {
      method: "PATCH",
      path: `/planner/tasks/${task.plannerTaskId}`,
      headers: { "If-Match": "*" },
      body: {
        title: task.title,
        priority: priorityToPlanner(task.priority),
        percentComplete: percentFromStatus(task.status),
        ...(task.deadlineAt ? { dueDateTime: task.deadlineAt } : {}),
      },
    });
  } catch (e) {
    log.warn("planner_patch_failed", {
      taskId: task.id,
      plannerTaskId: task.plannerTaskId,
      error: String(e),
    });
  }
}
