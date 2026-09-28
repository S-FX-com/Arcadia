// Tenant index of group-owned Planner plans. Read live when a row is
// opened. The existing Objectives page — plans registered on projects —
// stays as it is for anyone with view_board. This index does not render there.
//
// Temporary audience (27 September 2026): superadmin only.

import type { JSX } from "preact";
import { graphAvailable, graphNotConnected } from "../integrations/graph";
import { rosterOmissionNote } from "../lib/plan-index";
import { plannerWebUrl } from "../lib/planner";
import { isRepositoryAudience } from "../lib/repository-audience";
import { refreshPlanIndex } from "../patterns/plan-index-job";
import type { UserRecord } from "../lib/rbac";
import { M365SyncPanel } from "./m365-sync-panel";
import { autoSyncIfNeeded, planSyncFacts, type SyncFacts } from "./repository-sync";
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
  sync: SyncFacts;
  missing: string | null;
  notice?: string;
}): JSX.Element {
  const { user, graphOk, rows, run, sync, missing, notice } = props;
  const omitted = run?.roster_omitted ?? 0;
  return (
    <Shell
      title="Arcadia — objectives"
      heading="Objectives"
      user={user}
      current="objectives"
      lede="Every group-owned Planner plan, one row. Opening a row opens that plan in Planner. Roster plans are omitted and counted. This page does not keep a second board."
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
        <a href="/agency/objectives/mine">Project boards</a>
      </p>
      {notice ? <p class="banner">{notice}</p> : null}
      <M365SyncPanel
        lastSynced={sync.lastSynced}
        rowCount={sync.rowCount}
        rowLabel={sync.rowCount === 1 ? "plan" : "plans"}
        lastError={sync.lastError}
        missing={missing}
        action="/agency/objectives/tenant/refresh"
      />
      <p>
        <small class="muted">
          {rosterOmissionNote(omitted)} The index refreshes on a schedule, and on the first open when it has never synced.
        </small>
      </p>
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
                <td>
                  <a href={plannerWebUrl(row.group_id, row.plan_id)} target="_blank" rel="noopener noreferrer">
                    {row.title}
                  </a>
                </td>
                <td>{row.group_name ?? row.group_id}</td>
                <td>
                  <small class="muted">{row.last_seen}</small>
                </td>
                <td>
                  <a href={plannerWebUrl(row.group_id, row.plan_id)} target="_blank" rel="noopener noreferrer">
                    Open in Planner
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

/** The 1:1 index. Used by /agency/objectives for a superadmin and by the tenant path. */
export async function renderPlanIndex(env: Env, user: UserRecord, notice?: string): Promise<Response> {
  const facts = await planSyncFacts(env);
  const started = notice ? undefined : await autoSyncIfNeeded(env, "plans", facts.hasRun);
  const sync = started ? await planSyncFacts(env) : facts;
  const data = await rows(env);
  const shown = notice ?? started;
  return html(
    <IndexPage
      user={user}
      graphOk={graphAvailable(env)}
      rows={data.rows}
      run={data.run}
      sync={sync}
      missing={graphNotConnected(env)}
      {...(shown ? { notice: shown } : {})}
    />
  );
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
    return renderPlanIndex(env, user);
  }

  const boardMatch = /^\/agency\/objectives\/tenant\/([^/]+)$/.exec(path);
  if (request.method === "GET" && boardMatch?.[1] && boardMatch[1] !== "refresh") {
    const planId = decodeURIComponent(boardMatch[1]);
    const row = await env.DB.prepare(`SELECT plan_id, group_id FROM planner_plan_index WHERE plan_id = ?1`)
      .bind(planId)
      .first<{ plan_id: string; group_id: string }>();
    if (!row) return new Response("that plan is not in the index", { status: 404 });
    return Response.redirect(plannerWebUrl(row.group_id, row.plan_id), 302);
  }

  if (request.method === "POST" && path === "/agency/objectives/tenant/refresh") {
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const result = await refreshPlanIndex(env, { sessionId: `plan-index:${crypto.randomUUID()}`, actor: user.email });
    return renderPlanIndex(env, user, result.detail);
  }

  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  return new Response("not found", { status: 404 });
}
