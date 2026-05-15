// Tasks store on D1.
//
// Owns the `tasks` and `ownership_history` tables. Every ownership
// transition writes a row to `ownership_history` — that table is
// append-only and is the audit trail. The store exposes:
//
//   create(input)        insert + initial ownership row when owner set
//   byId(id)             lookup
//   list(filter)         filtered query
//   update(id, patch)    partial update; touches updated_at
//   assign(id, ...)      change owner (writes ownership_history)
//   complete(id)         status = 'done'
//   cancel(id)           status = 'cancelled'
//   snooze(id)           last_nudge_at = now
//   ownershipHistory(id) chronological log
//   recentCollaborators  people who have owned this task before
//
// Domain objects (`Task`, `Priority`, `Status`, …) live in `./types`.
// The store handles the row ↔ object mapping and never leaks SQL.

import type { Env } from "../env";
import type {
  NewTask,
  OwnershipEvent,
  Priority,
  Status,
  Task,
  TaskListFilter,
  TaskPatch,
} from "./types";

export class TaskStore {
  constructor(private readonly env: Env) {}

  async create(input: NewTask, source: string = "store"): Promise<Task> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const priority: Priority = input.priority ?? "normal";
    const status: Status = input.status ?? "open";

    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO tasks (
         id, channel_id, chat_id, thread_id, title, description,
         owner_aad_id, created_by_aad_id, deadline_at, priority, status,
         planner_task_id, last_nudge_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
      .bind(
        id,
        input.channelId ?? null,
        input.chatId ?? null,
        input.threadId ?? null,
        input.title,
        input.description ?? null,
        input.ownerAadId ?? null,
        input.createdByAadId ?? null,
        input.deadlineAt ?? null,
        priority,
        status,
        input.plannerTaskId ?? null,
        now,
        now,
      )
      .run();

    if (input.ownerAadId) {
      await this.writeOwnership(
        id,
        null,
        input.ownerAadId,
        input.createdByAadId === input.ownerAadId
          ? "self-assigned at creation"
          : "assigned at creation",
        source,
        now,
      );
    }

    const created = await this.byId(id);
    if (!created) throw new Error("task_create_lost");
    return created;
  }

  async byId(id: string): Promise<Task | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM tasks WHERE id = ?`,
    )
      .bind(id)
      .first<TaskRow>();
    return row ? fromRow(row) : null;
  }

  async byPlannerId(plannerTaskId: string): Promise<Task | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM tasks WHERE planner_task_id = ?`,
    )
      .bind(plannerTaskId)
      .first<TaskRow>();
    return row ? fromRow(row) : null;
  }

  async list(filter: TaskListFilter = {}): Promise<Task[]> {
    const clauses: string[] = [];
    const binds: (string | number)[] = [];

    if (filter.channelId) {
      clauses.push("channel_id = ?");
      binds.push(filter.channelId);
    }
    if (filter.chatId) {
      clauses.push("chat_id = ?");
      binds.push(filter.chatId);
    }
    if (filter.ownerAadId) {
      clauses.push("owner_aad_id = ?");
      binds.push(filter.ownerAadId);
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
      binds.push(...statuses);
    }
    if (filter.priority) {
      const priorities = Array.isArray(filter.priority)
        ? filter.priority
        : [filter.priority];
      clauses.push(`priority IN (${priorities.map(() => "?").join(",")})`);
      binds.push(...priorities);
    }
    if (filter.dueBefore) {
      clauses.push("deadline_at IS NOT NULL AND deadline_at <= ?");
      binds.push(filter.dueBefore);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;

    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM tasks ${where}
        ORDER BY
          CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1
                      WHEN 'open' THEN 2 ELSE 3 END,
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'normal' THEN 2 ELSE 3 END,
          deadline_at IS NULL,
          deadline_at
        LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<TaskRow>();
    return rows.results.map(fromRow);
  }

  async update(
    id: string,
    patch: TaskPatch,
    source: string = "store",
  ): Promise<Task | null> {
    const existing = await this.byId(id);
    if (!existing) return null;

    const sets: string[] = [];
    const binds: (string | number | null)[] = [];

    if (patch.title !== undefined) {
      sets.push("title = ?");
      binds.push(patch.title);
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      binds.push(patch.description);
    }
    if (patch.deadlineAt !== undefined) {
      sets.push("deadline_at = ?");
      binds.push(patch.deadlineAt);
    }
    if (patch.priority !== undefined) {
      sets.push("priority = ?");
      binds.push(patch.priority);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      binds.push(patch.status);
    }
    if (patch.plannerTaskId !== undefined) {
      sets.push("planner_task_id = ?");
      binds.push(patch.plannerTaskId);
    }
    if (patch.lastNudgeAt !== undefined) {
      sets.push("last_nudge_at = ?");
      binds.push(patch.lastNudgeAt);
    }

    if (sets.length === 0) return existing;

    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    binds.push(now);

    await this.env.ARCADIA_DB.prepare(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds, id)
      .run();

    // Note: ownership changes are NOT done via update() — callers use
    // assign(). update() ignores any owner change attempt.
    return this.byId(id);
  }

  async assign(
    id: string,
    toAadId: string,
    reason: string,
    source: string = "store",
  ): Promise<Task | null> {
    const existing = await this.byId(id);
    if (!existing) return null;
    if (existing.ownerAadId === toAadId) return existing;

    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `UPDATE tasks SET owner_aad_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(toAadId, now, id)
      .run();

    await this.writeOwnership(
      id,
      existing.ownerAadId ?? null,
      toAadId,
      reason,
      source,
      now,
    );

    return this.byId(id);
  }

  async complete(
    id: string,
    source: string = "store",
  ): Promise<Task | null> {
    return this.transitionStatus(id, "done", source);
  }

  async cancel(id: string, source: string = "store"): Promise<Task | null> {
    return this.transitionStatus(id, "cancelled", source);
  }

  async snooze(id: string): Promise<Task | null> {
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `UPDATE tasks SET last_nudge_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(now, now, id)
      .run();
    return this.byId(id);
  }

  async ownershipHistory(taskId: string): Promise<OwnershipEvent[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT id, task_id, from_aad_id, to_aad_id, reason, source, occurred_at
         FROM ownership_history
        WHERE task_id = ?
        ORDER BY occurred_at ASC, id ASC`,
    )
      .bind(taskId)
      .all<OwnershipRow>();
    return rows.results.map(fromOwnershipRow);
  }

  async recentCollaborators(taskId: string): Promise<string[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT DISTINCT to_aad_id FROM ownership_history
        WHERE task_id = ?`,
    )
      .bind(taskId)
      .all<{ to_aad_id: string }>();
    return rows.results.map((r) => r.to_aad_id);
  }

  private async transitionStatus(
    id: string,
    status: Status,
    _source: string,
  ): Promise<Task | null> {
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(status, now, id)
      .run();
    return this.byId(id);
  }

  private async writeOwnership(
    taskId: string,
    fromAadId: string | null,
    toAadId: string,
    reason: string,
    source: string,
    occurredAt: string,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO ownership_history (task_id, from_aad_id, to_aad_id, reason, source, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(taskId, fromAadId, toAadId, reason, source, occurredAt)
      .run();
  }
}

interface TaskRow {
  id: string;
  channel_id: string | null;
  chat_id: string | null;
  thread_id: string | null;
  title: string;
  description: string | null;
  owner_aad_id: string | null;
  created_by_aad_id: string | null;
  deadline_at: string | null;
  priority: string;
  status: string;
  planner_task_id: string | null;
  last_nudge_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnershipRow {
  id: number;
  task_id: string;
  from_aad_id: string | null;
  to_aad_id: string;
  reason: string | null;
  source: string;
  occurred_at: string;
}

function fromRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    priority: r.priority as Priority,
    status: r.status as Status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.channel_id ? { channelId: r.channel_id } : {}),
    ...(r.chat_id ? { chatId: r.chat_id } : {}),
    ...(r.thread_id ? { threadId: r.thread_id } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.owner_aad_id ? { ownerAadId: r.owner_aad_id } : {}),
    ...(r.created_by_aad_id ? { createdByAadId: r.created_by_aad_id } : {}),
    ...(r.deadline_at ? { deadlineAt: r.deadline_at } : {}),
    ...(r.planner_task_id ? { plannerTaskId: r.planner_task_id } : {}),
    ...(r.last_nudge_at ? { lastNudgeAt: r.last_nudge_at } : {}),
  };
}

function fromOwnershipRow(r: OwnershipRow): OwnershipEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    toAadId: r.to_aad_id,
    source: r.source,
    occurredAt: r.occurred_at,
    ...(r.from_aad_id ? { fromAadId: r.from_aad_id } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  };
}
