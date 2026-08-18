// Doctrine intake and ratification. The single surface where doctrine enters
// Arcadia's memory, and the only place canonical is written.
//
// Three ways in, one way through:
//   - bulk seed (capture channel C, §5.5) — uploaded, pasted or R2 documents
//     → staging
//   - a proposed entry — one statement → staging, with a ratify workflow
//   - capture channel D answers — a gap closed by Shane → staging
// and then, always, a human tap: staging → canonical (§5.6.1). Doctrine never
// auto-commits. That is the most important control in the system, and a bulk
// import is exactly the case it exists for.

import { getAgentByName } from "agents";
import { appendAudit } from "../lib/audit";
import { requireCapability, UnauthorizedError, type UserRecord } from "../lib/rbac";
import { DOCTRINE_CANONICAL, DOCTRINE_STAGING, type Memory } from "../memory/driver";
import FOUNDATION_DOCTRINE from "../../doctrine/sfx-doctrine-foundation.md";
import { parseCuratedDoctrine, summarize } from "../memory/curated";
import { SEED_INBOX_PREFIX, stageDocument, stageUploads } from "../memory/seed";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, UPLOAD_ACCEPT, UPLOAD_EXTENSIONS } from "../memory/upload";
import { html, rejectCrossOrigin, Shell } from "./shell";

const AGENT_INSTANCE = "main";
/** Entries per submit. Each promotion is a DO write plus a queue send. */
const MAX_BATCH = 50;
const STAGING_PAGE = 100;
/**
 * Refuse an oversized upload from the headers, before formData() buffers it
 * into the isolate. The slack covers multipart boundaries and part headers.
 */
const UPLOAD_BODY_LIMIT = MAX_UPLOAD_BYTES + 100_000;

/** The curated corpus that ships with the Worker, versioned in git. */
const FOUNDATION_NAME = "sfx-doctrine-foundation.md";
/** Typed by hand before a replace runs. A destructive control needs a deliberate act, not a click. */
const REPLACE_CONFIRMATION = "REPLACE";

/**
 * Conflict resolution, without the round trip.
 *
 * Every decision used to POST, redirect, and re-render the whole doctrine
 * surface — the staging queue, the runs table, the canonical count — to strike
 * one row. Forty-six conflicts is forty-six full page loads, and the queue
 * stops being something anyone works through.
 *
 * The row goes the moment it is clicked and the request follows; a failure
 * puts it back and says why. The form still posts on its own without any of
 * this, so a browser with scripting off keeps the old behaviour rather than
 * losing the button.
 */
const CONFLICT_SCRIPT = `
(function () {
  var section = document.getElementById('conflicts');
  if (!section || !window.fetch) return;
  var counter = document.getElementById('conflict-count');
  var problem = document.getElementById('conflict-problem');
  var open = Number(counter && counter.textContent) || 0;
  var inFlight = 0;

  function paint() { if (counter) counter.textContent = String(open); }

  function fail(message) {
    if (!problem) return;
    problem.textContent = message;
    problem.hidden = false;
  }

  section.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.matches('form[data-conflict]')) return;
    var decision = event.submitter && event.submitter.value;
    if (!decision) return;
    event.preventDefault();

    var row = form.closest('tr');
    var body = new FormData(form);
    body.set('action', decision);
    row.hidden = true;
    open = Math.max(0, open - 1);
    paint();
    inFlight++;

    fetch(form.action, {
      method: 'POST',
      body: body,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        row.remove();
        inFlight--;
        // Reconcile only once nothing else is in the air: replies can land
        // out of order, and a stale count is worse than a slightly late one.
        if (inFlight === 0 && typeof data.remaining === 'number') {
          open = data.remaining;
          paint();
          if (open === 0) section.remove();
        }
      })
      .catch(function (err) {
        inFlight--;
        row.hidden = false;
        open = open + 1;
        paint();
        fail('That conflict was not resolved (' + err.message + '). It is still open.');
      });
  });
})();
`;

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

function DoctrinePage(props: { user: UserRecord; data: ViewData; notice?: string; problem?: string }) {
  const { user, data, notice, problem } = props;
  const { staging, workflowOwned, runs, conflicts, canonicalCount } = data;
  const ratifiable = staging.filter((m) => !workflowOwned.has(m.id));
  const foundation = summarize(parseCuratedDoctrine(FOUNDATION_DOCTRINE));

  return (
    <Shell
      title="Arcadia — doctrine"
      heading="Doctrine"
      user={user}
      current="doctrine"
      lede="The only path into canonical memory. Documents land in staging; nothing is ratified without your tap."
    >
      {notice ? <p class="banner ok">{notice}</p> : null}
      {problem ? <p class="banner warn">{problem}</p> : null}

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

      <p class="jump">
        <a href="#seed">Seed documents</a>
        <a href="#staging">Staging queue</a>
        <a href="#replace">Replace canonical</a>
      </p>

      <h2 id="seed">Seed documents</h2>
      <p>
        <small class="muted">
          Runs the §5.3 pipeline — broad extraction, a mandatory detail sweep for figures, verification
          against the source — and lands candidates in staging. Nothing reaches canonical without your tap
          below. A long document takes several minutes; the run keeps going after you close the page.
        </small>
      </p>
      <h3>Upload markdown files</h3>
      <p>
        <small class="muted">
          {UPLOAD_EXTENSIONS.join(", ")} — up to {MAX_UPLOAD_FILES} files and{" "}
          {Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB per submission. Headings travel with the text
          under them, so a rate written under <code>## Retainers</code> reaches the extractor as a rate
          about retainers rather than a loose figure. The file itself is kept, so a candidate can always
          be read back against the document it came from.
        </small>
      </p>
      <form method="post" action="/approval/doctrine/upload" enctype="multipart/form-data">
        <p>
          <input type="file" name="file" accept={UPLOAD_ACCEPT} multiple required />
        </p>
        <button class="primary" type="submit">
          Upload and seed
        </button>
      </form>

      <h3>Or paste one document</h3>
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
          For files already in the bucket — put them there with wrangler, then seed the prefix:
          <br />
          <code>wrangler r2 object put arcadia-artifacts/{SEED_INBOX_PREFIX}pricing.md --file=pricing.md</code>
        </small>
      </p>
      <form class="inline" method="post" action="/approval/doctrine/seed">
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
        <section id="conflicts">
          <h2>
            Conflicts to resolve (<span id="conflict-count">{conflicts.length}</span>)
          </h2>
          <p id="conflict-problem" class="banner warn" hidden />
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
                <tr id={`conflict-${c.id}`}>
                  <td>
                    <code>{c.topic_key}</code>
                  </td>
                  <td>{c.existing_text}</td>
                  <td>{c.incoming_text}</td>
                  <td>
                    <form class="inline" method="post" action="/approval/doctrine/conflict" data-conflict>
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
          <script dangerouslySetInnerHTML={{ __html: CONFLICT_SCRIPT }} />
        </section>
      ) : null}

      <h2 id="staging">Staging queue ({staging.length})</h2>
      <p>
        <small class="muted">
          Every entry you tick is promoted under your name and carries it forever (§5.6.4). Read the
          figures: the detail sweep is the pass that captures rates, dates and term lengths, and it is also
          the pass most worth checking. Up to {MAX_BATCH} at a time.
        </small>
      </p>
      {staging.length === 0 ? (
        <p class="empty">Staging is empty. Seed a document above.</p>
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

      <h2 id="replace">Replace canonical doctrine</h2>
      <p>
        <small class="muted">
          The curated route. <code>{FOUNDATION_NAME}</code> ships with the Worker and is versioned in
          git; this reads its numbered statements directly — no extraction, no paraphrase — and writes
          them into <code>sfx-doctrine-canonical</code> under your name. It is the one path that writes
          canonical without staging, and it exists because a document the ratifying authority wrote by
          hand does not need a model to restate it.
        </small>
      </p>
      <div class="banner warn">
        <span>
          <strong>This replaces everything.</strong> Canonical and staging are both emptied and the open
          conflicts closed, then the {foundation.total} entries below are written. A JSON export of both
          profiles goes to R2 first, so the old corpus is recoverable — but it is out of recall the moment
          this runs.
        </span>
      </div>
      <p>
        <small class="muted">
          {FOUNDATION_NAME} parses to <strong>{foundation.total}</strong> entries —{" "}
          {foundation.numbered} numbered statements and {foundation.notes} section notes ·{" "}
          {foundation.hard} marked <code>[HARD]</code> · {foundation.judgment} <code>[JUDGMENT]</code> ·{" "}
          <span class={foundation.verify.length ? "sev-day5" : undefined}>
            {foundation.verify.length} <code>[VERIFY]</code>
          </span>
          {foundation.verify.length ? (
            <>
              {" "}
              (items {foundation.verify.map((e) => e.number).join(", ")} — the document asks that these be
              confirmed before they are relied on; they import with the marker intact)
            </>
          ) : null}
          .
        </small>
      </p>
      <form class="inline" method="post" action="/approval/doctrine/replace">
        <input
          type="text"
          name="confirm"
          placeholder={`type ${REPLACE_CONFIRMATION}`}
          autocomplete="off"
          required
          style="min-width:12rem"
        />{" "}
        <button class="kill" type="submit">
          Replace canonical doctrine
        </button>
      </form>

      <h2 id="propose">Propose a single entry</h2>
      <p>
        <small class="muted">
          Goes to staging with its own ratification workflow; approve it from the Operations panel.
        </small>
      </p>
      <form class="inline" method="post" action="/approval/doctrine/propose">
        <input type="text" name="content" placeholder="e.g. Rate locks yes, discounts no." required style="min-width:32rem" />{" "}
        <button class="primary" type="submit">
          Propose
        </button>
      </form>
    </Shell>
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
    canonicalCount: await canonical.countMemories(),
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

/**
 * Seed uploaded files (capture channel C, §5.5).
 *
 * Partial success is the normal case in a batch — nine good documents and a
 * renamed PDF — so this renders the surface with what happened rather than
 * failing the whole submission. Every refused file is named with its reason:
 * a file that vanishes without a word is a piece of doctrine nobody knows is
 * missing.
 */
async function uploadSeed(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ratify_doctrine");

  // An untouched file input still posts one empty part.
  const files = form
    .getAll("file")
    .filter((value): value is File => value instanceof File)
    .filter((file) => file.size > 0 || file.name !== "");
  if (files.length === 0) {
    return await render(env, user, { problem: "Choose at least one markdown file to upload." });
  }

  // Parts are staged before the workflow starts, for the same reason a paste
  // is: the workflow id does not exist yet, and staging afterwards would race
  // the first step.
  const runId = crypto.randomUUID();
  const staged = await stageUploads(env, runId, files);
  const skipped = staged.skipped.map((s) => `${s.name} — ${s.reason}`);

  if (staged.documents.length === 0) {
    return await render(env, user, {
      problem: `Nothing seeded. ${skipped.join(" · ") || "No readable text in that submission."}`,
    });
  }

  const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
  await arcadia.startDoctrineSeed({
    source: "upload",
    documents: staged.documents,
    requestedBy: user.email,
    stagedRunId: runId,
  });

  return await render(env, user, {
    notice: `Seeding ${staged.documents.length} document(s) in ${staged.parts} part(s): ${staged.documents.join(
      ", "
    )}. Candidates appear in staging as the run works through them.`,
    ...(skipped.length ? { problem: `Skipped ${skipped.length}: ${skipped.join(" · ")}` } : {}),
  });
}

/**
 * Replace canonical doctrine with the curated corpus.
 *
 * Everything here is one human's decision, executed once: the confirmation is
 * typed, the capability is checked, both profiles are exported to R2 before
 * they are emptied, and the audit row names who did it and what landed. What
 * this does not do is decide anything — Arcadia never writes canonical on her
 * own, and this route is only reachable with a ratifier's hands on it.
 */
async function replaceCanonical(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ratify_doctrine");
  if (String(form.get("confirm") ?? "").trim() !== REPLACE_CONFIRMATION) {
    return await render(env, user, {
      problem: `Nothing was replaced. Type ${REPLACE_CONFIRMATION} to confirm — this empties canonical and staging.`,
    });
  }

  const entries = parseCuratedDoctrine(FOUNDATION_DOCTRINE);
  if (entries.length === 0) {
    return await render(env, user, { problem: `${FOUNDATION_NAME} parsed to no entries. Nothing was replaced.` });
  }

  const runId = crypto.randomUUID();
  const canonical = await getAgentByName(env.MemoryProfile, DOCTRINE_CANONICAL);
  const staging = await getAgentByName(env.MemoryProfile, DOCTRINE_STAGING);

  const result = await canonical.replaceWithCurated(
    entries.map((e) => ({ content: e.text, kind: e.kind, topicKey: e.topicKey })),
    { ratifiedBy: user.email, document: FOUNDATION_NAME, sessionId: `curated:${runId}` }
  );
  // The staging queue and its conflicts belong to the corpus being retired.
  // Leaving them would offer a ratifier candidates that contradict the
  // document that just replaced them.
  const cleared = await staging.purge();
  const conflicts = await env.DB.prepare(
    `UPDATE seed_conflicts SET status = 'resolved', resolved_by = ?1 WHERE status = 'open'`
  )
    .bind(user.email)
    .run();

  const summary = summarize(entries);
  await appendAudit(env.DB, {
    actor: user.email,
    action: "doctrine_canonical_replaced",
    subject: FOUNDATION_NAME,
    detail: `${result.written} entries written to canonical (${result.removed} removed, backup ${result.backupKey}); staging purged of ${cleared.removed} (backup ${cleared.backupKey}); ${conflicts.meta.changes ?? 0} open conflicts closed. ${summary.hard} HARD, ${summary.judgment} JUDGMENT, ${summary.verify.length} VERIFY.`,
  });

  const verify = summary.verify.map((e) => e.number).filter((n) => n > 0);
  return await render(env, user, {
    notice: `Canonical doctrine replaced from ${FOUNDATION_NAME}: ${result.written} entries under your name. Retired ${result.removed} canonical and ${cleared.removed} staged entries (exports: ${result.backupKey}, ${cleared.backupKey}). Vectorization runs in the background.`,
    ...(verify.length
      ? {
          problem: `Imported with [VERIFY] still on them — items ${verify.join(", ")}. The document asks that these be confirmed before they are relied on.`,
        }
      : {}),
  });
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
  return await render(env, user, { notice: parts.join(" · ") });
}

async function resolveConflict(
  request: Request,
  env: Env,
  user: UserRecord,
  form: FormData
): Promise<Response> {
  requireCapability(user, "ratify_doctrine");
  // The surface asks for JSON; a plain form post does not. Answering the page
  // means rebuilding it, which is the whole cost this avoids.
  const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
  const id = String(form.get("id") ?? "");
  const action = String(form.get("action") ?? "");
  const row = await env.DB.prepare(`SELECT * FROM seed_conflicts WHERE id = ?1 AND status = 'open'`)
    .bind(id)
    .first<ConflictRow>();
  // Already decided — by another tab, or a double click. Not an error: the
  // row is gone either way, which is what the caller wanted.
  if (!row) return wantsJson ? await conflictJson(env, id) : backToDoctrine("#conflicts");

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
  return wantsJson ? await conflictJson(env, id) : backToDoctrine("#conflicts");
}

/** What the surface needs to strike the row: the id it decided, and how many are left. */
async function conflictJson(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM seed_conflicts WHERE status = 'open'`
  ).first<{ n: number }>();
  return Response.json({ ok: true, id, remaining: row?.n ?? 0 });
}

async function render(
  env: Env,
  user: UserRecord,
  banners: { notice?: string; problem?: string } = {},
  status = 200
): Promise<Response> {
  const { notice, problem } = banners;
  return html(
    <DoctrinePage
      user={user}
      data={await viewData(env)}
      {...(notice ? { notice } : {})}
      {...(problem ? { problem } : {})}
    />,
    status
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

    // Checked before the body is read: formData() buffers the whole upload.
    if (
      path === "/approval/doctrine/upload" &&
      Number(request.headers.get("content-length") ?? 0) > UPLOAD_BODY_LIMIT
    ) {
      return new Response(
        `That submission is over the ${Math.round(MAX_UPLOAD_BYTES / 1_000_000)} MB upload limit. Send fewer files.`,
        { status: 413 }
      );
    }
    const form = await request.formData();

    if (path === "/approval/doctrine/replace") return await replaceCanonical(env, user, form);
    if (path === "/approval/doctrine/upload") return await uploadSeed(env, user, form);
    if (path === "/approval/doctrine/seed") return await startSeed(env, user, form);
    if (path === "/approval/doctrine/ratify") return await ratifyOrDiscard(env, user, form);
    if (path === "/approval/doctrine/conflict") return await resolveConflict(request, env, user, form);

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
    // Anything else would reach the operator as Cloudflare's 1101 page, which
    // names nothing and sends them to the logs — and doctrine work stops until
    // someone reads them. Name the failure on the surface instead. A seed run
    // that already started keeps running; the runs table is where it shows up.
    console.error("doctrine", err);
    const reason = err instanceof Error ? err.message : String(err);
    try {
      return await render(env, user, { problem: `That failed: ${reason}` }, 500);
    } catch {
      return new Response(`Doctrine surface failed: ${reason}`, { status: 500 });
    }
  }
}
