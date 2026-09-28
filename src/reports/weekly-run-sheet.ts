// Build one client's weekly run-sheet from the bindings frozen at mint.
// Stored in D1. Not sent anywhere. A later MCP can read the row.

import { freezeRunSheetScope, openRunSheetSession, type RunSheetBindingRow } from "../gatekeepers/run-sheet";
import type { GatekeeperContext } from "../gatekeepers/types";
import { appendAudit } from "../lib/audit";
import { assembleRunSheet, weekBounds, type LoopFact, type RunSheetTask } from "../lib/run-sheet";

interface SheetRow {
  payload: string;
}

function previousTasks(payload: string | undefined): RunSheetTask[] | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { planner?: Array<{ changes?: Array<{ title?: string }> }> };
    // Prior changes are not a full task snapshot. Pass null-equivalent by
    // reconstructing only what the diff needs when the payload carries tasks.
    const tasks = (parsed as { tasks?: RunSheetTask[] }).tasks;
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return null;
  }
}

export async function writeClientRunSheet(
  env: Env,
  ctx: GatekeeperContext,
  clientId: string,
  now = new Date()
): Promise<{ id: string; weekStart: string } | { error: string }> {
  const client = await env.DB.prepare(`SELECT id, name, status FROM clients WHERE id = ?1`)
    .bind(clientId)
    .first<{ id: string; name: string; status: string }>();
  if (!client || client.status === "offboarded") return { error: "no active workspace" };

  const bindings = (
    await env.DB.prepare(
      `SELECT type, external_id, label FROM client_bindings WHERE client_id = ?1`
    )
      .bind(clientId)
      .all<RunSheetBindingRow>()
  ).results;
  const loops = (
    await env.DB.prepare(`SELECT label, url FROM client_loop_bindings WHERE client_id = ?1 ORDER BY added_at`)
      .bind(clientId)
      .all<LoopFact>()
  ).results;

  const { weekStart, weekEnd } = weekBounds(now);
  const scope = freezeRunSheetScope(clientId, bindings, loops, weekStart, weekEnd);
  const prior = await env.DB.prepare(
    `SELECT payload FROM client_run_sheets WHERE client_id = ?1 AND week_start < ?2 ORDER BY week_start DESC LIMIT 1`
  )
    .bind(clientId, weekStart)
    .first<SheetRow>();

  const session = openRunSheetSession(env, ctx, scope);
  const [planner, channels, folders] = await Promise.all([
    session.planner(),
    session.channels(),
    session.folders(),
  ]);
  const currentTasks = planner.flatMap((plan) => plan.tasks);
  const { payload, rendered } = assembleRunSheet({
    clientName: client.name,
    weekStart,
    weekEnd,
    generatedAt: now.toISOString(),
    previousTasks: previousTasks(prior?.payload),
    planner,
    channels,
    folders,
    loops: session.loops(),
  });
  // Keep the task snapshot beside the rendered changes so next week's diff
  // can see state, due, and assignees. The rendered sheet does not grade anyone.
  const stored = { ...payload, tasks: currentTasks };
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO client_run_sheets (id, client_id, week_start, payload, rendered, generated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(client_id, week_start) DO UPDATE SET
       payload = excluded.payload,
       rendered = excluded.rendered,
       generated_at = excluded.generated_at`
  )
    .bind(id, clientId, weekStart, JSON.stringify(stored), rendered, now.toISOString())
    .run();
  await appendAudit(env.DB, {
    actor: ctx.actor,
    action: "run_sheet_written",
    subject: clientId,
    detail: `week ${weekStart}. Not sent to the client.`,
  });
  return { id, weekStart };
}

export async function writeWeeklyRunSheets(env: Env, ctx: GatekeeperContext): Promise<{ written: number }> {
  const clients = (
    await env.DB.prepare(`SELECT id FROM clients WHERE status = 'active'`).all<{ id: string }>()
  ).results;
  let written = 0;
  for (const client of clients) {
    const result = await writeClientRunSheet(env, ctx, client.id);
    if ("id" in result) written++;
  }
  return { written };
}
