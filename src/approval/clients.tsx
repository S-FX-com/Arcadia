// Clients — the manage_clients admin of the clients and client_bindings rows
// that Phase 4 (CRM) and Phase 9 (Workspaces) inherit. Not in the nav.
// Everyone without manage_clients gets a 404 on every /clients* path.
// Every mutation also re-checks manage_clients server-side in src/clients/*.

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
  removeBinding,
  type BindingRow,
  type ClientListRow,
  type ClientRow,
} from "../clients/bindings";
import { can, UnauthorizedError, type UserRecord } from "../lib/rbac";

const seeOther = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location } });

function ListPage(props: { user: UserRecord; rows: ClientListRow[]; error?: string }): JSX.Element {
  const { user, rows, error } = props;
  return (
    <Shell
      title="Arcadia — clients"
      heading="Clients"
      user={user}
      lede="Every client and its bound sources — typed, attributed, no auto-detection."
      status={<Pill tone={rows.length ? "ok" : "idle"}>{rows.length} client{rows.length === 1 ? "" : "s"}</Pill>}
    >
      {error ? (
        <section class="card">
          <p>
            <b>Refused:</b> {error}
          </p>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <p class="empty">No clients yet. Create one below, then bind its sources.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Status</th>
              <th>Bindings</th>
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
                <td>
                  <small class="muted">{c.owner ?? "—"}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Create a client</h2>
      <section class="card">
        <form method="post" action="/clients/create">
          <p>
            <input type="text" name="name" placeholder="Client name" required />{" "}
            <input type="text" name="owner" placeholder="owner email (optional)" />{" "}
            <button type="submit">Create</button>
          </p>
        </form>
      </section>
    </Shell>
  );
}

function DetailPage(props: {
  user: UserRecord;
  client: ClientRow;
  bindings: BindingRow[];
  error?: string;
}): JSX.Element {
  const { user, client, bindings, error } = props;
  return (
    <Shell
      title={`Arcadia — ${client.name}`}
      heading={client.name}
      user={user}
      lede="What is bound to this client."
      status={<Pill tone={client.status === "active" ? "ok" : "idle"}>{client.status}</Pill>}
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
      </div>

      <h2 id="bindings">Bindings ({bindings.length})</h2>
      {bindings.length === 0 ? (
        <p class="empty">Nothing bound.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Label</th>
              <th>External id</th>
              <th>Added by</th>
              <th />
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
                <td>
                  <form class="inline" method="post" action="/clients/unbind">
                    <input type="hidden" name="bindingId" value={b.id} />
                    <input type="hidden" name="clientId" value={client.id} />
                    <button class="reject" type="submit">
                      Unbind
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
              else is refused. No private channels, no 1:1 chats.
            </small>
          </p>
        </form>
      </section>

      <p class="jump">
        <a href="/clients">All clients</a>
      </p>
    </Shell>
  );
}

async function renderList(env: Env, user: UserRecord, error?: string): Promise<Response> {
  const rows = await listClients(env);
  return html(<ListPage user={user} rows={rows} {...(error ? { error } : {})} />);
}

async function renderDetail(env: Env, user: UserRecord, id: string, error?: string): Promise<Response> {
  const client = await clientById(env, id);
  if (!client) return notFound();
  return html(
    <DetailPage user={user} client={client} bindings={await listBindings(env, id)} {...(error ? { error } : {})} />
  );
}

const notFound = (): Response => new Response("not found", { status: 404 });

/** Router for /clients*. Returns undefined for paths it does not own. */
export async function handleClientRoutes(
  request: Request,
  env: Env,
  user: UserRecord
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/clients" && !path.startsWith("/clients/")) return undefined;
  // Not "forbidden": people without manage_clients do not learn the page exists.
  if (!can(user, "manage_clients")) return notFound();

  try {
    if (request.method === "GET") {
      const error = url.searchParams.get("err") ?? undefined;
      if (path === "/clients" || path === "/clients/") {
        return await renderList(env, user, error);
      }
      const match = /^\/clients\/([A-Za-z0-9-]+)$/.exec(path);
      if (match?.[1]) return await renderDetail(env, user, match[1], error);
      return notFound();
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
      default:
        return notFound();
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response(`Forbidden: ${err.message}`, { status: 403 });
    }
    throw err;
  }
}
