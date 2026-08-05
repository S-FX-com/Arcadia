// Ask Arcadia (§4 Phase 2, dashboard surface — the Teams surface arrives with
// the Azure Bot registration). She answers from canonical doctrine only, cites
// the entries she used, and below the confidence floor she escalates instead
// of answering: a confidently-invented Shane opinion is worse than no answer
// (§5.6.7). Every gap becomes a question queued for Shane (capture channel D).

import { getAgentByName } from "agents";
import { requireCapability, type UserRecord } from "../lib/rbac";
import { redirectTo } from "./dashboard";

export function AskSection(props: { user: UserRecord }) {
  return (
    <>
      <h2 id="ask">Ask Arcadia</h2>
      <p>
        <small class="muted">
          Answers come from ratified doctrine only, with the entries cited. When she can't cite it she says so
          and queues the question for Shane — every gap closes once, forever.
        </small>
      </p>
      <form method="post" action="/approval/ask">
        <input type="text" name="question" placeholder="e.g. Can I discount a 12-month retainer?" required style="min-width:28rem" />{" "}
        <button type="submit">Ask</button>
      </form>
      <p>
        <small class="muted">
          Signed in as {props.user.email} · <a href="/approval/ask/gaps">open doctrine gaps</a>
        </small>
      </p>
    </>
  );
}

export async function handleAskRoutes(
  request: Request,
  env: Env,
  user: UserRecord,
  form: FormData | undefined
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/approval/ask")) return undefined;
  if (request.method !== "POST" || !form) return undefined;

  requireCapability(user, "ask_arcadia");
  const question = String(form.get("question") ?? "").trim();
  if (!question) return new Response("question required", { status: 400 });

  const arcadia = await getAgentByName(env.Arcadia, "main");
  const answer = await arcadia.ask(question, user.email);

  const body = answer.escalated
    ? `<p class="banner warn"><strong>Arcadia could not answer from doctrine.</strong> The question is queued for Shane as gap <code>${answer.gapId ?? "—"}</code>.</p>`
    : `<p>${escapeHtml(answer.answer)}</p><p><small class="muted">Doctrine cited: ${
        answer.citations.length ? answer.citations.map((c) => escapeHtml(c)).join(" · ") : "none"
      }</small></p>`;

  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Arcadia — answer</title><style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem}.banner{padding:.6rem 1rem;border-radius:6px;background:#fff4d6;border:1px solid #a5730a}small.muted{color:#667}</style></head><body><h1>Ask Arcadia</h1><p><strong>${escapeHtml(
      question
    )}</strong></p>${body}<p><a href="/approval">← back</a></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export { redirectTo };
