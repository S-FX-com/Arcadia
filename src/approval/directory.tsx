// Directory — staff contact details from the Graph cache, plus social
// links and a region that live only in Arcadia. No street address. No
// Entra write.
//
// Temporary audience (27 September 2026): superadmin only.

import type { JSX } from "preact";
import { loadDirectory, type DirectoryPerson } from "../directory/cards";
import { syncDirectory } from "../directory/sync";
import { appendAudit } from "../lib/audit";
import { placeOnRegionMap } from "../lib/region-map";
import { graphAvailable, graphNotConnected } from "../integrations/graph";
import { isRepositoryAudience } from "../lib/repository-audience";
import type { UserRecord } from "../lib/rbac";
import { M365SyncPanel } from "./m365-sync-panel";
import { autoSyncIfNeeded, directorySyncFacts, type SyncFacts } from "./repository-sync";
import { html, Pill, rejectCrossOrigin, Shell } from "./shell";

function sourceLabel(source: "arcadia" | "graph" | "none"): string {
  if (source === "arcadia") return "Arcadia";
  if (source === "graph") return "Graph";
  return "not set";
}

function RegionMap(props: { people: DirectoryPerson[] }): JSX.Element {
  const placed = placeOnRegionMap(
    props.people.map((person) => ({
      name: person.displayName || person.email || person.aadId,
      city: person.city.shown,
      state: person.state.shown,
      country: person.country,
    }))
  );
  const outline = placed.outline.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div class="region-board">
      <div class="map-stage" id="region-map">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={outline} fill="rgba(0, 209, 249, .08)" stroke="rgba(139, 163, 192, .7)" stroke-width="0.4" />
          <rect x="2" y="78" width="20" height="20" fill="none" stroke="rgba(139, 163, 192, .35)" stroke-width="0.3" />
          <rect x="24" y="80" width="18" height="16" fill="none" stroke="rgba(139, 163, 192, .35)" stroke-width="0.3" />
        </svg>
        {placed.dots.map((dot) => (
          <a class="map-dot" href={`#region-${dot.key}`} style={`left:${dot.x}%;top:${dot.y}%`} title={`${dot.city}, ${dot.state}: ${dot.people.join(", ")}`}>
            <span>
              {dot.city} {dot.people.length}
            </span>
          </a>
        ))}
      </div>
      <aside class="region-side">
        <h3>Unplaced</h3>
        <p>
          <small class="muted">No city. Country is shown. A city set in Arcadia places the pin.</small>
        </p>
        {placed.unplaced.length === 0 ? (
          <p class="empty">Everyone with a profile has a city.</p>
        ) : (
          <ul>
            {placed.unplaced.map((row) => (
              <li>
                {row.name}
                {row.country ? ` — ${row.country}` : ""}
              </li>
            ))}
          </ul>
        )}
        {placed.dots.map((dot) => (
          <article id={`region-${dot.key}`}>
            <strong>
              {dot.city}, {dot.state}
            </strong>
            <br />
            <small class="muted">{dot.people.join(", ")}</small>
          </article>
        ))}
        {placed.unmapped.length > 0 ? (
          <>
            <h3>Not in the centroid table</h3>
            <ul>
              {placed.unmapped.map((row) => (
                <li>
                  {row.name} — {row.city}
                  {row.state ? `, ${row.state}` : ""}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </aside>
    </div>
  );
}

function SocialEditor(props: { people: DirectoryPerson[] }): JSX.Element {
  const withSocials = props.people.filter((person) => person.socials.length > 0);
  return (
    <>
      <h2>Social accounts</h2>
      <p>
        <small class="muted">These live in Arcadia. Saving one does not write to Entra.</small>
      </p>
      {withSocials.length === 0 ? (
        <p class="empty">No social accounts yet. Add the first one below.</p>
      ) : (
        withSocials.map((person) => (
          <div>
            <strong>{person.displayName ?? person.email ?? person.aadId}</strong>
            {person.socials.map((social) => (
              <form class="social-edit" method="post" action="/agency/directory/social">
                <input type="hidden" name="id" value={social.id} />
                <input type="text" name="network" value={social.network} required />
                <input type="url" name="url" value={social.url} required size={36} />
                <button type="submit" name="intent" value="save">
                  Save
                </button>
                <button class="reject" type="submit" name="intent" value="remove">
                  Remove
                </button>
                <small class="muted">added by {social.added_by}</small>
              </form>
            ))}
          </div>
        ))
      )}
      <h3>Add a social account</h3>
      <form method="post" action="/agency/directory/social">
        <p>
          <select name="aadId">
            {props.people.map((person) => (
              <option value={person.aadId}>{person.displayName ?? person.email ?? person.aadId}</option>
            ))}
          </select>{" "}
          <input type="text" name="network" placeholder="network" required />{" "}
          <input type="url" name="url" placeholder="https://" required size={40} />{" "}
          <button type="submit" name="intent" value="add">
            Add social link
          </button>
        </p>
      </form>
    </>
  );
}

function PersonRow(props: { person: DirectoryPerson }): JSX.Element {
  const { person } = props;
  const phones = [person.mobilePhone, ...person.businessPhones].filter(Boolean).join(", ");
  return (
    <tr>
      <td>
        {person.displayName ?? person.email ?? person.aadId}
        <br />
        <small class="muted">{person.email ?? "no mail"}</small>
      </td>
      <td>
        {person.title.shown ?? "—"}{" "}
        <small class="muted">({sourceLabel(person.title.source)})</small>
        {person.title.source === "arcadia" && person.title.graph ? (
          <>
            <br />
            <small class="muted">Graph: {person.title.graph}</small>
          </>
        ) : null}
      </td>
      <td>
        {person.department.shown ?? "—"}{" "}
        <small class="muted">({sourceLabel(person.department.source)})</small>
      </td>
      <td>
        {[person.city.shown, person.state.shown].filter(Boolean).join(", ") || "—"}{" "}
        <small class="muted">
          ({person.city.source === "none" && person.state.source === "none" ? "not set" : sourceLabel(person.city.source === "arcadia" || person.state.source === "arcadia" ? "arcadia" : "graph")})
        </small>
      </td>
      <td>{person.country?.trim() || "—"}</td>
      <td>{phones || "—"}</td>
      <td>{person.officeLocation ?? "—"}</td>
      <td>
        <form class="inline" method="post" action="/agency/directory/ignore">
          <input type="hidden" name="aadId" value={person.aadId} />
          <button type="submit" name="intent" value="ignore">
            Ignore
          </button>
        </form>
      </td>
      <td>
        {person.socials.length === 0
          ? "—"
          : person.socials.map((social) => (
              <div>
                <a href={social.url}>{social.network}</a>{" "}
                <small class="muted">added by {social.added_by}</small>
              </div>
            ))}
      </td>
    </tr>
  );
}

function DirectoryPage(props: {
  user: UserRecord;
  graphOk: boolean;
  data: Awaited<ReturnType<typeof loadDirectory>>;
  sync: SyncFacts;
  missing: string | null;
  notice?: string;
}): JSX.Element {
  const { user, graphOk, data, sync, missing, notice } = props;
  const proof = data.proof;
  return (
    <Shell
      title="Arcadia — directory"
      heading="Directory"
      user={user}
      current="directory"
      lede="Contact details for active member users. Title, department, and region show an Arcadia value when one is set, and say so. Reporting lines stay on the Leadership chart."
      status={
        !graphOk ? (
          <Pill tone="warn">Graph · not connected</Pill>
        ) : data.people.length === 0 ? (
          <Pill tone="warn">Directory · not synced</Pill>
        ) : (
          <Pill tone="ok">{data.people.length} people</Pill>
        )
      }
    >
      {notice ? <p class="banner">{notice}</p> : null}
      <M365SyncPanel
        lastSynced={sync.lastSynced}
        rowCount={sync.rowCount}
        rowLabel={sync.rowCount === 1 ? "person" : "people"}
        lastError={sync.lastError}
        missing={missing}
        action="/agency/directory/sync"
      />
      {proof && proof.status !== "skipped" ? (
        <p>
          <small class="muted">
            Manager proof: {proof.status}. {proof.detail}
          </small>
        </p>
      ) : null}

      <h2>Staff</h2>
      <p>
        <small class="muted">
          Ignore takes a distribution list or shared inbox off the staff lists. It does not change Microsoft 365.
        </small>
      </p>
      {data.people.length === 0 ? (
        <p class="empty">
          {data.ignored.length
            ? "No one is on the staff list. Ignored accounts are listed below."
            : "No active member users in the cache. Sync the directory once Graph is connected."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Title</th>
              <th>Department</th>
              <th>Region</th>
              <th>Country</th>
              <th>Phones</th>
              <th>Office</th>
              <th>Account</th>
              <th>Social</th>
            </tr>
          </thead>
          <tbody>
            {data.people.map((person) => (
              <PersonRow person={person} />
            ))}
          </tbody>
        </table>
      )}

      <h2>Ignored</h2>
      <p>
        <small class="muted">These accounts stay in Microsoft 365. Restore puts one back on the staff lists.</small>
      </p>
      {data.ignored.length === 0 ? (
        <p class="empty">No ignored accounts.</p>
      ) : (
        <ul class="ignored-list">
          {data.ignored.map((person) => (
            <li>
              <span>{person.displayName ?? person.email ?? person.aadId}</span>
              <form class="inline" method="post" action="/agency/directory/ignore">
                <input type="hidden" name="aadId" value={person.aadId} />
                <button type="submit" name="intent" value="restore">
                  Restore
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>Where people are</h2>
      <p>
        <small class="muted">
          The pin uses the city stored in Arcadia. If that city is empty, the Microsoft 365 city is used. Country comes from Microsoft 365 and is not written back. A person with a country and no city stays in Unplaced until a city is set.
        </small>
      </p>
      {data.people.length === 0 ? (
        <p class="empty">No one to place. The map fills in after a sync.</p>
      ) : (
        <RegionMap people={data.people} />
      )}

      <h2>Arcadia values</h2>
      {data.people.length === 0 ? (
        <p class="empty">Set a title, department, or region after the directory has people in it.</p>
      ) : (
        <>
          <form method="post" action="/agency/directory/overlay">
            <p>
              <select name="aadId">
                {data.people.map((person) => (
                  <option value={person.aadId}>{person.displayName ?? person.email ?? person.aadId}</option>
                ))}
              </select>{" "}
              <select name="field">
                <option value="title">title</option>
                <option value="department">department</option>
                <option value="city">city</option>
                <option value="state">state</option>
              </select>{" "}
              <input type="text" name="value" placeholder="blank clears the Arcadia value" size={40} />{" "}
              <button type="submit">Save</button>
            </p>
          </form>
          <SocialEditor people={data.people} />
        </>
      )}
    </Shell>
  );
}

async function render(env: Env, user: UserRecord, notice?: string): Promise<Response> {
  const facts = await directorySyncFacts(env);
  const started = await autoSyncIfNeeded(env, "directory", facts.hasRun);
  const sync = started ? await directorySyncFacts(env) : facts;
  const data = await loadDirectory(env);
  const shown = started ?? notice;
  return html(
    <DirectoryPage
      user={user}
      graphOk={graphAvailable(env)}
      data={data}
      sync={sync}
      missing={graphNotConnected(env)}
      {...(shown ? { notice: shown } : {})}
    />
  );
}

const FIELDS = ["title", "department", "city", "state"] as const;
type OverlayField = (typeof FIELDS)[number];

function isField(value: string): value is OverlayField {
  return (FIELDS as readonly string[]).includes(value);
}

/** Temporary audience (27 September 2026): superadmin only. */
function deny(user: UserRecord): Response | undefined {
  if (isRepositoryAudience(user)) return undefined;
  return new Response("Directory is limited to superadmin for now.", { status: 403 });
}

export async function handleDirectoryRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/agency/directory")) return undefined;
  const denied = deny(user);
  if (denied) return denied;

  try {
    if (request.method === "GET" && path === "/agency/directory") return await render(env, user);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();

    if (path === "/agency/directory/sync") {
      const result = await syncDirectory(env, { sessionId: `directory:${crypto.randomUUID()}`, actor: user.email });
      return await render(
        env,
        user,
        result.proof.status === "skipped"
          ? "Sync skipped. Graph is not connected, so no profiles were read and manager was not requested."
          : `Synced ${result.usersSeen} active member user(s). Manager proof: ${result.proof.status}.`
      );
    }

    if (path === "/agency/directory/overlay") {
      const aadId = String(form.get("aadId") ?? "");
      const field = String(form.get("field") ?? "");
      const value = String(form.get("value") ?? "").trim();
      if (!isField(field)) return new Response("unknown field", { status: 400 });
      const column = {
        title: "title_override",
        department: "department_override",
        city: "city_override",
        state: "state_override",
      }[field];
      await env.DB.prepare(
        `INSERT INTO directory_overlay (aad_id, ${column}, updated_by)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(aad_id) DO UPDATE SET ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = datetime('now')`
      )
        .bind(aadId, value || null, user.email)
        .run();
      await appendAudit(env.DB, {
        actor: user.email,
        action: "directory_overlay_set",
        subject: aadId,
        detail: `${field}: ${value || "cleared"}. Not written to Entra.`,
      });
      return await render(env, user, value ? "Arcadia value saved. It displays on top of Graph." : "Arcadia value cleared. Graph shows through.");
    }

    if (path === "/agency/directory/social") {
      const intent = String(form.get("intent") ?? "add");
      const id = String(form.get("id") ?? "").trim();
      if (intent === "remove") {
        if (!id) return new Response("social id is required", { status: 400 });
        await env.DB.prepare(`DELETE FROM directory_social WHERE id = ?1`).bind(id).run();
        await appendAudit(env.DB, {
          actor: user.email,
          action: "directory_social_removed",
          subject: id,
          detail: `removed by ${user.email}`,
        });
        return await render(env, user, "Social link removed.");
      }
      const network = String(form.get("network") ?? "").trim();
      const url = String(form.get("url") ?? "").trim();
      if (!network || !url) return new Response("network and URL are required", { status: 400 });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return new Response("social URL must be a valid URL", { status: 400 });
      }
      if (parsed.protocol !== "https:") return new Response("social URL must be https://", { status: 400 });
      if (intent === "save" && id) {
        await env.DB.prepare(`UPDATE directory_social SET network = ?2, url = ?3 WHERE id = ?1`)
          .bind(id, network, url)
          .run();
        await appendAudit(env.DB, {
          actor: user.email,
          action: "directory_social_edited",
          subject: id,
          detail: `${network} edited by ${user.email}. Not written to Entra.`,
        });
        return await render(env, user, "Social link saved.");
      }
      const aadId = String(form.get("aadId") ?? "");
      await env.DB.prepare(
        `INSERT INTO directory_social (id, aad_id, network, url, added_by) VALUES (?1, ?2, ?3, ?4, ?5)`
      )
        .bind(crypto.randomUUID(), aadId, network, url, user.email)
        .run();
      await appendAudit(env.DB, {
        actor: user.email,
        action: "directory_social_added",
        subject: aadId,
        detail: `${network} added by ${user.email}`,
      });
      return await render(env, user, "Social link added.");
    }

    if (path === "/agency/directory/ignore") {
      const aadId = String(form.get("aadId") ?? "").trim();
      const intent = String(form.get("intent") ?? "");
      if (!aadId) return new Response("account id is required", { status: 400 });
      if (intent === "restore") {
        const existing = await env.DB.prepare(`SELECT aad_id FROM directory_ignored WHERE aad_id = ?1`)
          .bind(aadId)
          .first<{ aad_id: string }>();
        if (!existing) return await render(env, user, "That account is not ignored.");
        await env.DB.prepare(`DELETE FROM directory_ignored WHERE aad_id = ?1`).bind(aadId).run();
        await appendAudit(env.DB, {
          actor: user.email,
          action: "directory_restored",
          subject: aadId,
          detail: "Restored to the staff lists. Not written to Entra.",
        });
        return await render(env, user, "Restored. The account is back on the staff lists.");
      }
      if (intent !== "ignore") return new Response("unknown intent", { status: 400 });
      const profile = await env.DB.prepare(
        `SELECT aad_id, display_name, mail FROM directory_profiles WHERE aad_id = ?1 AND account_enabled = 1`
      )
        .bind(aadId)
        .first<{ aad_id: string; display_name: string | null; mail: string | null }>();
      if (!profile) return new Response("that account is not in the directory", { status: 404 });
      await env.DB.prepare(
        `INSERT INTO directory_ignored (aad_id, ignored_by) VALUES (?1, ?2)
         ON CONFLICT(aad_id) DO NOTHING`
      )
        .bind(aadId, user.email)
        .run();
      const name = profile.display_name ?? profile.mail ?? aadId;
      await appendAudit(env.DB, {
        actor: user.email,
        action: "directory_ignored",
        subject: aadId,
        detail: `${name} ignored. The account stays in Microsoft 365. Not written to Entra.`,
      });
      return await render(env, user, `${name} is ignored. The account stays in Microsoft 365.`);
    }

    return new Response("not found", { status: 404 });
  } catch (err) {
    console.error("directory", err);
    const reason = err instanceof Error ? err.message : String(err);
    return new Response(`Directory failed: ${reason}`, { status: 500 });
  }
}
