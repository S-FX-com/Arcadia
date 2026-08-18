// Objectives — Planner, read live, in two views.
//
// Planner is the system of record for task state (§10, resolved question 1);
// this page reads it and keeps no copy. The default view is the signed-in
// Specialist's own tasks across every registered team, because the question a
// person opens this page with is "what is mine" — the full-team board is one
// click away per team, itemized the way the department is: one plan per team.
//
// Read-only on purpose. Writing task state back is a gatekeeper action that
// needs a dispatch rule naming a human (§12.1); until that ships here, the
// page changes nothing and says so. Every board read goes through a
// project-scoped Graph session and lands in gk_observations — the same
// sessions Radar sweeps with, minted the same way.

import { openGraphSession, type PlannerBoard, type PlannerTaskDetail } from "../gatekeepers/graph";
import { graphAvailable } from "../integrations/graph";
import {
  boardOrder,
  bucketNames,
  dueLabel,
  groupByBucket,
  isAssignedTo,
  isOverdue,
  priorityLabel,
  rollup,
  taskState,
  type TeamRollup,
} from "../lib/planner";
import { requireCapability, UnauthorizedError, type Identity, type UserRecord } from "../lib/rbac";
import type { ProjectSources } from "../radar/signals";
import { html, Pill, Shell, Stat } from "./shell";

const TEAM_PATH = /^\/agency\/objectives\/([A-Za-z0-9_-]+)$/;

interface ProjectRow {
  id: string;
  name: string;
  owner: string | null;
  lead: string | null;
  pod: string | null;
  sources: string;
}

/** One registered team: a project whose sources carry a Planner plan. */
interface Team {
  id: string;
  name: string;
  pod: string | null;
  lead: string | null;
  planId: string;
}

interface TeamBoard {
  team: Team;
  board?: PlannerBoard;
  /** The real Graph failure, shown on the row. One bad plan must not 500 the page. */
  error?: string;
}

const STATE_LABEL: Record<ReturnType<typeof taskState>, string> = {
  not_started: "not started",
  in_progress: "in progress",
  done: "done",
};

async function loadTeams(env: Env): Promise<{ teams: Team[]; unplanned: string[] }> {
  const rows = (
    await env.DB.prepare(
      `SELECT id, name, owner, lead, pod, sources FROM projects WHERE status = 'active' ORDER BY name`
    ).all<ProjectRow>()
  ).results;

  const teams: Team[] = [];
  const unplanned: string[] = [];
  for (const row of rows) {
    let sources: ProjectSources = {};
    try {
      sources = JSON.parse(row.sources) as ProjectSources;
    } catch {
      // An unreadable sources blob is the same as no plan: named below.
    }
    if (sources.plannerPlanId) {
      teams.push({ id: row.id, name: row.name, pod: row.pod, lead: row.lead, planId: sources.plannerPlanId });
    } else {
      unplanned.push(row.name);
    }
  }
  return { teams, unplanned };
}

/** Fetch every team's board, capturing each failure on its own row. */
async function loadBoards(env: Env, actor: string, teams: Team[]): Promise<TeamBoard[]> {
  const sessionId = `objectives:${crypto.randomUUID()}`;
  return Promise.all(
    teams.map(async (team): Promise<TeamBoard> => {
      const session = openGraphSession(env, { sessionId, actor }, { projectId: team.id, plannerPlanId: team.planId });
      try {
        return { team, board: await session.plannerBoard() };
      } catch (err) {
        return { team, error: err instanceof Error ? err.message : "Planner read failed" };
      }
    })
  );
}

function StateTags(props: { task: PlannerTaskDetail; now: Date }) {
  const { task, now } = props;
  const priority = priorityLabel(task.priority);
  return (
    <>
      <small class={isOverdue(task, now) ? "sev-day7" : "muted"}>{dueLabel(task, now)}</small>{" "}
      <span class="tag">{STATE_LABEL[taskState(task)]}</span>
      {priority ? (
        <>
          {" "}
          <span class={priority === "urgent" ? "tag sev-day7" : "tag sev-day5"}>{priority}</span>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Default view — the signed-in Specialist's tasks, itemized by team.
// ---------------------------------------------------------------------------

function MinePage(props: {
  user: UserRecord;
  aadId?: string;
  connected: boolean;
  boards: TeamBoard[];
  unplanned: string[];
  now: Date;
}) {
  const { user, aadId, connected, boards, unplanned, now } = props;
  const rollups = new Map<string, TeamRollup>(
    boards.filter((b) => b.board).map((b) => [b.team.id, rollup(b.board!.tasks, now, aadId)])
  );
  const mineOpen = [...rollups.values()].reduce((n, r) => n + r.mine, 0);
  const overdueMine = boards
    .filter((b) => b.board)
    .flatMap((b) => b.board!.tasks)
    .filter((t) => aadId && isAssignedTo(t, aadId) && isOverdue(t, now)).length;

  return (
    <Shell
      title="Arcadia — objectives"
      heading="Objectives"
      user={user}
      current="objectives"
      lede="Planner is the system of record. Your tasks first, itemized by team; each team's full board is one click deeper."
      status={
        !connected ? (
          <Pill tone="warn">Planner · not connected</Pill>
        ) : (
          <Pill tone={overdueMine > 0 ? "danger" : mineOpen > 0 ? "ok" : "idle"}>
            <b>{mineOpen}</b> open assigned to you{overdueMine ? <> · <b>{overdueMine}</b> overdue</> : null}
          </Pill>
        )
      }
    >
      {!connected ? (
        <div class="banner warn">
          <span>
            <strong>Planner is not connected.</strong> Graph credentials or consent are missing
            (CLAUDE.md §9.7) — this page can name the registered teams but cannot read their plans. Nothing
            below is task data.
          </span>
        </div>
      ) : null}
      {connected && !aadId ? (
        <p class="banner warn">
          Your session carries no directory id, so tasks cannot be matched to you — team boards below still
          work. Sign in through Microsoft (not the dev bypass) to see your own tasks.
        </p>
      ) : null}

      {boards.length === 0 ? (
        <p class="empty">
          No active project has a Planner plan registered. Add <code>plannerPlanId</code> to a project's
          sources on the accountability board, and its tasks appear here — the same plan id Radar's stall
          signal reads.
        </p>
      ) : (
        <>
          <h2 id="teams">Teams ({boards.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th>Open</th>
                <th>Yours</th>
                <th>Overdue</th>
                <th>Unassigned</th>
                <th>Done</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {boards.map(({ team, error }) => {
                const r = rollups.get(team.id);
                return (
                  <tr>
                    <td>
                      {team.name}
                      {team.pod ? (
                        <>
                          {" "}
                          <span class="tag">{team.pod}</span>
                        </>
                      ) : null}
                    </td>
                    {r ? (
                      <>
                        <td>{r.open}</td>
                        <td>{aadId ? r.mine : "—"}</td>
                        <td class={r.overdue > 0 ? "sev-day7" : undefined}>{r.overdue}</td>
                        <td class={r.unassigned > 0 ? "sev-day5" : undefined}>{r.unassigned}</td>
                        <td>
                          <small class="muted">{r.done}</small>
                        </td>
                        <td>
                          <a href={`/agency/objectives/${team.id}`}>view board</a>
                        </td>
                      </>
                    ) : (
                      <td colSpan={6} class="sev-day5">
                        {error ?? "unreadable"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {connected && aadId ? (
        <>
          <h2 id="mine">Your tasks ({mineOpen})</h2>
          {mineOpen === 0 ? (
            <p class="empty">Nothing in any registered plan is assigned to you.</p>
          ) : (
            boards
              .filter((b) => b.board && rollups.get(b.team.id)!.mine > 0)
              .map(({ team, board }) => {
                const buckets = bucketNames(board!);
                const mine = board!.tasks
                  .filter((t) => isAssignedTo(t, aadId) && taskState(t) !== "done")
                  .sort((a, b) => boardOrder(a, b, now));
                return (
                  <>
                    <h3>
                      {team.name} <small class="muted">({mine.length})</small>
                    </h3>
                    <table>
                      <tbody>
                        {mine.map((t) => (
                          <tr>
                            <td>{t.title}</td>
                            <td>
                              <small class="muted">{(t.bucketId && buckets.get(t.bucketId)) || "(no bucket)"}</small>
                            </td>
                            <td>
                              <StateTags task={t} now={now} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                );
              })
          )}
        </>
      ) : null}

      {unplanned.length ? (
        <p>
          <small class="muted">
            Registered but not connected to Planner: {unplanned.join(", ")}. Each needs a{" "}
            <code>plannerPlanId</code> in its sources before its tasks can appear.
          </small>
        </p>
      ) : null}
      <p>
        <small class="muted">
          Read live from Planner, read-only. Writing task state back goes through the Graph gatekeeper with
          a dispatch rule naming a human — not built on this page yet.
        </small>
      </p>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Team view — every task on one plan, grouped by bucket, with names.
// ---------------------------------------------------------------------------

function TeamPage(props: {
  user: UserRecord;
  team: Team;
  board: PlannerBoard;
  names: Record<string, string>;
  now: Date;
}) {
  const { user, team, board, names, now } = props;
  const r = rollup(board.tasks, now);
  const groups = groupByBucket(board, now);

  return (
    <Shell
      title={`Arcadia — objectives · ${team.name.toLowerCase()}`}
      heading={team.name}
      user={user}
      current="objectives"
      lede={`Every open task on this team's plan, grouped the way the plan is. Planner remains the system of record${team.lead ? `; the team escalates to ${team.lead}` : ""}.`}
      status={
        <Pill tone={r.overdue > 0 ? "danger" : r.open > 0 ? "ok" : "idle"}>
          <b>{r.open}</b> open · <b>{r.overdue}</b> overdue
        </Pill>
      }
    >
      <p class="jump">
        <a href="/agency/objectives">← All teams</a>
      </p>

      <div class="stats">
        <Stat label="Open" value={r.open} note={`${r.total} on the plan`} />
        <Stat
          label="Overdue"
          value={r.overdue}
          note={r.overdue ? "past their due day" : "nothing past due"}
          tone={r.overdue > 0 ? "danger" : "ok"}
        />
        <Stat
          label="Unassigned"
          value={r.unassigned}
          note={r.unassigned ? "open work that can ping nobody" : "every open task has a name"}
          tone={r.unassigned > 0 ? "warn" : "ok"}
        />
        <Stat label="Done" value={r.done} />
      </div>

      {groups.length === 0 ? (
        <p class="empty">Nothing open on this plan.</p>
      ) : (
        groups.map((group) => (
          <>
            <h2>
              {group.name} <small class="muted">({group.tasks.length})</small>
            </h2>
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Assigned to</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {group.tasks.map((t) => (
                  <tr>
                    <td>{t.title}</td>
                    <td>
                      {t.assigneeIds.length === 0 ? (
                        <span class="sev-day5">unassigned</span>
                      ) : (
                        <small class="muted">
                          {t.assigneeIds.map((id) => names[id] ?? "unknown specialist").join(", ")}
                        </small>
                      )}
                    </td>
                    <td>
                      <StateTags task={t} now={now} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ))
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function renderMine(env: Env, user: UserRecord, aadId?: string): Promise<Response> {
  const { teams, unplanned } = await loadTeams(env);
  const connected = graphAvailable(env);
  const boards: TeamBoard[] = connected
    ? await loadBoards(env, user.email, teams)
    : teams.map((team) => ({ team }));
  return html(
    <MinePage
      user={user}
      {...(aadId ? { aadId } : {})}
      connected={connected}
      boards={boards}
      unplanned={unplanned}
      now={new Date()}
    />
  );
}

async function renderTeam(env: Env, user: UserRecord, projectId: string): Promise<Response> {
  const { teams } = await loadTeams(env);
  const team = teams.find((t) => t.id === projectId);
  if (!team) return new Response("no registered team with that id (or it has no Planner plan)", { status: 404 });
  if (!graphAvailable(env)) {
    return new Response("Planner is not connected — Graph credentials or consent are missing (CLAUDE.md §9.7)", {
      status: 503,
    });
  }

  const session = openGraphSession(
    env,
    { sessionId: `objectives:${crypto.randomUUID()}`, actor: user.email },
    { projectId: team.id, plannerPlanId: team.planId }
  );
  const board = await session.plannerBoard();
  const names = await session.assigneeNames([...new Set(board.tasks.flatMap((t) => t.assigneeIds))]);
  return html(<TeamPage user={user} team={team} board={board} names={names} now={new Date()} />);
}

/** Router for /agency/objectives*. Returns undefined for paths it does not own. */
export async function handleObjectivesRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  identity: Identity
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency/objectives")) return undefined;
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

  try {
    // Pod-level visibility, same as the accountability board: a team's tasks
    // are project work, not person records.
    requireCapability(user, "view_board");
    if (path === "/agency/objectives") return await renderMine(env, user, identity.aadId);
    const teamMatch = TEAM_PATH.exec(path);
    if (teamMatch?.[1]) return await renderTeam(env, user, teamMatch[1]);
    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response(`Forbidden: ${err.message}`, { status: 403 });
    console.error("objectives", err);
    const reason = err instanceof Error ? err.message : String(err);
    return new Response(`Objectives surface failed: ${reason}`, { status: 500 });
  }
}
