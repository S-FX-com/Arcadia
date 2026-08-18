// Arcadia's operations surface and the /approval router. Microsoft SSO
// authenticates (src/lib/sso.ts) and src/lib/rbac.ts authorizes every mutation
// server-side, so a routing mistake cannot silently expose this. Every decision
// lands in the append-only audit log under a named human. Server-rendered, zero
// client JS.
//
// One surface per job, not one page: Ask Arcadia is the front door at "/"
// (chat.tsx), Agency and Clients are placeholders (sections.tsx), operations
// live at /approval/ops, doctrine at /approval/doctrine, and tenancy
// administration at /approval/admin. The chrome they share is shell.tsx.

import { getAgentByName } from "agents";
import { html, Pill, redirectTo, rejectCrossOrigin, Shell, Stat } from "./shell";
import { AdminSection, adminViewData, handleAdminModels, handleAdminUsers } from "./admin";
import { handleDoctrineRoutes } from "./doctrine";
import { LedgerSection, handleLedgerRoutes, ledgerViewData } from "./ledger";
import { BoardSection, boardViewData, handleBoardRoutes } from "./board";
import { GatekeeperSection, gatekeeperViewData } from "./gatekeepers";
import { recentAudit, type AuditRow } from "../lib/audit";
import {
  can,
  requireCapability,
  resolveUser,
  UnauthorizedError,
  type Identity,
  type UserRecord,
} from "../lib/rbac";

interface ApprovalRow {
  id: string;
  workflow_id: string;
  kind: "doctrine_ratify" | "site_plan";
  subject: string;
  summary: string | null;
  status: string;
  created_at: string;
}

const APPROVAL_LABELS: Record<ApprovalRow["kind"], string> = {
  doctrine_ratify: "Doctrine ratify",
  site_plan: "Site plan",
};

const AGENT_INSTANCE = "main";

// Re-exported so a surface can reach its chrome through one module. New code
// should import from ./shell and ./theme directly.
export { styles } from "./theme";
export { Card, html, Pill, redirectTo, rejectCrossOrigin, Shell, Stat, Whoami } from "./shell";

function Page(props: {
  user: UserRecord;
  approvals: ApprovalRow[];
  audit: AuditRow[];
  ledger: Awaited<ReturnType<typeof ledgerViewData>>;
  board: Awaited<ReturnType<typeof boardViewData>>;
  gatekeepers: Awaited<ReturnType<typeof gatekeeperViewData>>;
}) {
  const { user, approvals, audit, ledger, board, gatekeepers } = props;
  const canApprove = can(user, "approve_plans") || can(user, "ratify_doctrine");
  const stalls = board.openStalls.length;
  const day7 = board.openStalls.filter((s) => s.days_stalled >= 7).length;
  return (
    <Shell
      title="Arcadia — operations"
      heading="Operations"
      user={user}
      current="ops"
      lede="Approvals, stalls, certifications and the audit tail. Every row carries a name."
      status={
        <>
          <Pill tone={day7 > 0 ? "danger" : stalls > 0 ? "warn" : "ok"}>
            <b>{stalls}</b> open {stalls === 1 ? "stall" : "stalls"}
          </Pill>
          <Pill tone={approvals.length ? "warn" : "idle"}>
            <b>{approvals.length}</b> awaiting a tap
          </Pill>
        </>
      }
    >
      <p class="jump">
        <a href="#approvals">Approvals</a>
        <a href="#board">Accountability board</a>
        <a href="#ledger">Certifications</a>
        {can(user, "view_audit") ? <a href="#gatekeepers">Gatekeepers</a> : null}
        <a href="#audit">Audit</a>
      </p>

      <div class="stats">
        <Stat
          label="Pending approvals"
          value={approvals.length}
          note={approvals.length ? "waiting on a human tap" : "nothing waiting"}
          {...(approvals.length ? { tone: "warn" as const } : {})}
        />
        <Stat
          label="Open stalls"
          value={stalls}
          note={stalls ? `${day7} at the founder digest rung` : "Radar sweeps weekday mornings"}
          tone={day7 > 0 ? "danger" : stalls > 0 ? "warn" : "ok"}
        />
      </div>

      <h2 id="approvals">Pending approvals ({approvals.length})</h2>
      {!canApprove ? (
        <p class="empty">Your role cannot approve. Nothing to do here.</p>
      ) : approvals.length === 0 ? (
        <p class="empty">Nothing waiting on you.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Summary</th>
              <th>Raised</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr>
                <td>{APPROVAL_LABELS[a.kind] ?? a.kind}</td>
                <td>
                  {a.summary ?? a.subject}{" "}
                  {a.kind === "site_plan" ? (
                    <a href={`/approval/siteplan/${a.workflow_id}`} target="_blank" rel="noreferrer">
                      review plan
                    </a>
                  ) : null}
                </td>
                <td>
                  <small class="muted">{a.created_at}</small>
                </td>
                <td>
                  <form class="inline" method="post" action="/approval/decide">
                    <input type="hidden" name="approvalId" value={a.id} />
                    <input type="text" name="reason" placeholder="reason (optional)" />
                    <button class="approve" name="decision" value="approve" type="submit">
                      Approve
                    </button>{" "}
                    <button class="reject" name="decision" value="reject" type="submit">
                      Reject
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <BoardSection user={user} data={board} />
      <LedgerSection user={user} data={ledger} />

      {can(user, "ratify_doctrine") ? (
        <>
          <h2>Doctrine</h2>
          <p>
            <small class="muted">
              Seeding, the staging queue, and ratification live on the{" "}
              <a href="/approval/doctrine">Doctrine</a> page. Entries proposed one at a time still appear in
              Pending approvals above.
            </small>
          </p>
        </>
      ) : null}

      <GatekeeperSection user={user} data={gatekeepers} />

      {can(user, "view_audit") ? (
        <>
          <h2 id="audit">Audit tail</h2>
          <table>
            <tbody>
              {audit.map((row) => (
                <tr>
                  <td>
                    <small class="muted">{row.created_at}</small>
                  </td>
                  <td>{row.actor}</td>
                  <td>{row.action}</td>
                  <td>
                    <small class="muted">{row.detail ?? row.subject ?? ""}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Shell>
  );
}

/**
 * Tenancy administration: model routing and staff/roles. Its own page rather
 * than a section of the operations panel — a superadmin opening Arcadia was
 * landing on model routing instead of on Arcadia.
 */
function AdminPage(props: { user: UserRecord; admin: Awaited<ReturnType<typeof adminViewData>> }) {
  const { user, admin } = props;
  return (
    <Shell
      title="Arcadia — admin"
      heading="Admin"
      user={user}
      current="admin"
      lede="Tenancy administration: where each task runs, and who holds which role."
    >
      <p class="jump">
        {can(user, "admin_models") ? <a href="#models">Model routing</a> : null}
        {can(user, "admin_users") ? <a href="#staff">Staff and roles</a> : null}
      </p>
      <span id="models" />
      <span id="staff" />
      <AdminSection
        user={user}
        routing={admin.routing}
        overriddenTasks={admin.overriddenTasks}
        staff={admin.staff}
      />
    </Shell>
  );
}

async function renderAdmin(env: Env, user: UserRecord): Promise<Response> {
  // Either capability opens the page; AdminSection renders only the half the
  // caller holds, and every mutation re-checks server-side regardless.
  if (!can(user, "admin_models") && !can(user, "admin_users")) {
    requireCapability(user, "admin_users");
  }
  return html(<AdminPage user={user} admin={await adminViewData(env, user)} />);
}

async function renderDashboard(env: Env, user: UserRecord): Promise<Response> {
  const canApprove = can(user, "approve_plans") || can(user, "ratify_doctrine");
  const approvals = canApprove
    ? (await env.DB.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`).all<ApprovalRow>())
        .results
    : [];
  return html(
    <Page
      user={user}
      approvals={approvals}
      audit={can(user, "view_audit") ? await recentAudit(env.DB, 25) : []}
      ledger={await ledgerViewData(env, user)}
      board={await boardViewData(env, user)}
      gatekeepers={await gatekeeperViewData(env, user)}
    />
  );
}

async function decide(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  const approvalId = String(form.get("approvalId") ?? "");
  const decision = String(form.get("decision") ?? "");
  const reason = String(form.get("reason") ?? "") || undefined;
  const row = await env.DB
    .prepare(`SELECT * FROM approvals WHERE id = ?1 AND status = 'pending'`)
    .bind(approvalId)
    .first<ApprovalRow>();
  if (!row) return new Response("approval not found or already decided", { status: 404 });

  if (row.kind === "site_plan") {
    // Melina and Diego approve site plans before anything reaches a client.
    requireCapability(user, "approve_plans");
    const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
    if (decision === "approve") await arcadia.approveSitePlan(row.workflow_id, user.email, reason);
    else await arcadia.rejectSitePlan(row.workflow_id, user.email, reason);
  } else {
    requireCapability(user, "ratify_doctrine");
    const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
    if (decision === "approve") await arcadia.approveRatify(row.workflow_id, user.email, reason);
    else await arcadia.rejectRatify(row.workflow_id, user.email, reason);
  }
  return redirectTo("#approvals");
}

/** Router for /approval*. Returns undefined for paths it does not own. */
export async function handleApprovalRoutes(
  request: Request,
  env: Env,
  identity: Identity
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/approval")) return undefined;

  const user = await resolveUser(env, identity);
  if (!user.active) return new Response("Forbidden: this account is deactivated", { status: 403 });

  try {
    if (request.method === "GET" && path === "/approval") {
      // Kept as a permanent alias: bookmarks, and the notification emails
      // Radar has already sent, point here.
      return new Response(null, { status: 302, headers: { Location: "/approval/ops" } });
    }
    if (request.method === "GET" && path === "/approval/ops") {
      return await renderDashboard(env, user);
    }
    if (request.method === "GET" && path === "/approval/admin") {
      return await renderAdmin(env, user);
    }

    // Doctrine intake and ratification owns everything under its own prefix,
    // GET and POST alike.
    const doctrine = await handleDoctrineRoutes(request, env, user);
    if (doctrine) return doctrine;

    const planMatch = /^\/approval\/siteplan\/([A-Za-z0-9_-]+)$/.exec(path);
    if (request.method === "GET" && planMatch) {
      requireCapability(user, "approve_plans");
      const row = await env.DB.prepare(`SELECT artifact_key FROM site_plans WHERE id = ?1`)
        .bind(planMatch[1])
        .first<{ artifact_key: string }>();
      const object = row ? await env.ARTIFACTS.get(row.artifact_key) : null;
      if (!object || !("body" in object) || !object.body) return new Response("plan not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The plan embeds crawled third-party markup and model output.
          "Content-Security-Policy": "sandbox",
        },
      });
    }

    // GET sub-surfaces owned by other modules (certification cards, board
    // detail, per-person rates).
    if (request.method === "GET") {
      const ledgerGet = await handleLedgerRoutes(request, env, user, undefined);
      if (ledgerGet) return ledgerGet;
      const boardGet = await handleBoardRoutes(request, env, user, undefined);
      if (boardGet) return boardGet;
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    switch (path) {
      case "/approval/decide":
        return await decide(env, user, form);
      case "/approval/admin/models":
        return await handleAdminModels(env, user, form);
      case "/approval/admin/users":
        return await handleAdminUsers(env, user, form);
      default: {
        const ledgerPost = await handleLedgerRoutes(request, env, user, form);
        if (ledgerPost) return ledgerPost;
        const boardPost = await handleBoardRoutes(request, env, user, form);
        if (boardPost) return boardPost;
        return new Response("not found", { status: 404 });
      }
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
