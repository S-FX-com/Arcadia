// assign_task — set or replace a task's owner.
//
// Delegates to TaskStore.assign, which flips owner_aad_id and appends an
// ownership_history row (the append-only audit trail). Returns
// 'task_not_found' when the id doesn't resolve.

import type { ActionVerb } from "../framework";
import { TaskStore } from "../../tasks/store";
import { asObject, reqString } from "./_util";

export interface AssignTaskParams {
  taskId: string;
  ownerAadId: string;
}

export const assignTaskVerb: ActionVerb<AssignTaskParams> = {
  name: "assign_task",
  defaultLevel: "confirm",

  parse(raw): AssignTaskParams {
    const o = asObject(raw);
    return {
      taskId: reqString(o, "taskId"),
      ownerAadId: reqString(o, "ownerAadId"),
    };
  },

  describe(p): string {
    return `Assign task ${p.taskId} to ${p.ownerAadId}`;
  },

  async execute(ctx, p) {
    const store = new TaskStore(ctx.env);
    const updated = await store.assign(
      p.taskId,
      p.ownerAadId,
      `assigned by ${ctx.actorAadId}`,
      "action:assign_task",
    );
    if (!updated) return { ok: false, error: "task_not_found" };
    return { ok: true, detail: { taskId: p.taskId, ownerAadId: p.ownerAadId } };
  },
};
