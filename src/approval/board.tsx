// The public accountability board (§4 M1). Pod-level and founder escalations
// are visible to everyone with a login — that publicness is the mechanism.
// Day-3 owner nudges are private to the owner and their lead.
//
// Also the project registry: Radar can only watch what it has sources for.

import { getAgentByName } from "agents";
import { appendAudit } from "../lib/audit";
import { can, requireCapability, type UserRecord } from "../lib/rbac";
import type { ProjectSources } from "../radar/signals";
import { redirectTo } from "./shell";

interface BoardRow {
  id: string;
  kind: string;
  subject: string;
  body: string;
  owner: string | null;
  lead: string | null;
  pod: string | null;
  created_at: string;
}

interface OpenStallRow {
  project_name: string;
  client: string | null;
  owner: string;
  lead: string;
  days_stalled: number;
  escalation: string;
}

interface ProjectListRow {
  id: string;
  name: string;
  owner: string | null;
  lead: string | null;
  pod: string | null;
  sources: string;
  blind: number;
}

export interface BoardViewData {
  posts: BoardRow[];
  openStalls: OpenStallRow[];
  projects: ProjectListRow[];
  canManage: boolean;
}

const AGENT_INSTANCE = "main";

export async function boardViewData(env: Env, user: UserRecord): Promise<BoardViewData> {
  const email = user.email.toLowerCase();
  // Public posts for everyone; private ones only to the owner and their lead.
  const posts = (
    await env.DB.prepare(
      `SELECT id, kind, subject, body, owner, lead, pod, created_at
         FROM board_posts
        WHERE public = 1 OR lower(COALESCE(owner,'')) = ?1 OR lower(COALESCE(lead,'')) = ?1
        ORDER BY created_at DESC
        LIMIT 20`
    )
      .bind(email)
      .all<BoardRow>()
  ).results;

  const openStalls = (
    await env.DB.prepare(
      `SELECT p.name AS project_name, p.client, s.owner, s.lead, s.days_stalled, s.escalation
         FROM stall_events s JOIN projects p ON p.id = s.project_id
        WHERE s.resolved_at IS NULL
        ORDER BY s.days_stalled DESC
        LIMIT 25`
    ).all<OpenStallRow>()
  ).results;

  const canManage = can(user, "manage_projects");
  const projects = canManage
    ? (
        await env.DB.prepare(
          `SELECT p.id, p.name, p.owner, p.lead, p.pod, p.sources,
                  (SELECT COUNT(*) FROM project_signals g WHERE g.project_id = p.id AND g.available = 1) AS blind
             FROM projects p WHERE p.status = 'active' ORDER BY p.name`
        ).all<ProjectListRow>()
      ).results
    : [];

  return { posts, openStalls, projects, canManage };
}

export function BoardSection(props: { user: UserRecord; data: BoardViewData }) {
  const { data } = props;
  return (
    <>
      <h2 id="board">Accountability board</h2>
      {data.openStalls.length > 0 ? (
        <>
          <h3>Open stalls</h3>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Owner</th>
                <th>Lead</th>
                <th>Days</th>
                <th>Rung</th>
              </tr>
            </thead>
            <tbody>
              {data.openStalls.map((s) => (
                <tr>
                  <td>
                    {s.project_name}
                    {s.client ? <small class="muted"> · {s.client}</small> : null}
                  </td>
                  <td>{s.owner}</td>
                  <td>{s.lead}</td>
                  <td
                    class={
                      s.days_stalled >= 7 ? "sev-day7" : s.days_stalled >= 5 ? "sev-day5" : undefined
                    }
                  >
                    {s.days_stalled}
                  </td>
                  <td>
                    <small class="muted">{s.escalation}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p class="empty">Nothing stalled. Radar sweeps weekday mornings.</p>
      )}

      {data.posts.length > 0 ? (
        <>
          <h3>Recent escalations</h3>
          <table>
            <tbody>
              {data.posts.map((p) => (
                <tr>
                  <td>
                    <small class="muted">{p.created_at}</small>
                  </td>
                  <td>
                    <code>{p.kind}</code>
                  </td>
                  <td>
                    {p.subject}
                    <br />
                    <small class="muted">
                      {p.owner ? `owner ${p.owner}` : ""}
                      {p.lead ? ` · lead ${p.lead}` : ""}
                      {p.pod ? ` · pod ${p.pod}` : ""}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {data.canManage ? (
        <>
          <h3>Watched projects</h3>
          {data.projects.length === 0 ? (
            <p>
              <small class="muted">
                No projects registered. Radar can only watch what it has sources for.
              </small>
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Owner / lead</th>
                  <th>Readable signals</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr>
                    <td>
                      {p.name}
                      <br />
                      <small class="muted">{p.id}</small>
                    </td>
                    <td>
                      <small class="muted">
                        {p.owner ?? "—"} / {p.lead ?? "—"}
                        {p.pod ? ` · ${p.pod}` : ""}
                      </small>
                    </td>
                    <td>
                      {p.blind === 0 ? (
                        <span class="sev-day5">none — Arcadia is blind to this project</span>
                      ) : (
                        <small class="muted">{p.blind} signal(s) readable</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Register or update a project</h3>
          <form method="post" action="/approval/board/project">
            <input type="text" name="name" placeholder="Project name" required />{" "}
            <input type="text" name="client" placeholder="Client" />{" "}
            <input type="text" name="owner" placeholder="owner@s-fx.com" />{" "}
            <input type="text" name="lead" placeholder="lead@s-fx.com" />{" "}
            <input type="text" name="pod" placeholder="pod" />
            <br />
            <input type="text" name="plannerPlanId" placeholder="Planner plan id (task ground truth)" />{" "}
            <input type="text" name="teamsChannelId" placeholder="Teams channel id (progress threads)" />{" "}
            <input type="text" name="teamsTeamId" placeholder="Teams team id" />
            <br />
            <input type="text" name="githubRepo" placeholder="owner/repo" />{" "}
            <input type="text" name="stagingUrl" placeholder="https://staging…" />{" "}
            <input type="text" name="sharepointDriveId" placeholder="SharePoint drive id" />{" "}
            <input type="text" name="sharepointFolderPath" placeholder="/Projects/Acme" />
            <br />
            <button class="primary" type="submit">
              Save project
            </button>
          </form>

          <form class="inline" method="post" action="/approval/board/sweep">
            <button type="submit">Run a sweep now</button>
          </form>
        </>
      ) : null}
    </>
  );
}

/** Owns /approval/board*. */
export async function handleBoardRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  form: FormData | undefined
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/approval/board")) return undefined;
  if (request.method === "GET") return undefined;
  if (!form) return undefined;

  if (path === "/approval/board/project") {
    requireCapability(user, "manage_projects");
    const name = String(form.get("name") ?? "").trim();
    if (!name) return new Response("name required", { status: 400 });
    const str = (k: string) => String(form.get(k) ?? "").trim();
    const sources: ProjectSources = {
      ...(str("githubRepo") ? { githubRepo: str("githubRepo") } : {}),
      ...(str("stagingUrl") ? { stagingUrl: str("stagingUrl") } : {}),
      ...(str("plannerPlanId") ? { plannerPlanId: str("plannerPlanId") } : {}),
      ...(str("teamsTeamId") ? { teamsTeamId: str("teamsTeamId") } : {}),
      ...(str("teamsChannelId") ? { teamsChannelId: str("teamsChannelId") } : {}),
      ...(str("sharepointDriveId") ? { sharepointDriveId: str("sharepointDriveId") } : {}),
      ...(str("sharepointFolderPath") ? { sharepointFolderPath: str("sharepointFolderPath") } : {}),
    };
    const existing = await env.DB.prepare(`SELECT id FROM projects WHERE name = ?1`)
      .bind(name)
      .first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO projects (id, name, client, owner, lead, pod, sources)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         client = excluded.client, owner = excluded.owner, lead = excluded.lead,
         pod = excluded.pod, sources = excluded.sources, updated_at = datetime('now')`
    )
      .bind(
        id,
        name,
        str("client") || null,
        str("owner").toLowerCase() || null,
        str("lead").toLowerCase() || null,
        str("pod") || null,
        JSON.stringify(sources)
      )
      .run();
    await appendAudit(env.DB, {
      actor: user.email,
      action: existing ? "project_updated" : "project_registered",
      subject: id,
      detail: `${name} — signals: ${Object.keys(sources).join(", ") || "none configured"}`,
    });
    return redirectTo("#board");
  }

  if (path === "/approval/board/sweep") {
    requireCapability(user, "manage_projects");
    const radar = await getAgentByName(env.Radar, AGENT_INSTANCE);
    const summary = await radar.sweep();
    await appendAudit(env.DB, {
      actor: user.email,
      action: "sweep_triggered",
      detail: `${summary.projectsSwept} swept, ${summary.stalled} stalled, ${summary.escalated} escalated, ${summary.blind} blind`,
    });
    return redirectTo("#board");
  }

  return undefined;
}
