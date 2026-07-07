// create_task — create an Arcadia-native task, optionally mirrored to
// Microsoft Planner.
//
// The task always lands in the D1 `tasks` table (TaskStore.create, which
// also writes the initial ownership_history row when an owner is set).
// When a plannerPlanId is supplied the row is additionally pushed to
// Planner via planner-sync.pushTask, which stamps the returned
// planner_task_id back onto the row. The Planner push is a best-effort
// side channel: pushTask swallows Graph failures and returns null.

import type { ActionVerb } from "../framework";
import { pushTask } from "../../tasks/planner-sync";
import { TaskStore } from "../../tasks/store";
import type { NewTask, Priority } from "../../tasks/types";
import { asObject, clip, optString, reqString, type PushTaskFn } from "./_util";

const PRIORITIES: readonly Priority[] = ["low", "normal", "high", "urgent"];

function parsePriority(raw: string | undefined): Priority | undefined {
  if (raw === undefined) return undefined;
  if (!(PRIORITIES as readonly string[]).includes(raw)) {
    throw new Error(`invalid priority: ${raw}`);
  }
  return raw as Priority;
}

export interface CreateTaskParams {
  title: string;
  ownerAadId?: string;
  channelId?: string;
  deadlineAt?: string;
  priority?: Priority;
  description?: string;
  plannerPlanId?: string;
  plannerBucketId?: string;
}

export interface CreateTaskDeps {
  pushTask: PushTaskFn;
}

export function makeCreateTaskVerb(
  deps: CreateTaskDeps = { pushTask },
): ActionVerb<CreateTaskParams> {
  return {
    name: "create_task",
    defaultLevel: "confirm",

    parse(raw): CreateTaskParams {
      const o = asObject(raw);
      const title = reqString(o, "title");
      const ownerAadId = optString(o, "ownerAadId");
      const channelId = optString(o, "channelId");
      const deadlineAt = optString(o, "deadlineAt");
      const priority = parsePriority(optString(o, "priority"));
      const description = optString(o, "description");
      const plannerPlanId = optString(o, "plannerPlanId");
      const plannerBucketId = optString(o, "plannerBucketId");
      return {
        title,
        ...(ownerAadId ? { ownerAadId } : {}),
        ...(channelId ? { channelId } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(priority ? { priority } : {}),
        ...(description ? { description } : {}),
        ...(plannerPlanId ? { plannerPlanId } : {}),
        ...(plannerBucketId ? { plannerBucketId } : {}),
      };
    },

    describe(p): string {
      const owner = p.ownerAadId ? ` for ${p.ownerAadId}` : "";
      return `Create task "${clip(p.title)}"${owner}`;
    },

    async execute(ctx, p) {
      const store = new TaskStore(ctx.env);
      const newTask: NewTask = {
        title: p.title,
        createdByAadId: ctx.actorAadId,
        ...(p.ownerAadId ? { ownerAadId: p.ownerAadId } : {}),
        ...(p.channelId ? { channelId: p.channelId } : {}),
        ...(p.deadlineAt ? { deadlineAt: p.deadlineAt } : {}),
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.description ? { description: p.description } : {}),
      };
      const task = await store.create(newTask, "action:create_task");

      let plannerTaskId: string | null = null;
      if (p.plannerPlanId) {
        plannerTaskId = await deps.pushTask(
          ctx.env,
          task,
          {
            planId: p.plannerPlanId,
            ...(p.plannerBucketId ? { bucketId: p.plannerBucketId } : {}),
          },
          ctx.log,
        );
      }

      return {
        ok: true,
        detail: {
          taskId: task.id,
          ...(plannerTaskId ? { plannerTaskId } : {}),
        },
      };
    },
  };
}

export const createTaskVerb = makeCreateTaskVerb();
