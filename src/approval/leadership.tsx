// Leadership — the department's reporting line, and the directives it steers.
//
// This is not a diagram of the org. It is the control surface for the edge
// three of Arcadia's directives already read:
//
//   - a day-7 stall is filed under the lead's name, not the doer's (§4 M1)
//   - work sitting unassigned past four hours pings the lead (§4 Phase 3)
//   - a person's certification record is visible to that person, their lead,
//     and Shane — nobody else (§5.7)
//
// So the chart is editable by whoever administers staff, and what changes
// downstream is named next to the control. A chart nobody can act on is
// wall art; a directive nobody can see the source of is a surprise.
//
// One honesty rule carries over from the placeholder this replaces: no
// invented rows. An empty department renders an empty chart that says so.

import type { DirectoryPerson } from "../directory/cards";
import { loadDirectoryChart, type DirectoryChartData } from "../directory/chart";
import { syncDirectory } from "../directory/sync";
import { M365SyncPanel } from "./m365-sync-panel";
import { autoSyncIfNeeded, directorySyncFacts, type SyncFacts } from "./repository-sync";
import { appendAudit } from "../lib/audit";
import { graphNotConnected } from "../integrations/graph";
import { sameChartLine, type ChartNode, type ChartPerson, type EdgeSource } from "../lib/directory-chart";
import { isRepositoryAudience } from "../lib/repository-audience";
import {
  buildOrgChart,
  ladderDisagreements,
  personLabel,
  type OrgChart,
  type OrgGap,
  type OrgNode,
  type OrgPerson,
  type ProjectRow,
} from "../lib/org";
import {
  ALL_ROLES,
  can,
  listUsers,
  requireCapability,
  UnauthorizedError,
  upsertUser,
  type Role,
  type UserRecord,
} from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell, Stat } from "./shell";

interface ViewData {
  chart: OrgChart;
  staff: UserRecord[];
  projects: ProjectRow[];
  /** Active projects per owner email — the load the chart is carrying. */
  ownedByPerson: Map<string, number>;
  /**
   * Graph title and department, merged with the Arcadia overlay.
   * Temporary audience (27 September 2026): present only for superadmin.
   * Everyone else gets the chart the page already had.
   */
  directoryByEmail?: Map<string, DirectoryPerson>;
  directoryNote?: string;
  /** Superadmin chart. Nodes are directory people, not the users table. */
  directoryChart?: DirectoryChartData;
  sync?: SyncFacts;
  syncMissing?: string | null;
}

function isRole(v: string): v is Role {
  return (ALL_ROLES as string[]).includes(v);
}

const GAP_LABEL: Record<OrgGap["kind"], string> = {
  no_lead: "No lead",
  lead_not_on_staff: "Lead not on staff",
  lead_inactive: "Lead deactivated",
  self_lead: "Own lead",
  cycle: "Reporting loop",
};

function edgeWord(source: EdgeSource): string {
  if (source === "overlay") return "Arcadia";
  if (source === "graph") return "Microsoft 365";
  if (source === "lead") return "staff record";
  return "";
}

function selectedManager(source: EdgeSource, managerId: string | null): string {
  if (managerId) return managerId;
  if (source === "overlay" || source === "none") return "__unplaced__";
  return "__clear__";
}

function ChartCard(props: {
  person: ChartPerson;
  source: EdgeSource;
  managerId: string | null;
  loop: boolean;
  chart: DirectoryChartData;
}) {
  const { person, chart } = props;
  const manager = props.managerId ? chart.people.find((row) => row.id === props.managerId) : undefined;
  const via = edgeWord(props.source);
  const line = props.loop
    ? "Reporting loop. The line was cut so the chart can draw."
    : manager
      ? `Reports to ${manager.name}${via ? ` · ${via}` : ""}`
      : "No reporting line";
  const picked = selectedManager(props.source, props.managerId);
  const titleOverride = chart.titleOverrides.get(person.id) ?? "";
  const graphTitle = chart.graphTitles.get(person.id);
  return (
    <div class={props.loop ? "orgnode loop" : "orgnode"}>
      <div class="avatar" aria-hidden="true">
        {person.initials}
      </div>
      <strong>{person.name}</strong>
      <small class="muted">{person.title ?? "No title"}</small>
      <small class="muted">{person.department ?? "No department"}</small>
      <small class="muted">{line}</small>
      <form method="post" action="/agency/leadership/place">
        <input type="hidden" name="aadId" value={person.id} />
        <input type="hidden" name="baseline" value={chart.baselines.get(person.id) ?? "none:"} />
        <label>
          Title{" "}
          <input
            type="text"
            name="title"
            value={titleOverride ?? ""}
            placeholder={graphTitle ? `Microsoft 365: ${graphTitle}` : "Title"}
          />
        </label>
        <label>
          Manager{" "}
          <select name="managerAadId">
            <option value="__clear__" selected={picked === "__clear__"}>
              Microsoft 365 line
            </option>
            <option value="__unplaced__" selected={picked === "__unplaced__"}>
              Unplaced
            </option>
            {chart.people
              .filter((row) => row.id !== person.id)
              .map((row) => (
                <option value={row.id} selected={picked === row.id}>
                  {row.name}
                </option>
              ))}
          </select>
        </label>
        <button type="submit">Set in place</button>
      </form>
    </div>
  );
}

function ChartBranch(props: { node: ChartNode; chart: DirectoryChartData }) {
  const { node, chart } = props;
  const edge = chart.edges.get(node.person.id);
  return (
    <li>
      <ChartCard
        person={node.person}
        source={edge?.source ?? node.source}
        managerId={edge?.managerId ?? null}
        loop={node.loop}
        chart={chart}
      />
      {node.reports.length ? (
        <ul>
          {node.reports.map((child) => (
            <ChartBranch node={child} chart={chart} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function DirectoryChartView(props: { chart: DirectoryChartData }) {
  const { chart } = props;
  const { tree } = chart;
  if (chart.people.length === 0) {
    return <p class="empty">No active member users in the directory. Sync from Microsoft 365 to fill this chart.</p>;
  }
  return (
    <>
      {tree.roots.length ? (
        <div class="orgchart-wrap">
          <ul class="orgchart">
            {tree.roots.map((root) => (
              <ChartBranch node={root} chart={chart} />
            ))}
          </ul>
        </div>
      ) : (
        <p class="empty">No reporting line connects anyone yet. Everyone without a line is in Unplaced.</p>
      )}
      <h2 id="unplaced">Unplaced ({tree.unplaced.length})</h2>
      {tree.unplaced.length === 0 ? (
        <p class="empty">Everyone on this chart has a reporting line.</p>
      ) : (
        <div class="unplaced">
          {tree.unplaced.map((row) => {
            const edge = chart.edges.get(row.person.id);
            return (
              <ChartCard
                person={row.person}
                source={edge?.source ?? row.source}
                managerId={edge?.managerId ?? null}
                loop={row.reason === "loop"}
                chart={chart}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

/** One card in the tree. Load, not performance — §5.7 numbers live in the ledger. */
function Node(props: { node: OrgNode; data: ViewData; user: UserRecord }) {
  const { node, data, user } = props;
  const { person } = node;
  const owned = data.ownedByPerson.get(person.email.toLowerCase()) ?? 0;
  const profile = data.directoryByEmail?.get(person.email.toLowerCase());
  const sourceWord = (source: "arcadia" | "graph" | "none") =>
    source === "arcadia" ? "Arcadia" : source === "graph" ? "Graph" : "not set";
  const canEdit = can(user, "admin_users");

  return (
    <li>
      <div class={person.active ? "orgcard" : "orgcard gone"}>
        <div class="orghead">
          <strong>{personLabel(person)}</strong>
          <span class="tag role">{person.role}</span>
          {person.pod ? <span class="tag">{person.pod}</span> : null}
          {person.active ? null : <span class="tag sev-day7">deactivated</span>}
        </div>
        <div class="orgmeta">
          <small class="muted">{person.email}</small>
          {profile ? (
            <small class="muted">
              {profile.title.shown ?? "no title"} ({sourceWord(profile.title.source)})
              {" · "}
              {profile.department.shown ?? "no department"} ({sourceWord(profile.department.source)})
              {profile.reporting.source === "graph" ? ` · Graph manager ${profile.reporting.email}` : ""}
            </small>
          ) : null}
          <small class="muted">
            {node.reports.length
              ? `${node.reports.length} direct · ${node.total} below`
              : "no direct reports"}
            {owned ? ` · ${owned} active ${owned === 1 ? "project" : "projects"}` : ""}
          </small>
        </div>
        {canEdit ? (
          <form class="inline orgedit" method="post" action="/agency/leadership/lead">
            <input type="hidden" name="email" value={person.email} />
            <label>
              reports to{" "}
              <select name="leadEmail">
                <option value="">— nobody —</option>
                {data.staff
                  .filter((s) => s.email.toLowerCase() !== person.email.toLowerCase())
                  .map((s) => (
                    <option
                      value={s.email}
                      selected={s.email.toLowerCase() === (person.leadEmail ?? "").toLowerCase()}
                    >
                      {personLabel(s)}
                    </option>
                  ))}
              </select>
            </label>{" "}
            <button type="submit">Save</button>
          </form>
        ) : null}
      </div>
      {node.reports.length ? (
        <ul>
          {node.reports.map((child) => (
            <Node node={child} data={data} user={user} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function LeadershipPage(props: { user: UserRecord; data: ViewData; notice?: string }) {
  const { user, data, notice } = props;
  const { chart, projects } = data;
  const disagreements = ladderDisagreements(chart, projects);
  const active = data.staff.filter((s) => s.active).length;
  const leads = data.staff.filter((s) => s.active && (s.role === "lead" || s.role === "founder")).length;
  const canEdit = can(user, "admin_users");
  const canAlign = can(user, "manage_projects");

  return (
    <Shell
      title="Arcadia — leadership"
      heading="Leadership"
      user={user}
      current="leadership"
      lede={
        data.directoryChart
          ? "The department, from the directory. A line or title set here is an Arcadia value on top of Microsoft 365. Nothing on this page is written back to Entra."
          : "Reporting lines for the department: who owns the work, who signs for it, and whose name a day-7 stall lands under."
      }
      status={
        <>
          <Pill tone={chart.gaps.length ? "warn" : "ok"}>
            <b>{chart.gaps.length}</b> coverage {chart.gaps.length === 1 ? "gap" : "gaps"}
          </Pill>
          <Pill tone={disagreements.length ? "danger" : "ok"}>
            <b>{disagreements.length}</b> ladder {disagreements.length === 1 ? "disagreement" : "disagreements"}
          </Pill>
        </>
      }
    >
      {notice ? <p class="banner ok">{notice}</p> : null}
      {data.sync ? (
        <M365SyncPanel
          lastSynced={data.sync.lastSynced}
          rowCount={data.sync.rowCount}
          rowLabel={data.sync.rowCount === 1 ? "person" : "people"}
          lastError={data.sync.lastError}
          missing={data.syncMissing ?? null}
          action="/agency/leadership/sync"
        />
      ) : null}
      {data.directoryNote && !data.directoryChart ? (
        <p>
          <small class="muted">{data.directoryNote} Lines on this chart stay the Arcadia reporting line unless a manager proof succeeded for that person.</small>
        </p>
      ) : null}

      <p class="jump">
        <a href="#chart">The chart</a>
        {data.directoryChart && data.directoryChart.people.length > 0 ? <a href="#unplaced">Unplaced</a> : null}
        <a href="#gaps">Coverage gaps</a>
        <a href="#ladder">Escalation ladder</a>
      </p>

      <div class="stats">
        {data.directoryChart ? (
          <>
            <Stat label="Directory" value={data.directoryChart.people.length} note="active member users" />
            <Stat
              label="Unplaced"
              value={data.directoryChart.tree.unplaced.length}
              note={
                data.directoryChart.tree.unplaced.length
                  ? "no reporting line that holds"
                  : "everyone on the chart has a line"
              }
              tone={data.directoryChart.tree.unplaced.length ? "warn" : "ok"}
            />
            <Stat
              label="Ladder disagreements"
              value={disagreements.length}
              note={
                disagreements.length
                  ? "projects escalating to the wrong lead"
                  : "every project escalates to its owner's lead"
              }
              tone={disagreements.length ? "danger" : "ok"}
            />
          </>
        ) : (
          <>
            <Stat label="Active staff" value={active} note={`${leads} carrying reports`} />
            <Stat
              label="Coverage gaps"
              value={chart.gaps.length}
              note={chart.gaps.length ? "escalations with nowhere to land" : "every active record has a lead"}
              tone={chart.gaps.length ? "warn" : "ok"}
            />
            <Stat
              label="Ladder disagreements"
              value={disagreements.length}
              note={
                disagreements.length
                  ? "projects escalating to the wrong lead"
                  : "every project escalates to its owner's lead"
              }
              tone={disagreements.length ? "danger" : "ok"}
            />
          </>
        )}
      </div>

      <h2 id="chart">The chart</h2>
      {data.directoryChart ? (
        <>
          <p>
            <small class="muted">
              Each card is an active member user. The line is the Arcadia manager when one is set, otherwise
              the Microsoft 365 manager when that read succeeded, otherwise the staff record. Set in place
              stores the Arcadia value. It does not change Entra.
            </small>
          </p>
          <DirectoryChartView chart={data.directoryChart} />
        </>
      ) : (
        <>
          <p>
            <small class="muted">
              Drawn from the reporting line on each staff record — the same edge the Dispatcher pings for idle
              work, the escalation ladder files a day-7 stall against, and §5.7 checks before showing anyone a
              person's certification numbers. Change it here and all three follow.
              {canEdit ? "" : " Changing it needs the staff administration capability."}
            </small>
          </p>
          {chart.roots.length === 0 ? (
            <p class="empty">
              No staff records with a usable reporting line. Add people under Admin → Staff, then set who each
              one reports to.
            </p>
          ) : (
            <ul class="orgtree">
              {chart.roots.map((root) => (
                <Node node={root} data={data} user={user} />
              ))}
            </ul>
          )}
        </>
      )}

      <h2 id="gaps">Coverage gaps ({chart.gaps.length})</h2>
      {chart.gaps.length === 0 ? (
        <p class="empty">Every active staff record reports to somebody who can act on it.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Gap</th>
              <th>What breaks</th>
            </tr>
          </thead>
          <tbody>
            {chart.gaps.map((g) => (
              <tr>
                <td>
                  {personLabel(g.person)}
                  <br />
                  <small class="muted">{g.person.email}</small>
                </td>
                <td class="sev-day5">
                  {GAP_LABEL[g.kind]}
                  {g.namedLead ? (
                    <>
                      <br />
                      <small class="muted">names {g.namedLead}</small>
                    </>
                  ) : null}
                </td>
                <td>
                  <small class="muted">{g.consequence}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 id="ladder">Escalation ladder ({disagreements.length} disagreements)</h2>
      <p>
        <small class="muted">
          Radar escalates against the lead recorded on the <em>project</em>, which was a copy of the
          reporting line when the project was registered. Where that copy and the chart disagree, a day-7
          stall is filed under someone who is not accountable for the owner. The chart is the source; these
          rows are the drift.
        </small>
      </p>
      {disagreements.length === 0 ? (
        <p class="empty">
          {projects.length === 0
            ? "No active projects registered, so there is no ladder to disagree with yet."
            : "Every active project escalates to its owner's lead."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Owner</th>
              <th>Escalates to</th>
              <th>Chart says</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {disagreements.map((d) => (
              <tr>
                <td>{d.project.name}</td>
                <td>
                  <small class="muted">{d.project.owner}</small>
                </td>
                <td class="sev-day7">{d.projectLead ?? "nobody"}</td>
                <td>{d.chartLead ?? "nobody — the owner has no lead"}</td>
                <td>
                  {canAlign && d.chartLead ? (
                    <form class="inline" method="post" action="/agency/leadership/align">
                      <input type="hidden" name="projectId" value={d.project.id} />
                      <button type="submit">Use the chart</button>
                    </form>
                  ) : (
                    <small class="muted">{d.chartLead ? "needs project management" : "fix the chart first"}</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Shell>
  );
}

async function viewData(env: Env): Promise<ViewData> {
  const staff = await listUsers(env);
  const projects = (
    await env.DB.prepare(
      `SELECT id, name, owner, lead, pod FROM projects WHERE status = 'active' ORDER BY name`
    ).all<ProjectRow>()
  ).results;

  const ownedByPerson = new Map<string, number>();
  for (const project of projects) {
    if (!project.owner) continue;
    const key = project.owner.toLowerCase();
    ownedByPerson.set(key, (ownedByPerson.get(key) ?? 0) + 1);
  }

  const people: OrgPerson[] = staff.map((s) => ({
    email: s.email,
    ...(s.displayName ? { displayName: s.displayName } : {}),
    role: s.role,
    ...(s.leadEmail ? { leadEmail: s.leadEmail } : {}),
    ...(s.pod ? { pod: s.pod } : {}),
    active: s.active,
  }));

  return { chart: buildOrgChart(people), staff, projects, ownedByPerson };
}

async function render(env: Env, user: UserRecord, notice?: string): Promise<Response> {
  const data = await viewData(env);
  // Temporary audience (27 September 2026): the directory chart, the overlay,
  // and the sync panel are superadmin-only. Everyone else keeps the staff
  // reporting line this page already had.
  if (isRepositoryAudience(user)) {
    const facts = await directorySyncFacts(env);
    const started = await autoSyncIfNeeded(env, "directory", facts.hasRun);
    const sync = started ? await directorySyncFacts(env) : facts;
    data.sync = sync;
    data.syncMissing = graphNotConnected(env);
    data.directoryChart = await loadDirectoryChart(env);
    const shown = started ?? notice;
    return html(<LeadershipPage user={user} data={data} {...(shown ? { notice: shown } : {})} />);
  }
  return html(<LeadershipPage user={user} data={data} {...(notice ? { notice } : {})} />);
}

/**
 * Move one person under a different lead. The record keeps everything else it
 * had — a reporting-line change is not a place to quietly restate somebody's
 * role or pod.
 */
async function setLead(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "admin_users");
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const leadEmail = String(form.get("leadEmail") ?? "").trim().toLowerCase();
  if (!email.includes("@")) return new Response("valid email required", { status: 400 });
  if (leadEmail && leadEmail === email) {
    return new Response("a person cannot report to themselves", { status: 400 });
  }

  const staff = await listUsers(env);
  const person = staff.find((s) => s.email.toLowerCase() === email);
  if (!person) return new Response("no staff record for that address", { status: 404 });
  if (leadEmail && !staff.some((s) => s.email.toLowerCase() === leadEmail)) {
    return new Response("the lead must be a staff record", { status: 400 });
  }

  // Walking up from the proposed lead must reach a top, not come back here.
  // A loop would leave everyone in it with no escalation terminus.
  const leadOfEmail = new Map(staff.map((s) => [s.email.toLowerCase(), (s.leadEmail ?? "").toLowerCase()]));
  leadOfEmail.set(email, leadEmail);
  const seen = new Set<string>();
  for (let cursor = email; cursor; cursor = leadOfEmail.get(cursor) ?? "") {
    if (seen.has(cursor)) {
      return new Response("that reporting line loops — pick a lead outside this chain", { status: 400 });
    }
    seen.add(cursor);
  }

  await upsertUser(env, {
    email: person.email,
    ...(person.displayName ? { displayName: person.displayName } : {}),
    role: isRole(person.role) ? person.role : "specialist",
    ...(leadEmail ? { leadEmail } : {}),
    ...(person.pod ? { pod: person.pod } : {}),
  });
  await appendAudit(env.DB, {
    actor: user.email,
    action: "reporting_line_set",
    subject: person.email,
    detail: leadEmail
      ? `reports to ${leadEmail} — escalations, idle pings and person-record access follow`
      : "lead cleared — escalations for this person now have nowhere to land",
  });
  const who = person.displayName ?? person.email;
  return await render(
    env,
    user,
    leadEmail ? `${who} now reports to ${leadEmail}.` : `Lead cleared for ${who}. Nothing escalates for them now.`
  );
}

/** Point one project's escalation at the lead the chart names. */
async function alignProject(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "manage_projects");
  const projectId = String(form.get("projectId") ?? "").trim();
  if (!projectId) return new Response("project id required", { status: 400 });

  const project = await env.DB.prepare(`SELECT id, name, owner, lead, pod FROM projects WHERE id = ?1`)
    .bind(projectId)
    .first<ProjectRow>();
  if (!project?.owner) return new Response("no such project, or it has no owner", { status: 404 });

  const staff = await listUsers(env);
  const owner = staff.find((s) => s.email.toLowerCase() === project.owner?.toLowerCase());
  const lead = owner?.leadEmail
    ? staff.find((s) => s.email.toLowerCase() === owner.leadEmail?.toLowerCase())
    : undefined;
  if (!lead) {
    return new Response("the owner has no lead on the chart — set that first", { status: 400 });
  }

  await env.DB.prepare(`UPDATE projects SET lead = ?1, updated_at = datetime('now') WHERE id = ?2`)
    .bind(lead.email, projectId)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "project_lead_aligned",
    subject: projectId,
    detail: `${project.name}: escalation lead ${project.lead ?? "unset"} → ${lead.email} (owner ${project.owner})`,
  });
  return await render(env, user, `${project.name} now escalates to ${lead.email}.`);
}

/** Superadmin sets a manager and a title on the directory chart. No Entra write. */
async function setInPlace(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  if (!isRepositoryAudience(user)) {
    return new Response("Setting a line on this chart is limited to superadmin for now.", { status: 403 });
  }
  const aadId = String(form.get("aadId") ?? "").trim();
  const title = String(form.get("title") ?? "").trim();
  const picked = String(form.get("managerAadId") ?? "").trim();
  const baseline = String(form.get("baseline") ?? "");
  if (!aadId) return new Response("person required", { status: 400 });
  const person = await env.DB.prepare(
    `SELECT aad_id, display_name, mail FROM directory_profiles WHERE aad_id = ?1 AND account_enabled = 1`
  )
    .bind(aadId)
    .first<{ aad_id: string; display_name: string | null; mail: string | null }>();
  if (!person) return new Response("that person is not an active member user", { status: 404 });

  let managerDetail = "manager left as it was";
  if (!sameChartLine(baseline, picked)) {
    if (picked === "__clear__") {
      await env.DB.prepare(`DELETE FROM directory_manager_overlay WHERE aad_id = ?1`).bind(aadId).run();
      managerDetail = "Arcadia manager cleared; Microsoft 365 or the staff record shows through";
    } else if (picked === "__unplaced__") {
      await env.DB.prepare(
        `INSERT INTO directory_manager_overlay (aad_id, manager_aad_id, updated_by)
         VALUES (?1, NULL, ?2)
         ON CONFLICT(aad_id) DO UPDATE SET
           manager_aad_id = NULL,
           updated_by = excluded.updated_by,
           updated_at = datetime('now')`
      )
        .bind(aadId, user.email)
        .run();
      managerDetail = "placed in Unplaced";
    } else {
      if (picked === aadId) return new Response("a person cannot report to themselves", { status: 400 });
      const manager = await env.DB.prepare(
        `SELECT aad_id, display_name FROM directory_profiles WHERE aad_id = ?1 AND account_enabled = 1`
      )
        .bind(picked)
        .first<{ aad_id: string; display_name: string | null }>();
      if (!manager) return new Response("the manager must be an active member user", { status: 400 });
      const chart = await loadDirectoryChart(env);
      const next = new Map([...chart.edges].map(([id, edge]) => [id, edge.managerId]));
      next.set(aadId, picked);
      const seen = new Set<string>();
      for (let cursor: string | null = aadId; cursor; cursor = next.get(cursor) ?? null) {
        if (seen.has(cursor)) {
          return new Response("that reporting line loops — pick a manager outside this chain", { status: 400 });
        }
        seen.add(cursor);
      }
      await env.DB.prepare(
        `INSERT INTO directory_manager_overlay (aad_id, manager_aad_id, updated_by)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(aad_id) DO UPDATE SET
           manager_aad_id = excluded.manager_aad_id,
           updated_by = excluded.updated_by,
           updated_at = datetime('now')`
      )
        .bind(aadId, picked, user.email)
        .run();
      managerDetail = `reports to ${manager.display_name ?? manager.aad_id}`;
    }
  }

  await env.DB.prepare(
    `INSERT INTO directory_overlay (aad_id, title_override, updated_by)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(aad_id) DO UPDATE SET
       title_override = excluded.title_override,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`
  )
    .bind(aadId, title || null, user.email)
    .run();

  const who = person.display_name ?? person.mail ?? aadId;
  await appendAudit(env.DB, {
    actor: user.email,
    action: "directory_chart_set",
    subject: aadId,
    detail: `${who}: title ${title || "cleared"}. ${managerDetail}. Not written to Entra.`,
  });
  return await render(env, user, `${who} is set. ${managerDetail}. Not written to Entra.`);
}

/** Router for /agency/leadership*. Returns undefined for paths it does not own. */
export async function handleLeadershipRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency/leadership")) return undefined;

  try {
    if (request.method === "GET" && path === "/agency/leadership") return await render(env, user);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    if (path === "/agency/leadership/lead") return await setLead(env, user, form);
    if (path === "/agency/leadership/align") return await alignProject(env, user, form);
    if (path === "/agency/leadership/place") return await setInPlace(env, user, form);
    if (path === "/agency/leadership/sync") {
      if (!isRepositoryAudience(user)) {
        return new Response("Directory sync is limited to superadmin for now.", { status: 403 });
      }
      const result = await syncDirectory(env, { sessionId: `directory:${crypto.randomUUID()}`, actor: user.email });
      const sentence = result.error
        ? result.error
        : `Synced ${result.usersSeen} active member user(s). Manager proof: ${result.proof.status}.`;
      return await render(env, user, sentence);
    }
    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response(`Forbidden: ${err.message}`, { status: 403 });
    console.error("leadership", err);
    const reason = err instanceof Error ? err.message : String(err);
    return new Response(`Leadership surface failed: ${reason}`, { status: 500 });
  }
}
