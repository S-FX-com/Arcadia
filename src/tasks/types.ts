// Task domain types.
//
// `Task` mirrors the columns of the `tasks` table. `NewTask` is the
// shape accepted by the store on create — id, timestamps, and status
// are filled in by the store. Ownership transitions are tracked
// separately in `ownership_history` (see store.assign / store.update).

export type Priority = "low" | "normal" | "high" | "urgent";

export type Status =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

export interface Task {
  id: string;
  channelId?: string;
  chatId?: string;
  threadId?: string;
  title: string;
  description?: string;
  ownerAadId?: string;
  createdByAadId?: string;
  deadlineAt?: string;
  priority: Priority;
  status: Status;
  plannerTaskId?: string;
  lastNudgeAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  channelId?: string;
  chatId?: string;
  threadId?: string;
  title: string;
  description?: string;
  ownerAadId?: string;
  createdByAadId?: string;
  deadlineAt?: string;
  priority?: Priority;
  status?: Status;
  plannerTaskId?: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  deadlineAt?: string | null;
  priority?: Priority;
  status?: Status;
  plannerTaskId?: string | null;
  lastNudgeAt?: string | null;
}

export interface OwnershipEvent {
  id: number;
  taskId: string;
  fromAadId?: string;
  toAadId: string;
  reason?: string;
  source: string;
  occurredAt: string;
}

export interface TaskListFilter {
  channelId?: string;
  chatId?: string;
  ownerAadId?: string;
  status?: Status | Status[];
  priority?: Priority | Priority[];
  dueBefore?: string;
  limit?: number;
}
