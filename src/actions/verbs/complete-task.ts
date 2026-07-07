// complete_task — mark a task done.
//
// Delegates to TaskStore.complete (status → 'done'). Returns
// 'task_not_found' when the id doesn't resolve.

import type { ActionVerb } from "../framework";
import { TaskStore } from "../../tasks/store";
import { asObject, reqString } from "./_util";

export interface CompleteTaskParams {
  taskId: string;
}

export const completeTaskVerb: ActionVerb<CompleteTaskParams> = {
  name: "complete_task",
  defaultLevel: "confirm",

  parse(raw): CompleteTaskParams {
    const o = asObject(raw);
    return { taskId: reqString(o, "taskId") };
  },

  describe(p): string {
    return `Complete task ${p.taskId}`;
  },

  async execute(ctx, p) {
    const store = new TaskStore(ctx.env);
    const done = await store.complete(p.taskId, "action:complete_task");
    if (!done) return { ok: false, error: "task_not_found" };
    return { ok: true, detail: { taskId: p.taskId, status: done.status } };
  },
};
