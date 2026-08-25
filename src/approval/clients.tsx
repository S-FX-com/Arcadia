// Client workspaces — the v5.0 spine surface (§8), replacing the /clients
// placeholders. Server-rendered, zero client JS, same as the rest of the app.
//
// Who sees what:
//   - The list shows the workspaces the viewer is a MEMBER of (§8 membership).
//     manage_clients holders see every workspace, because they administer them.
//   - The detail page is reachable by manage_clients (administration: bindings
//     and membership are metadata about the workspace, not its corpus) or by a
//     verified member. Corpus surfaces (Ask, reports) arrive in later stages
//     and gate through mayReadClient the same way.
//   - Every mutation re-checks manage_clients server-side in src/clients/*.
//     Binding is the access-granting act; hiding a form is not authorization.

import type { JSX } from "preact";
import { html, Pill, rejectCrossOrigin, Shell, Stat } from "./shell";
import {
  addBinding,
  BINDING_TYPE_HELP,
  BINDING_TYPES,
  clientById,
  createClient,
  listBindings,
  listClients,
  listClientsForMember,
  removeBinding,
  type BindingRow,
  type ClientListRow,
  type ClientRow,
} from "../clients/bindings";
import {
  listMembers,
  mayReadClient,
  membershipFresh,
  MEMBERSHIP_STALENESS_MINUTES,
  syncClientMembers,
  type MemberRow,
} from "../clients/members";
import { can, requireCapability, UnauthorizedError, type UserRecord } from "../lib/rbac";

const seeOther = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location } });

function SyncPill(props: { syncedAt: string | null }): JSX.Element {
  const { syncedAt } = props;
  if (!syncedAt) return <Pill tone="warn">membership never synced</Pill>;
  return membershipFresh(syncedAt, Date.now()) ? (
    <Pill tone="ok">membership fresh</Pill>
  ) : (
    <Pill tone="idle">membership stale (&gt;{MEMBERSHIP_STALENESS_MINUTES}m) — refreshes on next access</Pill>
  );
}

function ListPage(props: {
  user: UserRecord;
  rows: ClientListRow[];
  managesAll: boolean;
  error?: string;
}): JSX.Element {
  const { user, rows, managesAll, error } = props;
  return (
    <Shell
      title="Arcadia — client workspaces"
      heading="Client Workspaces"
      user={user}
      current="clients"
      lede={
        managesAll
          ? "Every workspace, because you administer them. A client is whatever an admin binds to it — typed, attributed, no auto-detection."
          : "The workspaces you belong to. Membership follows the Teams bound to each client."
      }
      status={<Pill tone={rows.length ? "ok" : "idle"}>{rows.length} workspace{rows.length === 1 ? "" : "s"}</Pill>}
    >
      {error ? (
        <section class="card">
          <p>
            <b>Refused:</b> {error}
          </p>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <p class="empty">
          {managesAll
            ? "No workspaces yet. Create one below, then bind its sources."
            : "You are not a member of any bound workspace yet. Membership comes from the Teams an admin binds to a client."}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Status</th>
              <th>Bindings</th>
              <th>Members</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr>
                <td>
                  <a href={`/clients/${c.id}`}>{c.name}</a>
                </td>
                <td>
                  <Pill tone={c.status === "active" ? "ok" : "idle"}>{c.status}</Pill>
                </td>
                <td>{c.bindings}</td>
                <td>{c.members}</td>
                <td>
                  <small class="muted">{c.owner ?? "—"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {managesAll ? (
        <>
          <h2>Create a workspace</h2>
          <section class="card">
            <form method="post" action="/clients/create">
              <p>
                <input type="text" name="name" placeholder="Client name" required />{" "}
                <input type="text" name="owner" placeholder="owner email (optional)" />{" "}
                <button type="submit">Create</button>
              </p>
              <p>
                <small class="muted">
                  Creating a workspace grants nobody anything. Access starts when a Team is bound: its
                  membership becomes the workspace's membership, within {MEMBERSHIP_STALENESS_MINUTES} minutes.
                </small>
              </p>
            </form>
          </section>
        </>
      ) : null}
    </Shell>
  );
}

function DetailPage(props: {
  user: UserRecord;
  client: ClientRow;
  bindings: BindingRow[];
  members: MemberRow[];
  manages: boolean;
  error?: string;
}): JSX.Element {
  const { user, client, bindings, members, manages, error } = props;
  // One row per person on the surface; the cache keys by (email, source team).
  const byEmail = new Map<string, { row: MemberRow; teams: number }>();
  for (const m of members) {
    const seen = byEmail.get(m.email);
    if (seen) seen.teams++;
    else byEmail.set(m.email, { row: m, teams: 1 });
  }
  const people = [...byEmail.values()];
  return (
    <Shell
      title={`Arcadia — ${client.name}`}
      heading={client.name}
      user={user}
      current="clients"
      lede="The workspace: what is bound to this client, and whose Teams membership unlocks it."
      status={
        <>
          <Pill tone={client.status === "active" ? "ok" : "idle"}>{client.status}</Pill>
          <SyncPill syncedAt={client.members_synced_at} />
        </>
      }
    >
      {error ? (
        <section class="card">
          <p>
            <b>Refused:</b> {error}
          </p>
        </section>
      ) : null}

      <div class="stats">
        <Stat label="Bindings" value={bindings.length} note="typed, attributed, admin-bound" />
        <Stat
          label="Members"
          value={people.length}
          note={client.members_synced_at ? `synced ${client.members_synced_at}` : "never synced"}
          {...(people.length === 0 ? { tone: "warn" as const } : {})}
        />
      </div>

      <h2 id="bindings">Bindings ({bindings.length})</h2>
      {bindings.length === 0 ? (
        <p class="empty">Nothing bound. This workspace grants no access and indexes nothing.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Label</th>
              <th>External id</th>
              <th>Added by</th>
              {manages ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {bindings.map((b) => (
              <tr>
                <td>
                  <Pill tone={b.type === "team" ? "ok" : "idle"}>{b.type}</Pill>
                </td>
                <td>{b.label}</td>
                <td>
                  <small class="muted">{b.external_id}</small>
                </td>
                <td>
                  <small class="muted">
                    {b.added_by} · {b.added_at}
                  </small>
                </td>
                {manages ? (
                  <td>
                    <form class="inline" method="post" action="/clients/unbind">
                      <input type="hidden" name="bindingId" value={b.id} />
                      <input type="hidden" name="clientId" value={client.id} />
                      <button class="reject" type="submit">
                        Unbind
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {manages ? (
        <section class="card">
          <h3>Add a binding</h3>
          <form method="post" action="/clients/bind">
            <input type="hidden" name="clientId" value={client.id} />
            <p>
              <select name="type">
                {BINDING_TYPES.map((t) => (
                  <option value={t}>{t}</option>
                ))}
              </select>{" "}
              <input type="text" name="externalId" placeholder="external id" required size={44} />{" "}
              <input type="text" name="label" placeholder="label" />{" "}
              <button type="submit">Bind</button>
            </p>
            <p>
              <small class="muted">
                {BINDING_TYPES.map((t) => `${t}: ${BINDING_TYPE_HELP[t]}`).join(" · ")}
              </small>
            </p>
            <p>
              <small class="muted">
                Standard channels only — the channel type is verified against Graph at bind and anything
                else is refused. No private channels, no 1:1 chats (§8): binding is the access-granting act.
              </small>
            </p>
          </form>
        </section>
      ) : null}

      <h2 id="members">Members ({people.length})</h2>
      {manages ? (
        <form class="inline" method="post" action="/clients/sync">
          <input type="hidden" name="clientId" value={client.id} />
          <p>
            <button type="submit">Sync membership now</button>{" "}
            <small class="muted">
              Also refreshes automatically when a member check finds the cache older than{" "}
              {MEMBERSHIP_STALENESS_MINUTES} minutes — and access fails closed until a refresh succeeds.
            </small>
          </p>
        </form>
      ) : null}
      {people.length === 0 ? (
        <p class="empty">
          No members in the cache. Bind a Team and sync — until then, nobody reads this workspace.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Email</th>
              <th>Via</th>
            </tr>
          </thead>
          <tbody>
            {people.map(({ row, teams }) => (
              <tr>
                <td>{row.display_name ?? row.email}</td>
                <td>
                  <small class="muted">{row.email}</small>
                </td>
                <td>
                  <small class="muted">
                    {teams} bound team{teams === 1 ? "" : "s"}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p class="jump">
        <a href="/clients">All workspaces</a>
        <a href="/">Ask Arcadia</a>
      </p>
    </Shell>
  );
}

async function renderList(env: Env, user: UserRecord, error?: string): Promise<Response> {
  const managesAll = can(user, "manage_clients");
  const rows = managesAll ? await listClients(env) : await listClientsForMember(env, user.email);
  return html(<ListPage user={user} rows={rows} managesAll={managesAll} {...(error ? { error } : {})} />);
}

async function renderDetail(env: Env, user: UserRecord, id: string, error?: string): Promise<Response> {
  const client = await clientById(env, id);
  if (!client) return new Response("workspace not found", { status: 404 });

  const manages = can(user, "manage_clients");
  if (!manages) {
    // Members see their own workspace. The check is the §8 gate itself —
    // capability × membership, staleness enforced, fail closed — not a copy
    // of it. Non-members get the same 404 as a workspace that does not
    // exist: membership decides whose data a person may even know about.
    if (!(await mayReadClient(env, user, id))) {
      return new Response("workspace not found", { status: 404 });
    }
  }

  return html(
    <DetailPage
      user={user}
      client={client}
      bindings={await listBindings(env, id)}
      members={await listMembers(env, id)}
      manages={manages}
      {...(error ? { error } : {})}
    />
  );
}

/** Router for /clients*. Returns undefined for paths it does not own. */
export async function handleClientRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/clients" && !path.startsWith("/clients/")) return undefined;

  try {
    if (request.method === "GET") {
      const error = url.searchParams.get("err") ?? undefined;
      if (path === "/clients" || path === "/clients/") {
        return await renderList(env, user, error);
      }
      const match = /^\/clients\/([A-Za-z0-9-]+)$/.exec(path);
      if (match?.[1]) return await renderDetail(env, user, match[1], error);
      return undefined;
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;
    const form = await request.formData();
    const clientId = String(form.get("clientId") ?? "");
    const backTo = clientId ? `/clients/${clientId}` : "/clients";

    switch (path) {
      case "/clients/create": {
        const id = await createClient(env, user, {
          name: String(form.get("name") ?? ""),
          ...(form.get("owner") ? { owner: String(form.get("owner")) } : {}),
        });
        return seeOther(`/clients/${id}`);
      }
      case "/clients/bind": {
        const result = await addBinding(env, user, {
          clientId,
          type: String(form.get("type") ?? ""),
          externalId: String(form.get("externalId") ?? ""),
          label: String(form.get("label") ?? ""),
        });
        if (!result.ok) return seeOther(`${backTo}?err=${encodeURIComponent(result.reason)}`);
        return seeOther(`${backTo}#bindings`);
      }
      case "/clients/unbind": {
        await removeBinding(env, user, String(form.get("bindingId") ?? ""));
        return seeOther(`${backTo}#bindings`);
      }
      case "/clients/sync": {
        requireCapability(user, "manage_clients");
        try {
          await syncClientMembers(env, clientId, {
            sessionId: `member-sync:${crypto.randomUUID()}`,
            actor: user.email,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return seeOther(`${backTo}?err=${encodeURIComponent(`membership sync failed: ${reason}`)}`);
        }
        return seeOther(`${backTo}#members`);
      }
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
