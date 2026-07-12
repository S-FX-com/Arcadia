// Action-policy store — the admin control plane for the capability ladder.
//
// EXECUTION-PLAN §Phase 5, D5. The action framework (framework.ts) reads
// the ladder level for a (verb, scope) via resolveLevel(); this store is
// the WRITE side an operator uses to configure that ladder. A row raises
// a verb above its fail-closed default in a given scope; removing the row
// reverts to the verb's defaultLevel.
//
// Deliberately thin and dependency-free — it owns only the action_policy
// table (0005). resolveLevel() lives in framework.ts and is not duplicated
// here; this module never decides a level, it only stores what an admin set.

import type { Env } from "../env";
import type { ActionScope, Ladder } from "./framework";

export type ActionScopeType = ActionScope["type"];

/** All ladder levels, in ascending order of autonomy. */
export const LADDER_LEVELS: readonly Ladder[] = [
  "observe",
  "draft",
  "confirm",
  "auto",
];

/** Scope types a policy row may target (mirrors ActionScope.type + 0005 CHECK). */
export const SCOPE_TYPES: readonly ActionScopeType[] = [
  "tenant",
  "channel",
  "chat",
  "user",
  "client",
];

export function isLadder(v: unknown): v is Ladder {
  return typeof v === "string" && (LADDER_LEVELS as string[]).includes(v);
}

export function isScopeType(v: unknown): v is ActionScopeType {
  return typeof v === "string" && (SCOPE_TYPES as string[]).includes(v);
}

export interface ActionPolicy {
  verb: string;
  scopeType: ActionScopeType;
  /** '*' = any scope of that type (wildcard). */
  scopeId: string;
  level: Ladder;
  updatedBy: string | null;
  updatedAt: string;
}

export interface SetPolicyInput {
  verb: string;
  scopeType: ActionScopeType;
  scopeId: string;
  level: Ladder;
  updatedBy: string;
}

interface PolicyRow {
  verb: string;
  scope_type: ActionScopeType;
  scope_id: string;
  level: Ladder;
  updated_by: string | null;
  updated_at: string;
}

function fromRow(row: PolicyRow): ActionPolicy {
  return {
    verb: row.verb,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    level: row.level,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export class ActionPolicyStore {
  constructor(private readonly env: Env) {}

  /** All configured policy rows, ordered for a stable admin table view. */
  async list(): Promise<ActionPolicy[]> {
    const rows = await this.env.ARCADIA_DB.prepare(
      `SELECT verb, scope_type, scope_id, level, updated_by, updated_at
         FROM action_policy
        ORDER BY verb ASC, scope_type ASC, scope_id ASC`,
    ).all<PolicyRow>();
    return rows.results.map(fromRow);
  }

  /**
   * Upsert a policy row (PK verb+scope_type+scope_id). Re-setting the same
   * key replaces its level and stamps updated_by/updated_at.
   */
  async set(input: SetPolicyInput): Promise<ActionPolicy> {
    const updatedAt = new Date().toISOString();
    await this.env.ARCADIA_DB.prepare(
      `INSERT INTO action_policy
         (verb, scope_type, scope_id, level, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(verb, scope_type, scope_id) DO UPDATE SET
         level = excluded.level,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
      .bind(
        input.verb,
        input.scopeType,
        input.scopeId,
        input.level,
        input.updatedBy,
        updatedAt,
      )
      .run();
    return {
      verb: input.verb,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      level: input.level,
      updatedBy: input.updatedBy,
      updatedAt,
    };
  }

  /**
   * Delete a policy row. The (verb, scope) reverts to the verb's
   * fail-closed defaultLevel. Returns true when a row was removed.
   */
  async remove(
    verb: string,
    scopeType: ActionScopeType,
    scopeId: string,
  ): Promise<boolean> {
    const res = await this.env.ARCADIA_DB.prepare(
      `DELETE FROM action_policy
        WHERE verb = ? AND scope_type = ? AND scope_id = ?`,
    )
      .bind(verb, scopeType, scopeId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}
