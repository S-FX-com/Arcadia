// Weekly factual run-sheet for one workspace. Members do not see it.
// Temporary audience (27 September 2026): superadmin only.
// Nothing here is sent to the client, and nothing here is EOS prose.

import type { JSX } from "preact";
import { listLoopBindings, addLoopBinding } from "../clients/loops";
import { clientById } from "../clients/bindings";
import { isRepositoryAudience } from "../lib/repository-audience";
import { writeClientRunSheet } from "../reports/weekly-run-sheet";
import type { UserRecord } from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

interface SheetRow {
  id: string;
  client_id: string;
  week_start: string;
  rendered: string;
  generated_at: string;
}

function SheetPage(props: {
  user: UserRecord;
  clientName: string;
  clientId: string;
  sheet: SheetRow | null;
  loops: number;
  notice?: string;
}): JSX.Element {
  const { user, clientName, clientId, sheet, loops, notice } = props;
  return (
    <Shell
      title={`Arcadia — ${clientName} run sheet`}
      heading={`${clientName} run sheet`}
      user={user}
      current="clients"
      lede="Facts from bound Planner plans, standard-channel timestamps, folder names, and Loop URLs. Not a client document."
      status={sheet ? <Pill tone="ok">Week of {sheet.week_start}</Pill> : <Pill tone="idle">No sheet yet</Pill>}
    >
      <p class="jump">
        <a href={`/clients/${clientId}`}>Workspace</a>
      </p>
      {notice ? <p class="banner">{notice}</p> : null}
      <p>
        <small class="muted">{loops} Loop URL{loops === 1 ? "" : "s"} bound. Page text is not read.</small>
      </p>
      <form method="post" action={`/clients/${clientId}/run-sheet`}>
        <button type="submit">Generate this week</button>
      </form>
      {sheet ? (
        <>
          <p>
            <small class="muted">Generated {sheet.generated_at}.</small>
          </p>
          <pre class="card">{sheet.rendered}</pre>
        </>
      ) : (
        <p class="empty">
          No run sheet for this workspace yet. Generate one from the bindings that are already on it.
          If Graph is not connected, Planner, channels, and folders say so, and Loop URLs still appear.
        </p>
      )}
      <h2>Bind a Loop URL</h2>
      <form method="post" action={`/clients/${clientId}/loops`}>
        <p>
          <input type="url" name="url" placeholder="https://" required size={44} />{" "}
          <input type="text" name="label" placeholder="label" />{" "}
          <button type="submit">Bind</button>
        </p>
      </form>
    </Shell>
  );
}

async function latest(env: Env, clientId: string): Promise<SheetRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, client_id, week_start, rendered, generated_at
       FROM client_run_sheets WHERE client_id = ?1 ORDER BY week_start DESC LIMIT 1`
  )
    .bind(clientId)
    .first<SheetRow>();
  return row ?? null;
}

/** Temporary audience (27 September 2026): superadmin only. */
export async function handleRunSheetRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const sheetMatch = /^\/clients\/([A-Za-z0-9-]+)\/run-sheet$/.exec(path);
  const loopMatch = /^\/clients\/([A-Za-z0-9-]+)\/loops$/.exec(path);
  const clientId = sheetMatch?.[1] ?? loopMatch?.[1];
  if (!clientId) return undefined;
  if (!isRepositoryAudience(user)) {
    return new Response("Run sheets are limited to superadmin for now.", { status: 403 });
  }

  const client = await clientById(env, clientId);
  if (!client) return new Response("workspace not found", { status: 404 });

  if (request.method === "GET" && sheetMatch) {
    const loops = await listLoopBindings(env, clientId);
    return html(
      <SheetPage user={user} clientName={client.name} clientId={clientId} sheet={await latest(env, clientId)} loops={loops.length} />
    );
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const form = await request.formData();

  if (sheetMatch) {
    const result = await writeClientRunSheet(env, { sessionId: `run-sheet:${crypto.randomUUID()}`, actor: user.email }, clientId);
    const loops = await listLoopBindings(env, clientId);
    const notice = "error" in result ? result.error : `Sheet written for the week of ${result.weekStart}. It was not sent.`;
    return html(
      <SheetPage
        user={user}
        clientName={client.name}
        clientId={clientId}
        sheet={await latest(env, clientId)}
        loops={loops.length}
        notice={notice}
      />
    );
  }

  const added = await addLoopBinding(env, user, {
    clientId,
    url: String(form.get("url") ?? ""),
    label: String(form.get("label") ?? ""),
  });
  const loops = await listLoopBindings(env, clientId);
  return html(
    <SheetPage
      user={user}
      clientName={client.name}
      clientId={clientId}
      sheet={await latest(env, clientId)}
      loops={loops.length}
      notice={added.ok ? "Loop URL bound." : added.reason}
    />
  );
}
