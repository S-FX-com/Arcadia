// Graph-derived workspace membership (§8): access = capability × membership.
//
//   may_read(person, client) =
//         can(person, "ask_arcadia")                    -- capability, rbac.ts
//     AND client_members contains (person, client)      -- membership, Graph-derived
//
// The cache carries a 15-minute staleness ceiling: someone removed from a
// bound Team loses workspace access within that window. A check against a
// cache past the ceiling triggers a refresh; if the refresh fails, the check
// FAILS CLOSED — membership that cannot be verified is membership that does
// not grant. Do not lengthen the window silently (§8): if 15-minute polling
// proves too costly, the answer is membership change notifications.

import { mintClientGraphScope, openClientGraphSession } from "../gatekeepers/graph";
import type { GatekeeperContext } from "../gatekeepers/types";
import { appendAudit } from "../lib/audit";
import { can, type UserRecord } from "../lib/rbac";
import { clientById } from "./bindings";

export const MEMBERSHIP_STALENESS_MINUTES = 15;

/** D1's datetime('now') is UTC without a zone marker; ISO strings pass through. */
export function parseDbTime(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

/** Pure staleness rule, testable without D1: null or unparseable is stale. */
export function membershipFresh(syncedAt: string | null, nowMs: number): boolean {
  if (!syncedAt) return false;
  const at = parseDbTime(syncedAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at <= MEMBERSHIP_STALENESS_MINUTES * 60_000;
}

/**
 * The membership decision, pure so the §8 matrix is testable: capability and
 * verified membership must BOTH pass, and an unverifiable cache denies.
 */
export function membershipGate(input: {
  hasCapability: boolean;
  isMember: boolean;
  fresh: boolean;
  refreshSucceeded: boolean;
}): boolean {
  if (!input.hasCapability) return false;
  if (!input.fresh && !input.refreshSucceeded) return false; // fail closed past the ceiling
  return input.isMember;
}

export interface MemberRow {
  email: string;
  aad_id: string | null;
  display_name: string | null;
  source_team_id: string;
  synced_at: string;
}

export async function listMembers(env: Env, clientId: string): Promise<MemberRow[]> {
  const rows = await env.DB.prepare(
    `SELECT email, aad_id, display_name, source_team_id, synced_at
       FROM client_members WHERE client_id = ?1 ORDER BY email`
  )
    .bind(clientId)
    .all<MemberRow>();
  return rows.results;
}

/**
 * Replace the client's membership cache from Graph, through a client-scoped
 * gatekeeper session (frozen binding set, one observation). Throws when Graph
 * cannot answer — callers decide whether that failure denies (mayReadClient
 * does) or surfaces to an admin (the dashboard does). A client with no team
 * bindings syncs to an empty cache: a workspace nobody can read is the
 * correct state for a workspace bound to nothing.
 */
export async function syncClientMembers(env: Env, clientId: string, ctx: GatekeeperContext): Promise<number> {
  const scope = await mintClientGraphScope(env, clientId);
  const session = openClientGraphSession(env, ctx, scope);
  const members = await session.teamMembers();

  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(`DELETE FROM client_members WHERE client_id = ?1`).bind(clientId),
    ...members
      .filter((m) => m.email)
      .map((m) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO client_members (client_id, email, aad_id, display_name, source_team_id, synced_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        ).bind(clientId, m.email, m.aadId, m.displayName ?? null, m.sourceTeamId, now)
      ),
    env.DB.prepare(`UPDATE clients SET members_synced_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(
      clientId,
      now
    ),
  ];
  await env.DB.batch(statements);

  const withEmail = members.filter((m) => m.email).length;
  await appendAudit(env.DB, {
    actor: ctx.actor,
    action: "client_members_synced",
    subject: clientId,
    detail: `${withEmail} member(s) from ${scope.teamIds.length} team(s)${
      members.length !== withEmail ? `; ${members.length - withEmail} without a directory address skipped` : ""
    }`,
  });
  return withEmail;
}

async function isMember(env: Env, clientId: string, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM client_members WHERE client_id = ?1 AND email = ?2 LIMIT 1`
  )
    .bind(clientId, email.toLowerCase())
    .first<{ x: number }>();
  return Boolean(row);
}

/**
 * §8: both legs must pass. Refreshes a cache past the 15-minute ceiling as a
 * side effect of the check itself — the requesting user is the attributed
 * actor of that Graph read. Fails closed when the cache cannot be brought
 * inside the ceiling.
 */
export async function mayReadClient(env: Env, user: UserRecord, clientId: string): Promise<boolean> {
  const hasCapability = user.active && can(user, "ask_arcadia");
  if (!hasCapability) return false;
  const client = await clientById(env, clientId);
  if (!client) return false;

  const fresh = membershipFresh(client.members_synced_at, Date.now());
  let refreshSucceeded = false;
  if (!fresh) {
    try {
      await syncClientMembers(env, clientId, {
        sessionId: `membership-check:${clientId}`,
        actor: user.email,
      });
      refreshSucceeded = true;
    } catch {
      refreshSucceeded = false;
    }
  }

  return membershipGate({
    hasCapability,
    isMember: await isMember(env, clientId, user.email),
    fresh,
    refreshSucceeded,
  });
}
