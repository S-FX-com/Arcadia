// Approval dashboard — the Phase 1a human gate (§4). Cloudflare Access sits
// in front of the route (§9.5); verifyAccess() re-checks the JWT so a policy
// mistake can't silently expose this, and every decision lands in the audit
// log under a named human. Server-rendered, zero client JS.

import { render } from "preact-render-to-string";
import { getAgentByName } from "agents";
import { canOperateKillSwitch, type Identity } from "../lib/access";
import { recentAudit, type AuditRow } from "../lib/audit";
import { checkRateCeiling, killSwitch, setKillSwitch, type KillSwitchState, type RateCheck } from "../lib/controls";
import { appendAudit } from "../lib/audit";

interface ApprovalRow {
  id: string;
  workflow_id: string;
  kind: "hermes_publish" | "doctrine_ratify";
  subject: string;
  summary: string | null;
  status: string;
  created_at: string;
}

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

function html(node: preact.VNode): Response {
  return new Response(`<!doctype html>${render(node)}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function redirectBack(): Response {
  return new Response(null, { status: 303, headers: { Location: "/approval" } });
}

const styles = `
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #16181d; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.05rem; margin-top: 2rem; border-bottom: 1px solid #d8dbe2; padding-bottom: .3rem; }
  table { width: 100%; border-collapse: collapse; font-size: .87rem; }
  td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eceef2; vertical-align: top; }
  form.inline { display: inline; } input[type=text] { padding: .3rem; min-width: 14rem; }
  button { padding: .3rem .8rem; cursor: pointer; border: 1px solid #999; border-radius: 4px; background: #fff; }
  button.approve { background: #175e33; color: #fff; border-color: #175e33; }
  button.reject { background: #8a1f1f; color: #fff; border-color: #8a1f1f; }
  button.kill { background: #b30000; color: #fff; border-color: #b30000; font-weight: 700; }
  .banner { padding: .6rem 1rem; border-radius: 6px; margin: 1rem 0; }
  .banner.engaged { background: #ffd7d7; border: 1px solid #b30000; }
  .banner.ok { background: #e4f2e8; border: 1px solid #175e33; }
  small.muted { color: #667; }
`;

function Page(props: {
  identity: Identity;
  approvals: ApprovalRow[];
  ks: KillSwitchState;
  ksOperator: boolean;
  rate: RateCheck;
  topics: TopicCountRow[];
  published: PublishedRow[];
  audit: AuditRow[];
}) {
  const { identity, approvals, ks, ksOperator, rate, topics, published, audit } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia — Approvals</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{styles}</style>
      </head>
      <body>
        <h1>Arcadia — approval dashboard</h1>
        <p>
          Signed in as <strong>{identity.email}</strong> (via Cloudflare Access). Arcadia surfaces and
          attributes. You decide and sign.
        </p>

        <div class={`banner ${ks.engaged ? "engaged" : "ok"}`}>
          {ks.engaged ? (
            <span>
              <strong>KILL SWITCH ENGAGED</strong> by {ks.by ?? "unknown"} at {ks.at ?? "?"}
              {ks.reason ? ` — ${ks.reason}` : ""}
            </span>
          ) : (
            <span>Kill switch off. Publish runs are live.</span>
          )}{" "}
          {ksOperator ? (
            <form class="inline" method="post" action="/approval/kill-switch">
              <input type="hidden" name="action" value={ks.engaged ? "release" : "engage"} />
              <input type="text" name="reason" placeholder="reason" />
              <button class={ks.engaged ? "" : "kill"} type="submit">
                {ks.engaged ? "Release" : "ENGAGE KILL SWITCH"}
              </button>
            </form>
          ) : (
            <small class="muted">(kill switch operators only)</small>
          )}
        </div>

        <p>
          Rate ceiling: {rate.publishedToday}/{rate.perDay} today · {rate.publishedThisWeek}/{rate.perWeek} this
          week. Topics:{" "}
          {topics.map((t) => `${t.status} ${t.n}`).join(" · ") || "queue empty"}
        </p>

        <h2>Pending approvals ({approvals.length})</h2>
        {approvals.length === 0 ? (
          <p>
            <small class="muted">Nothing waiting on you.</small>
          </p>
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
                  <td>{a.kind === "hermes_publish" ? "Hermes publish" : "Doctrine ratify"}</td>
                  <td>
                    {a.summary ?? a.subject}{" "}
                    {a.kind === "hermes_publish" ? (
                      <a href={`/approval/draft/${a.workflow_id}`} target="_blank" rel="noreferrer">
                        preview draft
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

        <h2>Run Hermes now</h2>
        <form method="post" action="/approval/trigger">
          <input type="text" name="topicId" placeholder="topic id (blank = pick from queue)" />
          <button type="submit">Start publish run</button>
        </form>

        <h2>Add topic to queue</h2>
        <form method="post" action="/approval/topics">
          <input type="text" name="title" placeholder="How do I …" required />{" "}
          <input type="text" name="keywords" placeholder="comma,separated,keywords" />{" "}
          <button type="submit">Queue topic</button>
        </form>

        <h2>Propose doctrine (staging → ratification)</h2>
        <form method="post" action="/approval/doctrine">
          <input type="text" name="content" placeholder="e.g. Rate locks yes, discounts no." required />{" "}
          <button type="submit">Propose</button>
        </form>

        <h2>Recently published</h2>
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

        <h2>Audit tail</h2>
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
      </body>
    </html>
  );
}

async function renderDashboard(env: Env, identity: Identity): Promise<Response> {
  const approvals = (
    await env.DB.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`).all<ApprovalRow>()
  ).results;
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
      identity={identity}
      approvals={approvals}
      ks={await killSwitch(env)}
      ksOperator={canOperateKillSwitch(identity.email, env.KILL_SWITCH_OPERATORS)}
      rate={await checkRateCeiling(env)}
      topics={topics}
      published={published}
      audit={await recentAudit(env.DB, 25)}
    />
  );
}

async function decide(env: Env, identity: Identity, form: FormData): Promise<Response> {
  const approvalId = String(form.get("approvalId") ?? "");
  const decision = String(form.get("decision") ?? "");
  const reason = String(form.get("reason") ?? "") || undefined;
  const row = await env.DB
    .prepare(`SELECT * FROM approvals WHERE id = ?1 AND status = 'pending'`)
    .bind(approvalId)
    .first<ApprovalRow>();
  if (!row) return new Response("approval not found or already decided", { status: 404 });

  if (row.kind === "hermes_publish") {
    const hermes = await getAgentByName(env.Hermes, AGENT_INSTANCE);
    if (decision === "approve") await hermes.approvePublish(row.workflow_id, identity.email, reason);
    else await hermes.rejectPublish(row.workflow_id, identity.email, reason);
  } else {
    const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
    if (decision === "approve") await arcadia.approveRatify(row.workflow_id, identity.email, reason);
    else await arcadia.rejectRatify(row.workflow_id, identity.email, reason);
  }
  return redirectBack();
}

async function toggleKillSwitch(env: Env, identity: Identity, form: FormData): Promise<Response> {
  if (!canOperateKillSwitch(identity.email, env.KILL_SWITCH_OPERATORS)) {
    return new Response("kill switch is restricted to named operators", { status: 403 });
  }
  const engage = String(form.get("action")) === "engage";
  const reason = String(form.get("reason") ?? "") || undefined;
  await setKillSwitch(env, engage, identity.email, reason);
  await appendAudit(env.DB, {
    actor: identity.email,
    action: engage ? "kill_switch_engaged" : "kill_switch_released",
    detail: reason,
  });
  return redirectBack();
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

  if (request.method === "GET" && path === "/approval") {
    return renderDashboard(env, identity);
  }

  const draftMatch = /^\/approval\/draft\/([A-Za-z0-9_-]+)$/.exec(path);
  if (request.method === "GET" && draftMatch) {
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

  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  // CSRF guard: mutating routes accept only same-origin submissions. The
  // Access cookie would ride along on a cross-site form post; the dashboard
  // forms are all same-origin, so anything else is rejected.
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  const sameOrigin =
    (secFetchSite === null || secFetchSite === "same-origin" || secFetchSite === "none") &&
    (origin === null || origin === url.origin);
  if (!sameOrigin) return new Response("cross-origin form submission rejected", { status: 403 });
  const form = await request.formData();

  switch (path) {
    case "/approval/decide":
      return decide(env, identity, form);
    case "/approval/kill-switch":
      return toggleKillSwitch(env, identity, form);
    case "/approval/trigger": {
      const hermes = await getAgentByName(env.Hermes, AGENT_INSTANCE);
      const topicId = String(form.get("topicId") ?? "").trim() || undefined;
      await hermes.triggerPublish(topicId, identity.email);
      return redirectBack();
    }
    case "/approval/topics": {
      const title = String(form.get("title") ?? "").trim();
      if (!title) return new Response("title required", { status: 400 });
      const keywords = String(form.get("keywords") ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      await env.DB.prepare(`INSERT INTO topics (id, title, keywords) VALUES (?1, ?2, ?3)`)
        .bind(crypto.randomUUID(), title, JSON.stringify(keywords))
        .run();
      await appendAudit(env.DB, { actor: identity.email, action: "topic_queued", detail: title });
      return redirectBack();
    }
    case "/approval/doctrine": {
      const content = String(form.get("content") ?? "").trim();
      if (!content) return new Response("content required", { status: 400 });
      const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
      try {
        await arcadia.proposeDoctrine(content, identity.email, "dashboard");
      } catch (err) {
        // Contradiction halts (§5.6.2): surface both versions, don't 500.
        const message = err instanceof Error ? err.message : "doctrine proposal failed";
        if (message.includes("conflict")) return new Response(`Doctrine conflict — ${message}`, { status: 409 });
        throw err;
      }
      return redirectBack();
    }
    default:
      return new Response("not found", { status: 404 });
  }
}
