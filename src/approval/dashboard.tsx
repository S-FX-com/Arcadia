// Arcadia's staff surface. Microsoft SSO authenticates (src/lib/sso.ts) and
// src/lib/rbac.ts authorizes every mutation server-side, so a routing mistake
// cannot silently expose this. Every decision lands in the append-only audit
// log under a named human. Server-rendered, zero client JS.
//
// Three pages, not one: the chat is the front door at "/"
// (src/approval/chat.tsx), operations live at /approval/ops, and tenancy
// administration at /approval/admin.

import type { ComponentChildren } from "preact";
import { render } from "preact-render-to-string";
import { getAgentByName } from "agents";
import { styles } from "./theme";
import { AdminSection, adminViewData, handleAdminModels, handleAdminUsers } from "./admin";
import { handleDoctrineRoutes } from "./doctrine";
import { LedgerSection, handleLedgerRoutes, ledgerViewData } from "./ledger";
import { BoardSection, boardViewData, handleBoardRoutes } from "./board";
import { GatekeeperSection, gatekeeperViewData } from "./gatekeepers";
import { appendAudit, recentAudit, type AuditRow } from "../lib/audit";
import {
  checkRateCeiling,
  killSwitch,
  setKillSwitch,
  type KillSwitchState,
  type RateCheck,
} from "../lib/controls";
import {
  can,
  capabilitiesOf,
  requireCapability,
  resolveUser,
  UnauthorizedError,
  type Identity,
  type UserRecord,
} from "../lib/rbac";

interface ApprovalRow {
  id: string;
  workflow_id: string;
  kind: "hermes_publish" | "doctrine_ratify" | "site_plan";
  subject: string;
  summary: string | null;
  status: string;
  created_at: string;
}

const APPROVAL_LABELS: Record<ApprovalRow["kind"], string> = {
  hermes_publish: "Hermes publish",
  doctrine_ratify: "Doctrine ratify",
  site_plan: "Site plan",
};

interface PublishedRow {
  title: string;
  url: string | null;
  slug: string;
  approved_by: string | null;
  published_at: string;
}

interface TopicCountRow {
  status: string;
  n: number;
}

const AGENT_INSTANCE = "main";

// Re-exported so a surface only ever imports its chrome from one module.
export { styles };

export function html(node: preact.VNode): Response {
  return new Response(`<!doctype html>${render(node)}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Back to the operations panel after a mutation. */
export function redirectTo(fragment = ""): Response {
  return new Response(null, { status: 303, headers: { Location: `/approval/ops${fragment}` } });
}

/**
 * Mutating routes accept only same-origin submissions. The session cookie
 * would ride along on a cross-site form post; every Arcadia form is
 * same-origin, so anything else is rejected.
 */
export function rejectCrossOrigin(request: Request): Response | undefined {
  const url = new URL(request.url);
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  const sameOrigin =
    (secFetchSite === null || secFetchSite === "same-origin" || secFetchSite === "none") &&
    (origin === null || origin === url.origin);
  return sameOrigin ? undefined : new Response("cross-origin form submission rejected", { status: 403 });
}

type NavKey = "chat" | "ops" | "doctrine" | "admin";

/**
 * Shared chrome. Chat is the front door (§4 Phase 2); operations and admin are
 * separate pages, so a specialist with a doctrine question never lands on the
 * approval queue and an approver never scrolls past model routing to reach it.
 */
export function Nav(props: { user: UserRecord; current: NavKey }) {
  const { user, current } = props;
  const item = (href: string, label: string, key: NavKey) =>
    current === key ? <strong>{label}</strong> : <a href={href}>{label}</a>;
  return (
    <nav>
      {item("/", "Chat", "chat")}
      {item("/approval/ops", "Operations", "ops")}
      {can(user, "ratify_doctrine") ? item("/approval/doctrine", "Doctrine", "doctrine") : null}
      {can(user, "admin_models") || can(user, "admin_users")
        ? item("/approval/admin", "Admin", "admin")
        : null}
      <a class="out" href="/auth/logout">
        Sign out
      </a>
    </nav>
  );
}

/** The identity line every page carries: who you are and what you may do. */
export function Whoami(props: { user: UserRecord }) {
  const { user } = props;
  return (
    <p class="who-row">
      <span class="tag role">{user.role}</span>
      <span class="tag">{user.displayName ?? user.email}</span>
      <span class="tag">{capabilitiesOf(user).length} capabilities</span>
      {user.leadEmail ? <span class="tag">lead {user.leadEmail}</span> : null}
    </p>
  );
}

/** A headline number. Tone is a verdict, never decoration. */
export function Stat(props: { label: string; value: string | number; note?: string; tone?: "ok" | "warn" | "danger" }) {
  const { label, value, note, tone } = props;
  return (
    <div class={tone ? `stat ${tone}` : "stat"}>
      <span class="k">{label}</span>
      <span class="v">{value}</span>
      {note ? <span class="n">{note}</span> : null}
    </div>
  );
}

/**
 * Every page's document shell: head, top bar, page heading, footer. One place
 * to change the chrome, so a new surface cannot ship with different navigation.
 */
export function Shell(props: {
  title: string;
  heading: string;
  user?: UserRecord;
  current?: NavKey;
  lede?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const { title, heading, user, current, lede, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <style>{styles}</style>
      </head>
      <body>
        <header class="topbar">
          <div class="bar">
            <a class="brand" href="/">
              <span class="dot" />
              Arcadia
            </a>
            {user && current ? <Nav user={user} current={current} /> : null}
          </div>
        </header>
        <main>
          <div class="pagehead">
            <h1>{heading}</h1>
            {lede ? <p class="lede">{lede}</p> : null}
            {user ? <Whoami user={user} /> : null}
          </div>
          {children}
        </main>
        <footer>
          <span class="dot" />
          Arcadia surfaces and attributes. Humans decide and sign.
        </footer>
      </body>
    </html>
  );
}

function Page(props: {
  user: UserRecord;
  approvals: ApprovalRow[];
  ks: KillSwitchState;
  rate: RateCheck;
  topics: TopicCountRow[];
  published: PublishedRow[];
  audit: AuditRow[];
  ledger: Awaited<ReturnType<typeof ledgerViewData>>;
  board: Awaited<ReturnType<typeof boardViewData>>;
  gatekeepers: Awaited<ReturnType<typeof gatekeeperViewData>>;
}) {
  const { user, approvals, ks, rate, topics, published, audit, ledger, board, gatekeepers } = props;
  const canApprove = can(user, "approve_publish") || can(user, "ratify_doctrine");
  const queued = topics.find((t) => t.status === "queued")?.n ?? 0;
  const stalls = board.openStalls.length;
  const day7 = board.openStalls.filter((s) => s.days_stalled >= 7).length;
  return (
    <Shell
      title="Arcadia — operations"
      heading="Operations"
      user={user}
      current="ops"
      lede="Approvals, stalls, certifications and the audit tail. Every row carries a name."
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
        <Stat
          label="Published today"
          value={`${rate.publishedToday}/${rate.perDay}`}
          note={`${rate.publishedThisWeek}/${rate.perWeek} this week`}
        />
        <Stat
          label="Topics queued"
          value={queued}
          note={topics.map((t) => `${t.status} ${t.n}`).join(" · ") || "queue empty"}
        />
      </div>

      <div class={`banner ${ks.engaged ? "engaged" : "ok"}`}>
        {ks.engaged ? (
          <span>
            <strong>KILL SWITCH ENGAGED</strong> by {ks.by ?? "unknown"} at {ks.at ?? "?"}
            {ks.reason ? ` — ${ks.reason}` : ""}
          </span>
        ) : (
          <span>Kill switch off. Publish runs are live.</span>
        )}{" "}
        {can(user, "kill_switch") ? (
          <form class="inline" method="post" action="/approval/kill-switch">
            <input type="hidden" name="action" value={ks.engaged ? "release" : "engage"} />
            <input type="text" name="reason" placeholder="reason" />
            <button class={ks.engaged ? "primary" : "kill"} type="submit">
              {ks.engaged ? "Release" : "ENGAGE KILL SWITCH"}
            </button>
          </form>
        ) : (
          <small class="muted">(kill switch operators only)</small>
        )}
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
                  {a.kind === "hermes_publish" ? (
                    <a href={`/approval/draft/${a.workflow_id}`} target="_blank" rel="noreferrer">
                      preview draft
                    </a>
                  ) : null}
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

      {can(user, "trigger_runs") ? (
        <>
          <h2>Run Hermes now</h2>
          <form class="inline" method="post" action="/approval/trigger">
            <input type="text" name="topicId" placeholder="topic id (blank = pick from queue)" />
            <button class="primary" type="submit">
              Start publish run
            </button>
          </form>
        </>
      ) : null}

      {can(user, "manage_topics") ? (
        <>
          <h2>Add topic to queue</h2>
          <form class="inline" method="post" action="/approval/topics">
            <input type="text" name="title" placeholder="How do I …" required />
            <input type="text" name="keywords" placeholder="comma,separated,keywords" />
            <button class="primary" type="submit">
              Queue topic
            </button>
          </form>
        </>
      ) : null}

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

      <h2>Recently published</h2>
      {published.length === 0 ? (
        <p class="empty">Nothing published yet.</p>
      ) : (
        <table>
          <tbody>
            {published.map((p) => (
              <tr>
                <td>{p.url ? <a href={p.url}>{p.title}</a> : p.title}</td>
                <td>
                  <small class="muted">approved by {p.approved_by ?? "—"}</small>
                </td>
                <td>
                  <small class="muted">{p.published_at}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
  const canApprove = can(user, "approve_publish") || can(user, "ratify_doctrine");
  const approvals = canApprove
    ? (await env.DB.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`).all<ApprovalRow>())
        .results
    : [];
  const published = (
    await env.DB.prepare(
      `SELECT title, url, slug, approved_by, published_at FROM published_log ORDER BY published_at DESC LIMIT 10`
    ).all<PublishedRow>()
  ).results;
  const topics = (
    await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM topics GROUP BY status`).all<TopicCountRow>()
  ).results;
  return html(
    <Page
      user={user}
      approvals={approvals}
      ks={await killSwitch(env)}
      rate={await checkRateCeiling(env)}
      topics={topics}
      published={published}
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

  if (row.kind === "hermes_publish") {
    requireCapability(user, "approve_publish");
    const hermes = await getAgentByName(env.Hermes, AGENT_INSTANCE);
    if (decision === "approve") await hermes.approvePublish(row.workflow_id, user.email, reason);
    else await hermes.rejectPublish(row.workflow_id, user.email, reason);
  } else if (row.kind === "site_plan") {
    // Melina and Diego approve site plans before anything reaches a client.
    requireCapability(user, "approve_publish");
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

async function toggleKillSwitch(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "kill_switch");
  const engage = String(form.get("action")) === "engage";
  const reason = String(form.get("reason") ?? "") || undefined;
  await setKillSwitch(env, engage, user.email, reason);
  await appendAudit(env.DB, {
    actor: user.email,
    action: engage ? "kill_switch_engaged" : "kill_switch_released",
    detail: reason,
  });
  return redirectTo();
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

    const draftMatch = /^\/approval\/draft\/([A-Za-z0-9_-]+)$/.exec(path);
    if (request.method === "GET" && draftMatch) {
      requireCapability(user, "approve_publish");
      const object = await env.ARTIFACTS.get(`hermes/drafts/${draftMatch[1]}.html`);
      if (!object || !("body" in object) || !object.body) return new Response("draft not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // The draft is LLM-generated HTML. A prompt-injected <script> here
          // would run with the approver's session and could self-approve via
          // same-origin POSTs. `sandbox` renders it in an opaque origin with
          // scripts disabled.
          "Content-Security-Policy": "sandbox",
        },
      });
    }

    const planMatch = /^\/approval\/siteplan\/([A-Za-z0-9_-]+)$/.exec(path);
    if (request.method === "GET" && planMatch) {
      requireCapability(user, "approve_publish");
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
      case "/approval/kill-switch":
        return await toggleKillSwitch(env, user, form);
      case "/approval/admin/models":
        return await handleAdminModels(env, user, form);
      case "/approval/admin/users":
        return await handleAdminUsers(env, user, form);
      case "/approval/trigger": {
        requireCapability(user, "trigger_runs");
        const hermes = await getAgentByName(env.Hermes, AGENT_INSTANCE);
        const topicId = String(form.get("topicId") ?? "").trim() || undefined;
        await hermes.triggerPublish(topicId, user.email);
        return redirectTo();
      }
      case "/approval/topics": {
        requireCapability(user, "manage_topics");
        const title = String(form.get("title") ?? "").trim();
        if (!title) return new Response("title required", { status: 400 });
        const keywords = String(form.get("keywords") ?? "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        await env.DB.prepare(`INSERT INTO topics (id, title, keywords) VALUES (?1, ?2, ?3)`)
          .bind(crypto.randomUUID(), title, JSON.stringify(keywords))
          .run();
        await appendAudit(env.DB, { actor: user.email, action: "topic_queued", detail: title });
        return redirectTo();
      }
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
