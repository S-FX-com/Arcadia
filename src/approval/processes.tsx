// Processes — a catalog of Loop links the team types in. Opening a row
// opens Loop. Arcadia does not read the pages. No FileStorageContainer
// permission, no crawl.
//
// The route stays reachable for everyone who already had the placeholder.
// The rows are temporary-audience superadmin only (27 September 2026).

import type { JSX } from "preact";
import { appendAudit } from "../lib/audit";
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

function ProcessesPage(props: { user: UserRecord; links: LinkRow[]; notice?: string }): JSX.Element {
  const { user, links, notice } = props;
  return (
    <Shell
      title="Arcadia — processes"
      heading="Processes"
      user={user}
      current="processes"
      lede="Links to Loop workspaces. Arcadia stores the name, the URL, and who added it. She does not read the pages."
      status={<Pill tone={links.length ? "ok" : "idle"}>{links.length} links</Pill>}
    >
      {notice ? <p class="banner">{notice}</p> : null}
      {links.length === 0 ? (
        <p class="empty">No Loop links yet. Add the workspace URL. Opening it opens Loop.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Owner</th>
              <th>Note</th>
              <th>Added by</th>
            </tr>
          </thead>
          <tbody>
            {links.map((link) => (
              <tr>
                <td>
                  <a href={link.url}>{link.name}</a>
                </td>
                <td>{link.owner ?? "—"}</td>
                <td>{link.description ?? "—"}</td>
                <td>
                  <small class="muted">
                    {link.added_by} · {link.added_at}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Add a link</h2>
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
    return html(<ProcessesPage user={user} links={await listLinks(env)} />);
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
  return html(<ProcessesPage user={user} links={await listLinks(env)} notice="Link added." />);
}
