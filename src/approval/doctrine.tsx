// Doctrine intake and ratification. The single surface where doctrine enters
// Arcadia's memory, and the only place canonical is written.
//
// Three ways in, one way through:
//   - bulk seed (capture channel C, §5.5) — documents → staging
//   - a proposed entry — one statement → staging, with a ratify workflow
//   - capture channel D answers — a gap closed by Shane → staging
// and then, always, a human tap: staging → canonical (§5.6.1). Doctrine never
// auto-commits. That is the most important control in the system, and a bulk
// import is exactly the case it exists for.

import { getAgentByName } from "agents";
import { appendAudit } from "../lib/audit";
import { requireCapability, UnauthorizedError, type UserRecord } from "../lib/rbac";
import { DOCTRINE_CANONICAL, DOCTRINE_STAGING, type Memory } from "../memory/driver";
import { SEED_INBOX_PREFIX, stageDocument } from "../memory/seed";
import { html, Nav, rejectCrossOrigin, styles, Whoami } from "./dashboard";

const AGENT_INSTANCE = "main";
/** Entries per submit. Each promotion is a DO write plus a queue send. */
const MAX_BATCH = 50;
const STAGING_PAGE = 100;

interface SeedRunRow {
  id: string;
  requested_by: string;
  source: string;
  documents: string;
  parts_total: number;
  parts_done: number;
  written: number;
  duplicates: number;
  conflicts: number;
  status: string;
  detail: string | null;
  created_at: string;
}

interface ConflictRow {
  id: string;
  topic_key: string;
  existing_id: string;
  existing_text: string;
  incoming_text: string;
  created_at: string;
}

interface ViewData {
  staging: Memory[];
  /** Staging ids already owned by a pending ratify workflow — not batch-ratifiable. */
  workflowOwned: Set<string>;
  runs: SeedRunRow[];
  conflicts: ConflictRow[];
  canonicalCount: number;
}

function docNames(json: string): string {
  try {
    const parsed = JSON.parse(json) as string[];
    return parsed.length ? parsed.join(", ") : "—";
  } catch {
    return "—";
  }
}

function DoctrinePage(props: { user: UserRecord; data: ViewData; notice?: string }) {
  const { user, data, notice } = props;
  const { staging, workflowOwned, runs, conflicts, canonicalCount } = data;
  const ratifiable = staging.filter((m) => !workflowOwned.has(m.id));

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia — doctrine</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{styles}</style>
      </head>
      <body>
        <h1>Doctrine</h1>
        <Nav user={user} current="doctrine" />
        <Whoami user={user} />

        {notice ? <p class="banner ok">{notice}</p> : null}

        <p class={canonicalCount === 0 ? "banner warn" : undefined}>
          {canonicalCount === 0 ? (
            <>
              <strong>Canonical doctrine is empty.</strong> Until something is ratified, Arcadia can only
              escalate — she has nothing to cite. Seed documents below, then ratify what survives review.
            </>
          ) : (
            <small class="muted">
              {canonicalCount} ratified {canonicalCount === 1 ? "entry" : "entries"} in{" "}
              <code>sfx-doctrine-canonical</code> · {ratifiable.length} awaiting your tap
            </small>
          )}
        </p>

        <h2 id="seed">Seed documents</h2>
        <p>
          <small class="muted">
            Runs the §5.3 pipeline — broad extraction, a mandatory detail sweep for figures, verification
            against the source — and lands candidates in staging. Nothing reaches canonical without your tap
            below. A long document takes several minutes; the run keeps going after you close the page.
          </small>
        </p>
        <form method="post" action="/approval/doctrine/seed">
          <p>
            <input type="text" name="name" placeholder="document name, e.g. pricing-history.md" required style="min-width:24rem" />
          </p>
          <p>
            <textarea name="content" rows={10} placeholder="Paste the document here…" required />
          </p>
          <button type="submit">Seed this document</button>
        </form>
        <h3>Or seed a batch already in R2</h3>
        <p>
          <small class="muted">
            Upload first, then seed everything under the prefix:
            <br />
            <code>wrangler r2 object put arcadia-artifacts/{SEED_INBOX_PREFIX}pricing.md --file=pricing.md</code>
          </small>
        </p>
        <form method="post" action="/approval/doctrine/seed">
          <input type="hidden" name="source" value="r2" />
          <input type="text" name="prefix" value={SEED_INBOX_PREFIX} style="min-width:20rem" />{" "}
          <button type="submit">Seed the prefix</button>
        </form>

        {runs.length ? (
          <>
            <h2 id="runs">Seed runs</h2>
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Documents</th>
                  <th>Progress</th>
                  <th>Staged</th>
                  <th>Dupes</th>
                  <th>Conflicts</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr>
                    <td>
                      <small class="muted">{r.created_at}</small>
                      <br />
                      <small class="muted">{r.requested_by}</small>
                    </td>
                    <td>{docNames(r.documents)}</td>
                    <td>
                      {r.parts_done}/{r.parts_total || "?"}
                    </td>
                    <td>{r.written}</td>
                    <td>
                      <small class="muted">{r.duplicates}</small>
                    </td>
                    <td class={r.conflicts > 0 ? "sev-day5" : undefined}>{r.conflicts}</td>
                    <td class={r.status === "failed" ? "sev-day7" : undefined}>
                      {r.status}
                      {r.detail ? (
                        <>
                          <br />
                          <small class="muted">{r.detail}</small>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {conflicts.length ? (
          <>
            <h2 id="conflicts">Conflicts to resolve ({conflicts.length})</h2>
            <p>
              <small class="muted">
                Two candidates claim the same topic. Contradiction halts — Arcadia will not pick (§5.6.2).
                Keeping the incoming version supersedes the one already in staging; dismissing it drops the
                incoming statement.
              </small>
            </p>
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Already staged</th>
                  <th>Incoming</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr>
                    <td>
                      <code>{c.topic_key}</code>
                    </td>
                    <td>{c.existing_text}</td>
                    <td>{c.incoming_text}</td>
                    <td>
                      <form class="inline" method="post" action="/approval/doctrine/conflict">
                        <input type="hidden" name="id" value={c.id} />
                        <button name="action" value="keep-incoming" type="submit">
                          Keep incoming
                        </button>{" "}
                        <button name="action" value="dismiss" type="submit">
                          Dismiss
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <h2 id="staging">Staging queue ({staging.length})</h2>
        <p>
          <small class="muted">
            Every entry you tick is promoted under your name and carries it forever (§5.6.4). Read the
            figures: the detail sweep is the pass that captures rates, dates and term lengths, and it is
            also the pass most worth checking. Up to {MAX_BATCH} at a time.
          </small>
        </p>
        {staging.length === 0 ? (
          <p>
            <small class="muted">Staging is empty. Seed a document above.</small>
          </p>
        ) : (
          <form method="post" action="/approval/doctrine/ratify">
            <table>
              <thead>
                <tr>
                  <th />
                  <th>Statement</th>
                  <th>Topic</th>
                  <th>Kind</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {staging.map((m) => {
                  const owned = workflowOwned.has(m.id);
                  const unverified = m.provenance.capturedFrom.includes("unverified");
                  return (
                    <tr>
                      <td>
                        {owned ? (
                          <small class="muted">—</small>
                        ) : (
                          <input type="checkbox" name="id" value={m.id} />
                        )}
                      </td>
                      <td>{m.content}</td>
                      <td>
                        <code>{m.topicKey}</code>
                      </td>
                      <td>
                        <small class="muted">{m.kind}</small>
                      </td>
                      <td>
                        <small class={unverified ? "sev-day5" : "muted"}>
                          {m.provenance.capturedFrom}
                          {unverified ? " — unverified" : ""}
                        </small>
                        <br />
                        <small class="muted">{m.provenance.sessionId ?? ""}</small>
                        {owned ? (
                          <>
                            <br />
                            <small class="muted">awaiting its approval in Operations</small>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p>
              <button class="approve" name="action" value="ratify" type="submit">
                Ratify selected
              </button>{" "}
              <button class="reject" name="action" value="discard" type="submit">
                Discard selected
              </button>
            </p>
          </form>
        )}

        <h2 id="propose">Propose a single entry</h2>
        <p>
          <small class="muted">
            Goes to staging with its own ratification workflow; approve it from the Operations panel.
          </small>
        </p>
        <form method="post" action="/approval/doctrine/propose">
          <input type="text" name="content" placeholder="e.g. Rate locks yes, discounts no." required style="min-width:32rem" />{" "}
          <button type="submit">Propose</button>
        </form>
      </body>
    </html>
  );
}

/** RPC returns carry a disposer; rebuild plain objects before they cross again. */
function plainMemory(m: Memory): Memory {
  return {
    id: m.id,
    profile: m.profile,
    content: m.content,
    kind: m.kind,
    topicKey: m.topicKey,
    ...(m.supersedes ? { supersedes: m.supersedes } : {}),
    ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}),
    provenance: {
      capturedFrom: m.provenance.capturedFrom,
      capturedAt: m.provenance.capturedAt,
      ...(m.provenance.ratifiedBy ? { ratifiedBy: m.provenance.ratifiedBy } : {}),
      ...(m.provenance.sessionId ? { sessionId: m.provenance.sessionId } : {}),
    },
    createdAt: m.createdAt,
    ...(m.lastRecalledAt ? { lastRecalledAt: m.lastRecalledAt } : {}),
  };
}

async function viewData(env: Env): Promise<ViewData> {
  const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
  const canonical = await getAgentByName(env.MemoryProfile, DOCTRINE_CANONICAL);
  const entries = (await staging.listMemories({ limit: STAGING_PAGE })).map(plainMemory);

  // An entry with a pending RatifyWorkflow is decided in Operations. Promoting
  // it here would strand that workflow waiting on an event that never comes,
  // and leave an orphan row in the approval queue.
  const pending = await env.DB.prepare(
    `SELECT subject FROM approvals WHERE kind = 'doctrine_ratify' AND status = 'pending'`
  ).all<{ subject: string }>();

  const runs = (
    await env.DB.prepare(`SELECT * FROM seed_runs ORDER BY created_at DESC LIMIT 10`).all<SeedRunRow>()
  ).results;
  const conflicts = (
    await env.DB.prepare(
      `SELECT id, topic_key, existing_id, existing_text, incoming_text, created_at
       FROM seed_conflicts WHERE status = 'open' ORDER BY created_at DESC LIMIT 50`
    ).all<ConflictRow>()
  ).results;

  return {
    staging: entries,
    workflowOwned: new Set(pending.results.map((p) => p.subject)),
    runs,
    conflicts,
    canonicalCount: (await canonical.listMemories({ limit: 1000 })).length,
  };
}

function backToDoctrine(fragment = ""): Response {
  return new Response(null, { status: 303, headers: { Location: `/approval/doctrine${fragment}` } });
}

async function startSeed(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ratify_doctrine");
  const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);

  if (String(form.get("source") ?? "") === "r2") {
    const prefix = String(form.get("prefix") ?? "").trim();
    if (!prefix) return new Response("prefix required", { status: 400 });
    await arcadia.startDoctrineSeed({ source: "r2", prefix, requestedBy: user.email });
    return backToDoctrine("#runs");
  }

  const name = String(form.get("name") ?? "").trim();
  const content = String(form.get("content") ?? "").trim();
  if (!name || !content) return new Response("document name and content required", { status: 400 });

  // Parts are staged before the workflow starts so its steps stay small and
  // the run is resumable without the original request.
  const runId = crypto.randomUUID();
  try {
    await stageDocument(env, runId, name, content);
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "could not stage document", { status: 400 });
  }
  await arcadia.startDoctrineSeed({
    source: "paste",
    documents: [name],
    requestedBy: user.email,
    stagedRunId: runId,
  });
  return backToDoctrine("#runs");
}

async function ratifyOrDiscard(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ratify_doctrine");
  const ids = form.getAll("id").map(String).filter(Boolean).slice(0, MAX_BATCH);
  if (ids.length === 0) return backToDoctrine("#staging");
  const discard = String(form.get("action") ?? "ratify") === "discard";

  const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
  const canonical = await getAgentByName(env.MemoryProfile, DOCTRINE_CANONICAL);

  // Never promote something a workflow is already waiting to decide.
  const pending = await env.DB.prepare(
    `SELECT subject FROM approvals WHERE kind = 'doctrine_ratify' AND status = 'pending'`
  ).all<{ subject: string }>();
  const owned = new Set(pending.results.map((p) => p.subject));

  let done = 0;
  let conflicted = 0;
  let skipped = 0;

  for (const id of ids) {
    if (owned.has(id)) {
      skipped++;
      continue;
    }
    const memory = await staging.getMemory(id);
    if (!memory) {
      skipped++;
      continue;
    }

    if (discard) {
      await staging.forgetMemory(id);
      await appendAudit(env.DB, {
        actor: user.email,
        action: "doctrine_candidate_discarded",
        subject: id,
        detail: memory.content.slice(0, 300),
      });
      done++;
      continue;
    }

    const outcome = await canonical.promoteMemory(plainMemory(memory), user.email);
    if (outcome.status === "conflict") {
      // Canonical already holds a head entry on this topic. Surface both;
      // never overwrite silently (§5.6.2).
      await env.DB.prepare(
        `INSERT OR IGNORE INTO seed_conflicts
           (id, run_id, topic_key, existing_id, existing_text, incoming_text)
         VALUES (?1, 'ratify', ?2, ?3, ?4, ?5)`
      )
        .bind(
          crypto.randomUUID(),
          memory.topicKey,
          outcome.existing.id,
          outcome.existing.content.slice(0, 2000),
          memory.content.slice(0, 2000)
        )
        .run();
      await appendAudit(env.DB, {
        actor: "arcadia",
        action: "doctrine_conflict",
        subject: id,
        detail: `HALT: canonical ${outcome.existing.id} already holds topic "${memory.topicKey}". ${user.email} must supersede explicitly.`,
      });
      conflicted++;
      continue;
    }

    await staging.forgetMemory(id);
    await appendAudit(env.DB, {
      actor: user.email,
      action: "doctrine_ratified",
      subject: id,
      detail: memory.content.slice(0, 300),
    });
    done++;
  }

  const parts = [
    `${done} ${discard ? "discarded" : "ratified"}`,
    conflicted ? `${conflicted} halted on conflict` : "",
    skipped ? `${skipped} skipped` : "",
  ].filter(Boolean);
  return await render(env, user, parts.join(" · "));
}

async function resolveConflict(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ratify_doctrine");
  const id = String(form.get("id") ?? "");
  const action = String(form.get("action") ?? "");
  const row = await env.DB.prepare(`SELECT * FROM seed_conflicts WHERE id = ?1 AND status = 'open'`)
    .bind(id)
    .first<ConflictRow>();
  if (!row) return backToDoctrine("#conflicts");

  if (action === "keep-incoming") {
    // Supersession, never deletion (§5.6.3): tombstone the staged head, then
    // write the incoming statement in its place.
    const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);
    await staging.forgetMemory(row.existing_id);
    await staging.putMemory({
      content: row.incoming_text,
      kind: "fact",
      topicKey: row.topic_key,
      provenance: {
        capturedFrom: `conflict-resolution:${user.email}`,
        capturedAt: new Date().toISOString(),
      },
      via: "direct",
    });
  }

  await env.DB.prepare(
    `UPDATE seed_conflicts SET status = 'resolved', resolved_by = ?1 WHERE id = ?2`
  )
    .bind(user.email, id)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: action === "keep-incoming" ? "doctrine_conflict_superseded" : "doctrine_conflict_dismissed",
    subject: row.topic_key,
    detail: (action === "keep-incoming" ? row.incoming_text : row.existing_text).slice(0, 300),
  });
  return backToDoctrine("#conflicts");
}

async function render(env: Env, user: UserRecord, notice?: string): Promise<Response> {
  return html(
    <DoctrinePage user={user} data={await viewData(env)} {...(notice ? { notice } : {})} />
  );
}

/** Router for /approval/doctrine*. Returns undefined for paths it does not own. */
export async function handleDoctrineRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/approval/doctrine")) return undefined;

  try {
    if (request.method === "GET" && path === "/approval/doctrine") {
      requireCapability(user, "ratify_doctrine");
      return await render(env, user);
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    if (path === "/approval/doctrine/seed") return await startSeed(env, user, form);
    if (path === "/approval/doctrine/ratify") return await ratifyOrDiscard(env, user, form);
    if (path === "/approval/doctrine/conflict") return await resolveConflict(env, user, form);

    if (path === "/approval/doctrine/propose") {
      requireCapability(user, "ratify_doctrine");
      const content = String(form.get("content") ?? "").trim();
      if (!content) return new Response("content required", { status: 400 });
      const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
      try {
        await arcadia.proposeDoctrine(content, user.email, "dashboard");
      } catch (err) {
        // Contradiction halts (§5.6.2): surface both versions, don't 500.
        const message = err instanceof Error ? err.message : "doctrine proposal failed";
        if (message.includes("conflict")) return new Response(`Doctrine conflict — ${message}`, { status: 409 });
        throw err;
      }
      return backToDoctrine("#staging");
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
