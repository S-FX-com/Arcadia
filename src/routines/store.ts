// Routines store on D1.
//
// Owns the `routines` and `routine_runs` tables. Validates routine
// definitions via ./definition.ts on the way in so a bad routine is
// rejected at write time rather than at trigger time.

import type { Env } from "../env";
import {
  parseDefinition,
  type RoutineDef,
  type Trigger,
} from "./definition";

export interface RoutineRecord {
  id: string;
  ownerAadId: string;
  name: string;
  description?: string;
  trigger: Trigger;
  definition: RoutineDef;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRunRecord {
  id: string;
  routineId: string;
  triggerKind: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  output?: unknown;
  error?: string;
}

interface RoutineRow {
  id: string;
  owner_aad_id: string;
  name: string;
  description: string | null;
  trigger_json: string;
  steps_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  trigger_kind: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  output_json: string | null;
  error: string | null;
}

export class RoutineStore {
  constructor(private readonly env: Env) {}

  async create(
    ownerAadId: string,
    def: unknown,
    enabled = true,
  ): Promise<RoutineRecord> {
    const parsed = parseDefinition(def);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO routines (
         id, owner_aad_id, name, description, trigger_json, steps_json,
         enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        ownerAadId,
        parsed.name,
        parsed.description ?? null,
        JSON.stringify(parsed.trigger),
        JSON.stringify(parsed.steps),
        enabled ? 1 : 0,
        now,
        now,
      )
      .run();
    return {
      id,
      ownerAadId,
      name: parsed.name,
      trigger: parsed.trigger,
      definition: parsed,
      enabled,
      createdAt: now,
      updatedAt: now,
      ...(parsed.description ? { description: parsed.description } : {}),
    };
  }

  async update(
    id: string,
    patch: { def?: unknown; enabled?: boolean },
  ): Promise<RoutineRecord | null> {
    const existing = await this.byId(id);
    if (!existing) return null;

    const sets: string[] = [];
    const binds: (string | number | null)[] = [];

    if (patch.def !== undefined) {
      const parsed = parseDefinition(patch.def);
      sets.push("name = ?", "description = ?", "trigger_json = ?", "steps_json = ?");
      binds.push(
        parsed.name,
        parsed.description ?? null,
        JSON.stringify(parsed.trigger),
        JSON.stringify(parsed.steps),
      );
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      binds.push(patch.enabled ? 1 : 0);
    }
    if (sets.length === 0) return existing;

    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    binds.push(now);
    await this.env.ARCADIA_DB.prepare(
      `UPDATE routines SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds, id)
      .run();
    return this.byId(id);
  }

  async delete(id: string): Promise<void> {
    await this.env.ARCADIA_DB.prepare(`DELETE FROM routines WHERE id = ?`)
      .bind(id)
      .run();
  }

  async byId(id: string): Promise<RoutineRecord | null> {
    const row = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM routines WHERE id = ?`,
    )
      .bind(id)
      .first<RoutineRow>();
    return row ? fromRow(row) : null;
  }

  async listByOwner(
    ownerAadId: string,
    enabledOnly = false,
  ): Promise<RoutineRecord[]> {
    const stmt = enabledOnly
      ? this.env.ARCADIA_DB.prepare(
          `SELECT * FROM routines WHERE owner_aad_id = ? AND enabled = 1 ORDER BY created_at DESC`,
        ).bind(ownerAadId)
      : this.env.ARCADIA_DB.prepare(
          `SELECT * FROM routines WHERE owner_aad_id = ? ORDER BY created_at DESC`,
        ).bind(ownerAadId);
    const rows = await stmt.all<RoutineRow>();
    return rows.results.map(fromRow);
  }

  async listEnabledByCron(cron: string): Promise<RoutineRecord[]> {
    // SQLite has json_extract; use it to filter without parsing every
    // row in memory. trigger_json is small so the cost is fine either
    // way; this just keeps the call site clean.
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM routines
        WHERE enabled = 1
          AND json_extract(trigger_json, '$.kind') = 'cron'
          AND json_extract(trigger_json, '$.cron') = ?`,
    )
      .bind(cron)
      .all<RoutineRow>();
    return rows.results.map(fromRow);
  }

  async listEnabledByEvent(resource: string): Promise<RoutineRecord[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM routines
        WHERE enabled = 1
          AND json_extract(trigger_json, '$.kind') = 'event'
          AND json_extract(trigger_json, '$.resource') = ?`,
    )
      .bind(resource)
      .all<RoutineRow>();
    return rows.results.map(fromRow);
  }

  async startRun(
    routineId: string,
    triggerKind: string,
  ): Promise<RoutineRunRecord> {
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO routine_runs (id, routine_id, trigger_kind, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
      .bind(id, routineId, triggerKind, startedAt)
      .run();
    return {
      id,
      routineId,
      triggerKind,
      startedAt,
      status: "running",
    };
  }

  async finishRun(
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    output?: unknown,
    error?: string,
  ): Promise<void> {
    await this.env.ARCADIA_DB.prepare(
      `UPDATE routine_runs
          SET status = ?, finished_at = ?, output_json = ?, error = ?
        WHERE id = ?`,
    )
      .bind(
        status,
        new Date().toISOString(),
        output !== undefined ? JSON.stringify(output) : null,
        error ?? null,
        runId,
      )
      .run();
  }

  async recentRuns(
    routineId: string,
    limit = 20,
  ): Promise<RoutineRunRecord[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT * FROM routine_runs
        WHERE routine_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
      .bind(routineId, limit)
      .all<RoutineRunRow>();
    return rows.results.map(fromRunRow);
  }
}

function fromRow(r: RoutineRow): RoutineRecord {
  const trigger = JSON.parse(r.trigger_json) as Trigger;
  const steps = JSON.parse(r.steps_json) as RoutineDef["steps"];
  return {
    id: r.id,
    ownerAadId: r.owner_aad_id,
    name: r.name,
    trigger,
    definition: {
      name: r.name,
      trigger,
      steps,
      ...(r.description ? { description: r.description } : {}),
    },
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.description ? { description: r.description } : {}),
  };
}

function fromRunRow(r: RoutineRunRow): RoutineRunRecord {
  return {
    id: r.id,
    routineId: r.routine_id,
    triggerKind: r.trigger_kind,
    startedAt: r.started_at,
    status: r.status as RoutineRunRecord["status"],
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
    ...(r.output_json
      ? (() => {
          try {
            return { output: JSON.parse(r.output_json) as unknown };
          } catch {
            return { output: r.output_json };
          }
        })()
      : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}
