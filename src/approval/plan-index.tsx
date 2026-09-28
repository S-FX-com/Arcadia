// Tenant index of group-owned Planner plans. Read live when a row is
// opened. The existing Objectives page — plans registered on projects —
// stays as it is for anyone with view_board. This index does not render there.
//
// Temporary audience (27 September 2026): superadmin only.

import type { JSX } from "preact";
import { openGraphSession, type PlannerBoard } from "../gatekeepers/graph";
import { graphAvailable } from "../integrations/graph";
import { rosterOmissionNote } from "../lib/plan-index";
import { dueLabel, groupByBucket, isOverdue, priorityLabel, taskState } from "../lib/planner";
import { isRepositoryAudience } from "../lib/repository-audience";
import { refreshPlanIndex } from "../patterns/plan-index-job";
import type { UserRecord } from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

interface IndexRow {
  plan_id: string;
  group_id: string;
  group_name: string | null;
  title: string;
  last_seen: string;
}

interface RunRow {
  finished_at: string;
  plans_seen: number;
  roster_omitted: number;
  detail: string | null;
}

function IndexPage(props: {
  user: UserRecord;
  graphOk: boolean;
  rows: IndexRow[];
  run: RunRow | null;
  notice?: string;
}): JSX.Element {
  const { user, graphOk, rows, run, notice } = props;
  const omitted = run?.roster_omitted ?? 0;
  return (
    <Shell
      title="Arcadia — plan index"
      heading="Plan index"
      user={user}
      current="objectives"
      lede="Group-owned Planner plans, one row per plan. The board is still Planner. Roster plans are not listed."
      status={
        !graphOk ? (
          <Pill tone="warn">Planner · not connected</Pill>
        ) : rows.length === 0 ? (
          <Pill tone="warn">Index · empty</Pill>
        ) : (
          <Pill tone="ok">{rows.length} plans</Pill>
        )
      }
    >
      <p class="jump">
        <a href="/agency/objectives">Back to your tasks</a>
      </p>
      {notice ? <p class="banner">{notice}</p> : null}
      {!graphOk ? (
        <div class="banner warn">
          <span>
            <strong>Planner is not connected.</strong> Graph credentials or consent are missing. The
            index cannot be refreshed.
          </span>
        </div>
      ) : null}
      <p>
        <small class="muted">{rosterOmissionNote(omitted)}</small>
      </p>
      {run ? (
        <p>
          <small class="muted">
            Last refresh {run.finished_at}. {run.detail}
          </small>
        </p>
      ) : (
        <p>
          <small class="muted">The index has not been refreshed.</small>
        </p>
      )}
      <form method="post" action="/agency/objectives/tenant/refresh">
        <button type="submit">Refresh index</button>
      </form>
      {rows.length === 0 ? (
        <p class="empty">No group-owned plans in the index.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Plan</th>
              <th>Group</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr>
                <td>{row.title}</td>
                <td>{row.group_name ?? row.group_id}</td>
                <td>
                  <small class="muted">{row.last_seen}</small>
                </td>
                <td>
                  <a href={`/agency/objectives/tenant/${row.plan_id}`}>view board</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}

function BoardPage(props: { user: UserRecord; row: IndexRow; board: PlannerBoard; names: Record<string, string> }): JSX.Element {
  const { user, row, board, names } = props;
  const now = new Date();
  const groups = groupByBucket(board, now);
  return (
    <Shell
      title={`Arcadia — ${row.title}`}
      heading={row.title}
      user={user}
      current="objectives"
      lede={`${row.group_name ?? row.group_id}. Read live from Planner. This page writes nothing.`}
    >
      <p class="jump">
        <a href="/agency/objectives/tenant">All plans</a>
      </p>
      {board.tasks.length === 0 ? (
        <p class="empty">This plan has no tasks.</p>
      ) : (
        groups.map((group) => (
          <section>
            <h2>{group.name}</h2>
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>State</th>
                  <th>Due</th>
                  <th>Assignee</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((task) => (
                  <tr>
                    <td>{task.title}</td>
                    <td>{taskState(task)}</td>
                    <td class={isOverdue(task, now) ? "sev-day7" : undefined}>{dueLabel(task, now)}</td>
                    <td>{task.assigneeIds.map((id) => names[id] ?? id).join(", ") || "unassigned"}</td>
                    <td>{priorityLabel(task.priority) ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </Shell>
  );
}

async function rows(env: Env): Promise<{ rows: IndexRow[]; run: RunRow | null }> {
  const list = (
    await env.DB.prepare(
      `SELECT plan_id, group_id, group_name, title, last_seen FROM planner_plan_index ORDER BY group_name, title`
    ).all<IndexRow>()
  ).results;
  const run = await env.DB.prepare(
    `SELECT finished_at, plans_seen, roster_omitted, detail FROM planner_index_runs ORDER BY finished_at DESC LIMIT 1`
  ).first<RunRow>();
  return { rows: list, run: run ?? null };
}

/** Temporary audience (27 September 2026): superadmin only. */
export async function handlePlanIndexRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/agency/objectives/tenant" && !path.startsWith("/agency/objectives/tenant/")) return undefined;
  if (!isRepositoryAudience(user)) {
    return new Response("The plan index is limited to superadmin for now.", { status: 403 });
  }

  if (request.method === "GET" && path === "/agency/objectives/tenant") {
    const data = await rows(env);
    return html(<IndexPage user={user} graphOk={graphAvailable(env)} rows={data.rows} run={data.run} />);
  }

  const boardMatch = /^\/agency\/objectives\/tenant\/([^/]+)$/.exec(path);
  if (request.method === "GET" && boardMatch?.[1]) {
    const planId = decodeURIComponent(boardMatch[1]);
    const row = await env.DB.prepare(
      `SELECT plan_id, group_id, group_name, title, last_seen FROM planner_plan_index WHERE plan_id = ?1`
    )
      .bind(planId)
      .first<IndexRow>();
    if (!row) return new Response("that plan is not in the index", { status: 404 });
    if (!graphAvailable(env)) {
      return new Response("Planner is not connected — Graph credentials or consent are missing.", { status: 503 });
    }
    // Frozen at mint: the session's only plan is the indexed id. The method takes no id.
    const session = openGraphSession(
      env,
      { sessionId: `plan-index:${crypto.randomUUID()}`, actor: user.email },
      { projectId: `index:${row.plan_id}`, plannerPlanId: row.plan_id }
    );
    const board = await session.plannerBoard();
    const names = await session.assigneeNames([...new Set(board.tasks.flatMap((task) => task.assigneeIds))]);
    return html(<BoardPage user={user} row={row} board={board} names={names} />);
  }

  if (request.method === "POST" && path === "/agency/objectives/tenant/refresh") {
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const result = await refreshPlanIndex(env, { sessionId: `plan-index:${crypto.randomUUID()}`, actor: user.email });
    const data = await rows(env);
    return html(
      <IndexPage user={user} graphOk={graphAvailable(env)} rows={data.rows} run={data.run} notice={result.detail} />
    );
  }

  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  return new Response("not found", { status: 404 });
}
