// Processes — a catalog of Loop links the team types in. Opening a row
// opens Loop. Arcadia does not read the pages. No FileStorageContainer
// permission, no crawl.
//
// The route stays reachable for everyone who already had the placeholder.
// The rows are temporary-audience superadmin only (27 September 2026).

import type { JSX } from "preact";
import { appendAudit } from "../lib/audit";
import { filterProcessLinks } from "../lib/process-catalog";
import { isRepositoryAudience } from "../lib/repository-audience";
import type { UserRecord } from "../lib/rbac";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

interface LinkRow {
  id: string;
  name: string;
  url: string;
  owner: string | null;
  description: string | null;
  added_by: string;
  added_at: string;
}

function validateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "URL must be https://";
  } catch {
    return "URL must be a valid https:// URL";
  }
  return undefined;
}

function ClosedPage(props: { user: UserRecord }): JSX.Element {
  return (
    <Shell
      title="Arcadia — processes"
      heading="Processes"
      user={props.user}
      current="processes"
      lede="Loop workspaces the department catalogs by link."
      status={<Pill tone="idle">Superadmin for now</Pill>}
    >
      <p class="empty">
        The process catalog is limited to superadmin for now. Nothing on this page is a Loop page,
        and nothing here is the dispatch review chain.
      </p>
    </Shell>
  );
}

function ProcessesPage(props: {
  user: UserRecord;
  links: LinkRow[];
  total: number;
  query: string;
  notice?: string;
}): JSX.Element {
  const { user, links, total, query, notice } = props;
  return (
    <Shell
      title="Arcadia — processes"
      heading="Processes"
      user={user}
      current="processes"
      lede="Loop workspaces the department keeps by link. Opening a row opens Loop. Arcadia does not read the pages."
      status={<Pill tone={total ? "ok" : "idle"}>{total} workspaces</Pill>}
    >
      {notice ? <p class="banner">{notice}</p> : null}
      <form method="get" action="/agency/processes">
        <p>
          <input type="search" name="q" value={query} placeholder="Search name, owner, or note" size={40} />{" "}
          <button type="submit">Search</button>
        </p>
      </form>
      {total === 0 ? (
        <p class="empty">Add the first workspace.</p>
      ) : links.length === 0 ? (
        <p class="empty">No workspace matches that search.</p>
      ) : (
        <div class="process-list">
          {links.map((link) => (
            <a class="process-row" href={link.url} target="_blank" rel="noopener noreferrer">
              <strong>{link.name}</strong>
              <span>{link.owner ?? "—"}</span>
              <span>{link.description ?? "—"}</span>
              <small class="muted">
                {link.added_by} · {link.added_at}
              </small>
            </a>
          ))}
        </div>
      )}
      <h2>Add a workspace</h2>
      <form method="post" action="/agency/processes">
        <p>
          <input type="text" name="name" placeholder="workspace name" required />{" "}
          <input type="url" name="url" placeholder="https://" required size={44} />
        </p>
        <p>
          <input type="text" name="owner" placeholder="owner" />{" "}
          <input type="text" name="description" placeholder="one line" size={44} />{" "}
          <button type="submit">Add</button>
        </p>
      </form>
    </Shell>
  );
}

async function listLinks(env: Env): Promise<LinkRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, url, owner, description, added_by, added_at FROM process_links ORDER BY name`
  ).all<LinkRow>();
  return rows.results;
}

export async function handleProcessRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/agency/processes") return undefined;

  // Temporary audience (27 September 2026): superadmin only. The route stays
  // so the old placeholder URL does not 404; the catalog does not render.
  if (!isRepositoryAudience(user)) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return html(<ClosedPage user={user} />);
  }

  if (request.method === "GET") {
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const all = await listLinks(env);
    return html(
      <ProcessesPage user={user} links={filterProcessLinks(all, query)} total={all.length} query={query} />
    );
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  const owner = String(form.get("owner") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  if (!name) return new Response("name is required", { status: 400 });
  const invalid = validateUrl(url);
  if (invalid) return new Response(invalid, { status: 400 });
  await env.DB.prepare(
    `INSERT INTO process_links (id, name, url, owner, description, added_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(crypto.randomUUID(), name, url, owner || null, description || null, user.email)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "process_link_added",
    subject: name,
    detail: url,
  });
  const all = await listLinks(env);
  return html(<ProcessesPage user={user} links={all} total={all.length} query="" notice="Workspace added." />);
}
