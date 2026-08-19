// Ask Arcadia — the front door at "/" (§4 Phase 2, dashboard surface; the
// Teams surface arrives with the Azure Bot registration).
//
// Multi-turn, because doctrine questions arrive as follow-ups ("and deferred
// payment?") that mean nothing read alone. The conversation is per person and
// persisted in D1; the model sees a bounded window of it.
//
// Cited vs Inferred (doctrine §12.3). She always answers. Cited quotes
// ratified doctrine. Inferred is a labeled Shane-style read so staff keep
// moving; those answers are logged as gap candidates for Shane to batch.

import { getAgentByName } from "agents";
import type { ChatTurn } from "../agents/arcadia";
import { parseCitationPayload, serializeCitationPayload } from "../lib/ask";
import { appendAudit } from "../lib/audit";
import { can, requireCapability, UnauthorizedError, type UserRecord } from "../lib/rbac";
import type { Identity } from "../lib/rbac";
import { readUserGraphTokens, userGraphConnected } from "../integrations/graph-user";
import { CHAT_LIVE_SCRIPT } from "./chat-live";
import { html, rejectCrossOrigin, Shell } from "./shell";

const AGENT_INSTANCE = "main";
/** Turns replayed to the model — enough for a follow-up chain, bounded so a long conversation cannot grow the prompt without limit. */
const CONTEXT_TURNS = 8;
/** Turns rendered on the page. */
const PAGE_TURNS = 40;
const MAX_QUESTION_CHARS = 2000;

interface ChatRow {
  seq: number;
  role: "user" | "arcadia";
  content: string;
  citations: string;
  escalated: number;
  gap_id: string | null;
  created_at: string;
}

interface GapRow {
  id: string;
  question: string;
  asked_by: string;
  times_asked: number;
  created_at: string;
}

function Turn(props: { row: ChatRow; last: boolean }) {
  const { row, last } = props;
  const payload = parseCitationPayload(row.citations);
  const mode = payload.mode;
  return (
    <div
      class={`turn ${row.role}${mode === "inferred" ? " inferred" : ""}`}
      {...(last ? { id: "latest" } : {})}
    >
      <span class="who">
        {row.role === "user" ? "You" : "Arcadia"} · {row.created_at}
      </span>
      <div class="bubble">{row.content}</div>
      {row.role === "arcadia" ? (
        <small class="muted">
          {mode === "inferred" ? (
            <>
              Inferred — adjacent doctrine as gravity, not a citation.
              {row.gap_id ? (
                <>
                  {" "}
                  Logged as gap <code>{row.gap_id}</code> · <a href="/chat/gaps">open gaps</a>
                </>
              ) : null}
            </>
          ) : payload.ids.length ? (
            <>Cited · {payload.ids.join(" · ")}</>
          ) : (
            <>Cited — no entry ids recorded.</>
          )}
        </small>
      ) : null}
    </div>
  );
}

function ChatPage(props: {
  user: UserRecord;
  messages: ChatRow[];
  canAsk: boolean;
  graphConnected: boolean;
}) {
  const { user, messages, canAsk, graphConnected } = props;
  return (
    <Shell
      title="Arcadia"
      heading="Ask Arcadia"
      user={user}
      current="chat"
      lede={
        <>
          S-FX virtual assistant in Shane's voice. Cited when doctrine covers it; Inferred when it
          does not — still a usable answer, labeled, and logged as a gap.{" "}
          <a href="/chat/gaps">Open doctrine gaps</a>
        </>
      }
    >
      {!canAsk ? (
        <p class="banner warn">
          Your account cannot query the memory core. Ask your lead for the <code>ask_arcadia</code>{" "}
          capability.
        </p>
      ) : (
        <>
          {!graphConnected ? (
            <p class="banner warn">
              Microsoft 365 is not connected for your account. Arcadia can still talk; she cannot see
              your Planner, mail, chats, or calendar.{" "}
              <a href="/auth/graph">Connect my Microsoft 365</a>
            </p>
          ) : null}
          <div id="thread" data-last-seq={messages.at(-1)?.seq ?? 0}>
          {messages.length === 0 ? (
            <p class="empty">
              Nothing asked yet. Try: <em>Would it be ok to tell Dan this schedule change?</em>
            </p>
          ) : (
            messages.map((m, i) => <Turn row={m} last={i === messages.length - 1} />)
          )}
          </div>

          <div class="composer">
            <form id="ask-form" method="post" action="/chat/send">
              <input
                type="text"
                name="question"
                placeholder="Ask Arcadia…"
                maxLength={MAX_QUESTION_CHARS}
                autofocus
                required
              />
              <p>
                <button class="primary" type="submit">
                  Send
                </button>
                <small class="muted">
                  {messages.length ? (
                    <>
                      {messages.length} turn{messages.length === 1 ? "" : "s"} in this conversation ·{" "}
                    </>
                  ) : null}
                  <a href="/approval/ops">Operations panel</a>
                </small>
              </p>
            </form>
            {messages.length ? (
              <form class="inline" method="post" action="/chat/clear">
                <button type="submit">Clear conversation</button>{" "}
                <small class="muted">
                  Clears the transcript only. Every answer stays in the audit log with the doctrine that
                  produced it.
                </small>
              </form>
            ) : null}
          </div>
          <script dangerouslySetInnerHTML={{ __html: CHAT_LIVE_SCRIPT }} />
        </>
      )}
    </Shell>
  );
}

function GapsPage(props: { user: UserRecord; gaps: GapRow[] }) {
  const { user, gaps } = props;
  return (
    <Shell
      title="Arcadia — doctrine gaps"
      heading="Open doctrine gaps"
      user={user}
      current="chat"
      lede="Questions Arcadia could not answer from ratified doctrine. Shane's answer becomes permanent doctrine, so every gap closes once, forever. Ranked by how often it has been asked."
    >
      {gaps.length === 0 ? (
        <p class="empty">No open gaps.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Question</th>
              <th>Asked</th>
              <th>First raised by</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((g) => (
              <tr>
                <td>{g.question}</td>
                <td>{g.times_asked}×</td>
                <td>
                  <small class="muted">{g.asked_by}</small>
                </td>
                <td>
                  <small class="muted">{g.created_at}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="jump">
        <a href="/">← back to chat</a>
      </p>
    </Shell>
  );
}


/** Oldest-first, capped. Person-scoped: a conversation is read back only by its own owner. */
async function loadConversation(env: Env, email: string, limit: number): Promise<ChatRow[]> {
  const rows = await env.DB.prepare(
    `SELECT seq, role, content, citations, escalated, gap_id, created_at
     FROM chat_messages WHERE lower(email) = ?1 ORDER BY seq DESC LIMIT ?2`
  )
    .bind(email.toLowerCase(), limit)
    .all<ChatRow>();
  return rows.results.reverse();
}

async function appendTurn(
  env: Env,
  email: string,
  turn: { role: "user" | "arcadia"; content: string; citationJson?: string; escalated?: boolean; gapId?: string }
): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO chat_messages (email, role, content, citations, escalated, gap_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      email.toLowerCase(),
      turn.role,
      turn.content,
      turn.citationJson ?? "[]",
      turn.escalated ? 1 : 0,
      turn.gapId ?? null
    )
    .run();
  return Number(result.meta.last_row_id ?? 0);
}

function backToChat(): Response {
  return new Response(null, { status: 303, headers: { Location: "/#latest" } });
}

async function generateReply(
  env: Env,
  user: UserRecord,
  identity: Identity,
  question: string,
  history: ChatTurn[]
): Promise<void> {
  const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
  try {
    const answer = await arcadia.ask(question, user.email, history, identity.aadId ? { aadId: identity.aadId } : {});
    await appendTurn(env, user.email, {
      role: "arcadia",
      content: answer.answer,
      citationJson: serializeCitationPayload(answer.mode, answer.citations),
      ...(answer.gapId ? { gapId: answer.gapId, escalated: Boolean(answer.gapId) } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    console.error("ask-arcadia", err);
    await appendTurn(env, user.email, {
      role: "arcadia",
      content: `I could not complete that answer. ${reason}`,
    });
  }
}

function wantsJson(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  const type = request.headers.get("Content-Type") ?? "";
  return accept.includes("application/json") || type.includes("application/json");
}

async function readQuestion(request: Request): Promise<string> {
  if ((request.headers.get("Content-Type") ?? "").includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { question?: unknown };
    return String(body.question ?? "").trim();
  }
  const form = await request.formData();
  return String(form.get("question") ?? "").trim();
}

async function send(
  env: Env,
  user: UserRecord,
  identity: Identity,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  requireCapability(user, "ask_arcadia");
  const question = await readQuestion(request);
  if (!question) return wantsJson(request) ? Response.json({ ok: true, empty: true }) : backToChat();
  if (question.length > MAX_QUESTION_CHARS) {
    return new Response(`question must be ${MAX_QUESTION_CHARS} characters or fewer`, { status: 400 });
  }

  const history: ChatTurn[] = (await loadConversation(env, user.email, CONTEXT_TURNS)).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const seq = await appendTurn(env, user.email, { role: "user", content: question });
  const work = generateReply(env, user, identity, question, history);

  if (wantsJson(request) && ctx) {
    ctx.waitUntil(work);
    return Response.json({ ok: true, seq });
  }
  await work;
  return wantsJson(request) ? Response.json({ ok: true, seq }) : backToChat();
}

function updatesPayload(rows: ChatRow[]) {
  return rows.map((row) => {
    const payload = parseCitationPayload(row.citations);
    return {
      seq: row.seq,
      role: row.role,
      content: row.content,
      created_at: row.created_at,
      mode: payload.mode ?? null,
      citations: payload.ids,
      gap_id: row.gap_id,
    };
  });
}

async function updates(env: Env, user: UserRecord, after: number): Promise<Response> {
  requireCapability(user, "ask_arcadia");
  const rows = await env.DB.prepare(
    `SELECT seq, role, content, citations, escalated, gap_id, created_at
     FROM chat_messages WHERE lower(email) = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT 20`
  )
    .bind(user.email.toLowerCase(), after)
    .all<ChatRow>();
  return Response.json({ turns: updatesPayload(rows.results) });
}

async function clear(env: Env, user: UserRecord): Promise<Response> {
  requireCapability(user, "ask_arcadia");
  await env.DB.prepare(`DELETE FROM chat_messages WHERE lower(email) = ?1`)
    .bind(user.email.toLowerCase())
    .run();
  // The transcript is a display convenience; the attribution is not. Record
  // the clear itself so the append-only log stays the authority (§8).
  await appendAudit(env.DB, {
    actor: user.email,
    action: "chat_cleared",
    subject: user.email,
  });
  return new Response(null, { status: 303, headers: { Location: "/" } });
}

/** Router for "/" and /chat*. Returns undefined for paths it does not own. */
export async function handleChatRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  identity: Identity,
  ctx?: ExecutionContext
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/" && !path.startsWith("/chat")) return undefined;

  try {
    if (request.method === "GET" && path === "/") {
      const canAsk = can(user, "ask_arcadia");
      const graphConnected = identity.aadId
        ? userGraphConnected(await readUserGraphTokens(env, identity.aadId))
        : false;
      return html(
        <ChatPage
          user={user}
          canAsk={canAsk}
          graphConnected={graphConnected}
          messages={canAsk ? await loadConversation(env, user.email, PAGE_TURNS) : []}
        />
      );
    }

    if (request.method === "GET" && path === "/chat/gaps") {
      requireCapability(user, "ask_arcadia");
      const gaps = (
        await env.DB.prepare(
          `SELECT id, question, asked_by, times_asked, created_at
           FROM doctrine_gaps WHERE status = 'open'
           ORDER BY times_asked DESC, created_at ASC LIMIT 100`
        ).all<GapRow>()
      ).results;
      return html(<GapsPage user={user} gaps={gaps} />);
    }

    if (request.method === "GET" && path === "/chat/updates") {
      requireCapability(user, "ask_arcadia");
      const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
      return await updates(env, user, Number.isFinite(after) ? after : 0);
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;

    if (path === "/chat/send") return await send(env, user, identity, request, ctx);
    if (path === "/chat/clear") return await clear(env, user);
    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
