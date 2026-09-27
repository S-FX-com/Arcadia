// Refresh the group-owned plan index. Without Graph credentials the run
// is logged and the previous index is left alone — an empty read is not
// a reason to forget plans the page was showing.

import { openPlanIndexSession } from "../gatekeepers/plan-index";
import type { GatekeeperContext } from "../gatekeepers/types";
import { appendAudit } from "../lib/audit";
import { graphAvailable } from "../integrations/graph";

export interface PlanIndexResult {
  plansSeen: number;
  rosterOmitted: number;
  detail: string;
}

export async function refreshPlanIndex(env: Env, ctx: GatekeeperContext): Promise<PlanIndexResult> {
  const id = crypto.randomUUID();
  if (!graphAvailable(env)) {
    const detail = "Graph credentials are not configured. The plan index was not refreshed.";
    await env.DB.prepare(
      `INSERT INTO planner_index_runs (id, finished_at, plans_seen, roster_omitted, detail)
       VALUES (?1, ?2, 0, 0, ?3)`
    )
      .bind(id, new Date().toISOString(), detail)
      .run();
    return { plansSeen: 0, rosterOmitted: 0, detail };
  }

  const indexed = await openPlanIndexSession(env, ctx).index();
  const seen = new Date().toISOString();
  for (const row of indexed.rows) {
    await env.DB.prepare(
      `INSERT INTO planner_plan_index (plan_id, group_id, group_name, title, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(plan_id) DO UPDATE SET
         group_id = excluded.group_id,
         group_name = excluded.group_name,
         title = excluded.title,
         last_seen = excluded.last_seen`
    )
      .bind(row.planId, row.groupId, row.groupName, row.title, seen)
      .run();
  }
  if (indexed.rows.length > 0) {
    const ids = indexed.rows.map((row) => row.planId);
    const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
    await env.DB.prepare(`DELETE FROM planner_plan_index WHERE plan_id NOT IN (${placeholders})`)
      .bind(...ids)
      .run();
  }
  const detail = `${indexed.groupsWalked} Unified group(s), ${indexed.rows.length} plan(s), ${indexed.rosterOmitted} omitted.`;
  await env.DB.prepare(
    `INSERT INTO planner_index_runs (id, finished_at, plans_seen, roster_omitted, detail)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(id, seen, indexed.rows.length, indexed.rosterOmitted, detail)
    .run();
  await appendAudit(env.DB, { actor: ctx.actor, action: "plan_index_refreshed", subject: id, detail });
  return { plansSeen: indexed.rows.length, rosterOmitted: indexed.rosterOmitted, detail };
}
