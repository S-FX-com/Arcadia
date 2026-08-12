// Ask Arcadia — the front door at "/" (§4 Phase 2, dashboard surface; the
// Teams surface arrives with the Azure Bot registration).
//
// Multi-turn, because doctrine questions arrive as follow-ups ("and deferred
// payment?") that mean nothing read alone. The conversation is per person and
// persisted in D1; the model sees a bounded window of it.
//
// She answers from canonical doctrine only, cites the entries she used, and
// below the confidence floor she escalates instead of answering: a
// confidently-invented Shane opinion is worse than no answer (§5.6.7). Every
// gap becomes a question queued for Shane (capture channel D, §5.5).

import { getAgentByName } from "agents";
import type { ChatTurn } from "../agents/arcadia";
import { appendAudit } from "../lib/audit";
import { can, requireCapability, UnauthorizedError, type UserRecord } from "../lib/rbac";
import { html, Nav, rejectCrossOrigin, styles, Whoami } from "./dashboard";

const AGENT_INSTANCE = "main";
/** Turns replayed to the model — enough for a follow-up chain, bounded so a long conversation cannot grow the prompt without limit. */
const CONTEXT_TURNS = 8;
/** Turns rendered on the page. */
const PAGE_TURNS = 40;
const MAX_QUESTION_CHARS = 2000;

interface ChatRow {
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
  const escalated = row.escalated === 1;
  const citations = parseCitations(row.citations);
  return (
    <div
      class={`turn ${row.role}${escalated ? " escalated" : ""}`}
      {...(last ? { id: "latest" } : {})}
    >
      <span class="who">
        {row.role === "user" ? "You" : "Arcadia"} · {row.created_at}
      </span>
      <div class="bubble">{row.content}</div>
      {row.role === "arcadia" ? (
        <small class="muted">
          {escalated ? (
            <>
              Queued for Shane{row.gap_id ? <> as gap <code>{row.gap_id}</code></> : null} ·{" "}
              <a href="/chat/gaps">open gaps</a>
            </>
          ) : citations.length ? (
            <>Doctrine cited: {citations.join(" · ")}</>
          ) : (
            <>No doctrine cited.</>
          )}
        </small>
      ) : null}
    </div>
  );
}

function ChatPage(props: { user: UserRecord; messages: ChatRow[]; canAsk: boolean }) {
  const { user, messages, canAsk } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{styles}</style>
      </head>
      <body>
        <h1>Arcadia</h1>
        <Nav user={user} current="chat" />
        <Whoami user={user} />

        {!canAsk ? (
          <p class="banner warn">
            Your account cannot query the memory core. Ask your lead for the <code>ask_arcadia</code>{" "}
            capability.
          </p>
        ) : (
          <>
            <p>
              <small class="muted">
                Answers come from ratified doctrine only, with the entries cited. When she can't cite it she
                says so and queues the question for Shane — every gap closes once, forever.{" "}
                <a href="/chat/gaps">Open doctrine gaps</a>
              </small>
            </p>

            {messages.length === 0 ? (
              <p>
                <small class="muted">
                  Nothing asked yet. Try: <em>Can I discount a 12-month retainer?</em>
                </small>
              </p>
            ) : (
              messages.map((m, i) => <Turn row={m} last={i === messages.length - 1} />)
            )}

            <div class="composer">
              <form method="post" action="/chat/send">
                <input
                  type="text"
                  name="question"
                  placeholder="Ask Arcadia…"
                  maxLength={MAX_QUESTION_CHARS}
                  autofocus
                  required
                  style="width:100%"
                />
                <p>
                  <button type="submit">Send</button>{" "}
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
                <form method="post" action="/chat/clear">
                  <button type="submit">Clear conversation</button>{" "}
                  <small class="muted">
                    Clears the transcript only. Every answer stays in the audit log with the doctrine that
                    produced it.
                  </small>
                </form>
              ) : null}
            </div>
          </>
        )}
      </body>
    </html>
  );
}

function GapsPage(props: { user: UserRecord; gaps: GapRow[] }) {
  const { user, gaps } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>Arcadia — doctrine gaps</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{styles}</style>
      </head>
      <body>
        <h1>Open doctrine gaps</h1>
        <Nav user={user} current="chat" />
        <p>
          <small class="muted">
            Questions Arcadia could not answer from ratified doctrine. Shane's answer becomes permanent
            doctrine, so every gap closes once, forever. Ranked by how often it has been asked.
          </small>
        </p>
        {gaps.length === 0 ? (
          <p>
            <small class="muted">No open gaps.</small>
          </p>
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
        <p>
          <a href="/">← back to chat</a>
        </p>
      </body>
    </html>
  );
}

function parseCitations(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Oldest-first, capped. Person-scoped: a conversation is read back only by its own owner. */
async function loadConversation(env: Env, email: string, limit: number): Promise<ChatRow[]> {
  const rows = await env.DB.prepare(
    `SELECT role, content, citations, escalated, gap_id, created_at
     FROM chat_messages WHERE lower(email) = ?1 ORDER BY seq DESC LIMIT ?2`
  )
    .bind(email.toLowerCase(), limit)
    .all<ChatRow>();
  return rows.results.reverse();
}

async function appendTurn(
  env: Env,
  email: string,
  turn: { role: "user" | "arcadia"; content: string; citations?: string[]; escalated?: boolean; gapId?: string }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO chat_messages (email, role, content, citations, escalated, gap_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      email.toLowerCase(),
      turn.role,
      turn.content,
      JSON.stringify(turn.citations ?? []),
      turn.escalated ? 1 : 0,
      turn.gapId ?? null
    )
    .run();
}

function backToChat(): Response {
  return new Response(null, { status: 303, headers: { Location: "/#latest" } });
}

async function send(env: Env, user: UserRecord, form: FormData): Promise<Response> {
  requireCapability(user, "ask_arcadia");
  const question = String(form.get("question") ?? "").trim();
  if (!question) return backToChat();
  if (question.length > MAX_QUESTION_CHARS) {
    return new Response(`question must be ${MAX_QUESTION_CHARS} characters or fewer`, { status: 400 });
  }

  // Read the window before the new turn is written, so the question is not
  // duplicated into its own context.
  const history: ChatTurn[] = (await loadConversation(env, user.email, CONTEXT_TURNS)).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  await appendTurn(env, user.email, { role: "user", content: question });

  const arcadia = await getAgentByName(env.Arcadia, AGENT_INSTANCE);
  let answer;
  try {
    answer = await arcadia.ask(question, user.email, history);
  } catch (err) {
    // Surface the failure in the transcript rather than dropping the caller on
    // a 500 with their question already recorded and unanswered.
    const reason = err instanceof Error ? err.message : "unknown error";
    console.error("ask-arcadia", err);
    await appendTurn(env, user.email, {
      role: "arcadia",
      content: `I could not complete that answer. ${reason}`,
    });
    return backToChat();
  }

  if (answer.escalated) {
    await appendTurn(env, user.email, {
      role: "arcadia",
      content:
        "I can't answer that from ratified doctrine. The question is queued for Shane; his answer becomes permanent doctrine.",
      escalated: true,
      ...(answer.gapId ? { gapId: answer.gapId } : {}),
    });
  } else {
    await appendTurn(env, user.email, {
      role: "arcadia",
      content: answer.answer,
      citations: answer.citations,
    });
  }
  return backToChat();
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
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/" && !path.startsWith("/chat")) return undefined;

  try {
    if (request.method === "GET" && path === "/") {
      const canAsk = can(user, "ask_arcadia");
      return html(
        <ChatPage
          user={user}
          canAsk={canAsk}
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

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;

    if (path === "/chat/send") return await send(env, user, await request.formData());
    if (path === "/chat/clear") return await clear(env, user);
    return new Response("not found", { status: 404 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
