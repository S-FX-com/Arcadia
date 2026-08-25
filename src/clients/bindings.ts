// Client workspaces and their typed source bindings (§8 binding policy).
//
// A client IS whatever an admin binds to it. Bindings are typed, attributed
// to the person who added them, and admin-bound only — no auto-detection.
// Binding is the access-granting act: a team binding decides whose Teams
// membership unlocks the workspace, so every mutation here requires the
// manage_clients capability and lands in the audit log under a named human.
//
// Bind conservatively (§8): standard channels only — the channel check runs
// through the Graph gatekeeper at bind time and fails closed — and SharePoint
// binds at the folder level. Exclusions beyond that happen at ingest (v5.4+),
// never at retrieval.

import { verifyStandardChannel } from "../gatekeepers/graph";
import { appendAudit } from "../lib/audit";
import { requireCapability, type UserRecord } from "../lib/rbac";

export const BINDING_TYPES = [
  "team",
  "channel",
  "planner_plan",
  "sharepoint_folder",
  "enque_org",
  "repo",
  "staging_url",
] as const;
export type BindingType = (typeof BINDING_TYPES)[number];

/** What the admin form shows next to each type, and the external_id format it expects. */
export const BINDING_TYPE_HELP: Record<BindingType, string> = {
  team: "Graph group id of the Team",
  channel: "teamId/channelId — standard channels only, verified at bind",
  planner_plan: "Planner plan id",
  sharepoint_folder: "driveId:/folder/path",
  enque_org: "Enque organization id (v5.1)",
  repo: "owner/name",
  staging_url: "https:// staging URL",
};

export interface ClientRow {
  id: string;
  name: string;
  status: "active" | "paused" | "offboarded";
  owner: string | null;
  created_by: string;
  members_synced_at: string | null;
  created_at: string;
}

export interface BindingRow {
  id: string;
  client_id: string;
  type: BindingType;
  external_id: string;
  label: string;
  added_by: string;
  added_at: string;
}

export interface ClientListRow extends ClientRow {
  bindings: number;
  members: number;
}

export function isBindingType(value: string): value is BindingType {
  return (BINDING_TYPES as readonly string[]).includes(value);
}

/**
 * Shape check per type, pure so policy is testable without D1 or Graph.
 * Returns undefined when valid, else the reason shown to the admin.
 */
export function validateBindingInput(type: BindingType, externalId: string): string | undefined {
  const id = externalId.trim();
  if (!id) return "external id is required";
  if (/\s/.test(id) && type !== "sharepoint_folder") return "external id cannot contain spaces";
  switch (type) {
    case "channel": {
      const parts = id.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return "channel binding is teamId/channelId";
      return undefined;
    }
    case "sharepoint_folder": {
      const sep = id.indexOf(":/");
      if (sep <= 0 || sep === id.length - 2) return "folder binding is driveId:/folder/path";
      return undefined;
    }
    case "repo": {
      const parts = id.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return "repo binding is owner/name";
      return undefined;
    }
    case "staging_url": {
      try {
        const url = new URL(id);
        if (url.protocol !== "https:") return "staging URL must be https://";
      } catch {
        return "staging URL must be a valid https:// URL";
      }
      return undefined;
    }
    case "team":
      if (id.includes("/")) return "team binding is the bare Graph group id";
      return undefined;
    default:
      return undefined;
  }
}

export async function listClients(env: Env): Promise<ClientListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.status, c.owner, c.created_by, c.members_synced_at, c.created_at,
            (SELECT COUNT(*) FROM client_bindings b WHERE b.client_id = c.id) AS bindings,
            (SELECT COUNT(DISTINCT m.email) FROM client_members m WHERE m.client_id = c.id) AS members
       FROM clients c
      ORDER BY c.status, c.name`
  ).all<ClientListRow>();
  return rows.results;
}

/** Workspaces the viewer belongs to — the specialist's list (§8 membership). */
export async function listClientsForMember(env: Env, email: string): Promise<ClientListRow[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.name, c.status, c.owner, c.created_by, c.members_synced_at, c.created_at,
            (SELECT COUNT(*) FROM client_bindings b WHERE b.client_id = c.id) AS bindings,
            (SELECT COUNT(DISTINCT m2.email) FROM client_members m2 WHERE m2.client_id = c.id) AS members
       FROM clients c
      WHERE EXISTS (SELECT 1 FROM client_members m
                     WHERE m.client_id = c.id AND m.email = ?1)
      ORDER BY c.status, c.name`
  )
    .bind(email.toLowerCase())
    .all<ClientListRow>();
  return rows.results;
}

export async function clientById(env: Env, id: string): Promise<ClientRow | undefined> {
  const row = await env.DB.prepare(
    `SELECT id, name, status, owner, created_by, members_synced_at, created_at FROM clients WHERE id = ?1`
  )
    .bind(id)
    .first<ClientRow>();
  return row ?? undefined;
}

export async function listBindings(env: Env, clientId: string): Promise<BindingRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, client_id, type, external_id, label, added_by, added_at
       FROM client_bindings WHERE client_id = ?1 ORDER BY type, added_at`
  )
    .bind(clientId)
    .all<BindingRow>();
  return rows.results;
}

export async function createClient(
  env: Env,
  user: UserRecord,
  input: { name: string; owner?: string }
): Promise<string> {
  requireCapability(user, "manage_clients");
  const name = input.name.trim();
  if (!name) throw new Error("client name is required");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO clients (id, name, owner, created_by) VALUES (?1, ?2, ?3, ?4)`
  )
    .bind(id, name, input.owner?.trim().toLowerCase() || null, user.email)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "client_created",
    subject: id,
    detail: name,
  });
  return id;
}

/**
 * Add a typed binding. Channel bindings verify membershipType === 'standard'
 * through the Graph gatekeeper and refuse anything else — including the case
 * where Graph cannot answer (fail closed: cannot verify means cannot bind).
 */
export async function addBinding(
  env: Env,
  user: UserRecord,
  input: { clientId: string; type: string; externalId: string; label: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
  requireCapability(user, "manage_clients");
  if (!isBindingType(input.type)) return { ok: false, reason: `unknown binding type "${input.type}"` };
  const externalId = input.externalId.trim();
  const invalid = validateBindingInput(input.type, externalId);
  if (invalid) return { ok: false, reason: invalid };
  const client = await clientById(env, input.clientId);
  if (!client) return { ok: false, reason: "client not found" };

  if (input.type === "channel") {
    const [teamId, channelId] = externalId.split("/") as [string, string];
    const check = await verifyStandardChannel(
      env,
      { sessionId: `bind:${crypto.randomUUID()}`, actor: user.email },
      teamId,
      channelId
    );
    if (!check.standard) {
      return {
        ok: false,
        reason: `channel is ${check.membershipType}, not standard — private and shared channels over-grant silently (§8)`,
      };
    }
  }

  const label = input.label.trim() || externalId;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO client_bindings (id, client_id, type, external_id, label, added_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(crypto.randomUUID(), input.clientId, input.type, externalId, label, user.email)
    .run();
  await appendAudit(env.DB, {
    actor: user.email,
    action: "client_binding_added",
    subject: input.clientId,
    detail: `${input.type}: ${label} (${externalId})`,
  });
  return { ok: true };
}

export async function removeBinding(env: Env, user: UserRecord, bindingId: string): Promise<void> {
  requireCapability(user, "manage_clients");
  const row = await env.DB.prepare(
    `SELECT client_id, type, external_id, label FROM client_bindings WHERE id = ?1`
  )
    .bind(bindingId)
    .first<{ client_id: string; type: string; external_id: string; label: string }>();
  if (!row) return;
  await env.DB.prepare(`DELETE FROM client_bindings WHERE id = ?1`).bind(bindingId).run();
  // Removing a team binding narrows access; the membership cache follows on
  // its next sync, which the 15-minute ceiling forces (src/clients/members.ts).
  await appendAudit(env.DB, {
    actor: user.email,
    action: "client_binding_removed",
    subject: row.client_id,
    detail: `${row.type}: ${row.label} (${row.external_id})`,
  });
}
