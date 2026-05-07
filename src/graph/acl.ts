// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Per-User ACL Index (Phase 13)
//
// The data layer for permission-preserving recall. Three concerns:
//
//   1. Resolve a user's effective principal set (their AAD id + all groups
//      they transitively belong to). Cached in KV for 1h to keep recall hot.
//
//   2. Record/lookup resource ACLs in D1: which AAD principals (users or
//      groups) are permitted to see a given M365 artifact. Populated by the
//      indexer at write time from Graph permissions/membership endpoints.
//
//   3. Build the WHERE-clause fragment that filters memories/documents by
//      a caller's principal set. Returned as a {sql, params} pair so it
//      can be composed into existing recall queries.
//
// Group expansion (group → members) is mirrored into a `group_membership`
// table by a periodic cron (refreshAllGroupMemberships) so we don't have
// to call Graph on every recall. The user-side principal lookup uses
// /users/{id}/transitiveMemberOf which is constant-time per user.
//
// Enforcement is gated by env.ACL_ENFORCEMENT ("off" | "permissive" |
// "strict"). The recall path will be wired up in a follow-up commit; this
// module is the standalone foundation.
// ─────────────────────────────────────────────────────────────────────────────

import type { AclPrincipal, Env, GroupMembershipRow, PrincipalKind, PrincipalSet, ResourceAclRow, ResourceType } from "../types.js";
import { graphGet } from "./client.js";
import { GRAPH } from "../constants.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "graph-acl" });

// 1h: short enough that group changes propagate the same day, long enough
// that hot-path recall doesn't hit Graph on every turn.
const PRINCIPAL_SET_TTL_SECONDS = 3600;

// Hard ceiling on the WHERE-clause arity — guards against pathological
// users in hundreds of groups breaking SQLite parameter limits (D1 max:
// 100 by default, but we want headroom for the rest of the query).
const MAX_PRINCIPALS_IN_QUERY = 64;

const PRINCIPAL_SET_KV_PREFIX = "acl:principals:";

function principalSetKey(userAadId: string): string {
	return `${PRINCIPAL_SET_KV_PREFIX}${userAadId}`;
}

// ─── 1. Principal-set resolution ─────────────────────────────────────────────

/**
 * Return the set of AAD principal ids representing a user's effective access:
 * their own AAD id plus the AAD ids of every group they transitively belong
 * to. Cached in KV for 1h.
 *
 * On Graph failure, returns just the user's own AAD id (safe default — the
 * user still sees items shared directly with them).
 */
export async function resolveUserPrincipalSet(userAadId: string, env: Env): Promise<PrincipalSet> {
	const key = principalSetKey(userAadId);

	const cached = await env.ARCADIA_CACHE.get(key).catch(swallow(log, "principal_cache_read_failed", null, { userAadId }));
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as unknown;
			if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
				return parsed as PrincipalSet;
			}
		} catch {
			// Fall through to refresh.
		}
	}

	const principals = new Set<string>([userAadId]);
	try {
		type MemberOfResponse = { value: Array<{ id: string; "@odata.type"?: string }> };
		const resp = await graphGet<MemberOfResponse>(
			`/users/${encodeURIComponent(userAadId)}/transitiveMemberOf?$select=id&$top=500`,
			env,
		);
		for (const member of resp.value) {
			if (member.id) principals.add(member.id);
		}
	} catch (err) {
		log.warn("transitive_memberof_failed", { userAadId }, err);
		// Continue with just the user's own AAD id.
	}

	const arr = Array.from(principals);
	await env.ARCADIA_CACHE.put(key, JSON.stringify(arr), { expirationTtl: PRINCIPAL_SET_TTL_SECONDS })
		.catch(swallow(log, "principal_cache_write_failed", undefined, { userAadId }));

	return arr;
}

/** Force a refresh of the cached principal set on the next read. */
export async function invalidatePrincipalSet(userAadId: string, env: Env): Promise<void> {
	await env.ARCADIA_CACHE.delete(principalSetKey(userAadId))
		.catch(swallow(log, "principal_cache_invalidate_failed", undefined, { userAadId }));
}

// ─── 2. Resource ACL CRUD ────────────────────────────────────────────────────

/**
 * Record the ACL for an M365 artifact. Idempotent (uses INSERT OR REPLACE);
 * granted_at is updated on every write so we can tell stale entries from
 * fresh ones during a future cleanup pass.
 */
export async function recordResourceAcl(
	resourceType: ResourceType,
	resourceId: string,
	principals: AclPrincipal[],
	env: Env,
): Promise<void> {
	if (principals.length === 0) return;
	const now = Math.floor(Date.now() / 1000);

	// Dedupe by AAD id to avoid PK conflicts when a principal is granted twice
	// (e.g. once directly and once via group expansion at the source).
	const seen = new Map<string, AclPrincipal>();
	for (const p of principals) {
		if (!seen.has(p.aadId)) seen.set(p.aadId, p);
	}

	const stmts = Array.from(seen.values()).map((p) =>
		env.ARCADIA_DB.prepare(
			`INSERT OR REPLACE INTO resource_acl
			   (resource_type, resource_id, principal_aad_id, principal_kind, granted_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).bind(resourceType, resourceId, p.aadId, p.kind, now),
	);

	await env.ARCADIA_DB.batch(stmts);
}

/** Read all ACL rows for a single resource. */
export async function lookupResourceAcl(
	resourceType: ResourceType,
	resourceId: string,
	env: Env,
): Promise<ResourceAclRow[]> {
	const result = await env.ARCADIA_DB.prepare(
		`SELECT resource_type, resource_id, principal_aad_id, principal_kind, granted_at
		   FROM resource_acl
		  WHERE resource_type = ? AND resource_id = ?`,
	)
		.bind(resourceType, resourceId)
		.all<ResourceAclRow>();
	return result.results;
}

/**
 * Authoritative single-resource access check. Use for explicit guards on
 * sensitive endpoints; the bulk recall path uses buildAclWhereClause()
 * instead so the join happens in one query.
 */
export async function assertCanAccessResource(
	userAadId: string,
	resourceType: ResourceType,
	resourceId: string,
	env: Env,
): Promise<boolean> {
	const principals = await resolveUserPrincipalSet(userAadId, env);
	if (principals.length === 0) return false;

	const placeholders = principals.map(() => "?").join(",");
	const row = await env.ARCADIA_DB.prepare(
		`SELECT 1 AS ok FROM resource_acl
		  WHERE resource_type = ?
		    AND resource_id = ?
		    AND principal_aad_id IN (${placeholders})
		  LIMIT 1`,
	)
		.bind(resourceType, resourceId, ...principals)
		.first<{ ok: number }>();
	return row !== null;
}

// ─── 3. Group membership refresh ─────────────────────────────────────────────

/**
 * Refresh the transitive members of one group from Graph and overwrite the
 * group_membership rows for it. Returns the count of users now recorded.
 */
export async function refreshGroupMembership(groupAadId: string, env: Env): Promise<number> {
	type Member = { id: string; "@odata.type"?: string };
	type Response = { value: Member[]; "@odata.nextLink"?: string };

	const userIds: string[] = [];
	let path: string | null = `/groups/${encodeURIComponent(groupAadId)}/transitiveMembers?$select=id&$top=500`;

	while (path) {
		const resp: Response = await graphGet<Response>(path, env);
		for (const m of resp.value) {
			// Only AAD users are propagated to memberships; nested groups are
			// already flattened by `transitiveMembers`.
			if (m.id && m["@odata.type"] === "#microsoft.graph.user") {
				userIds.push(m.id);
			}
		}
		// graphGet returns the full odata response; advance via nextLink.
		// nextLink is an absolute URL; strip the host so we feed graphGet
		// a relative path again.
		path = resp["@odata.nextLink"] ? resp["@odata.nextLink"].replace(/^https:\/\/[^/]+\/(?:v1\.0|beta)/, "") : null;
	}

	const now = Math.floor(Date.now() / 1000);

	// Replace strategy: delete current rows for this group, insert fresh ones.
	const stmts: D1PreparedStatement[] = [
		env.ARCADIA_DB.prepare(`DELETE FROM group_membership WHERE group_aad_id = ?`).bind(groupAadId),
		...userIds.map((uid) =>
			env.ARCADIA_DB.prepare(
				`INSERT OR REPLACE INTO group_membership (group_aad_id, user_aad_id, refreshed_at) VALUES (?, ?, ?)`,
			).bind(groupAadId, uid, now),
		),
	];
	await env.ARCADIA_DB.batch(stmts);

	return userIds.length;
}

/**
 * Refresh group_membership for every group currently referenced in
 * resource_acl. Designed to be called from a 6h cron. Errors per group are
 * logged and swallowed so one stale group doesn't kill the whole pass.
 */
export async function refreshAllGroupMemberships(env: Env): Promise<{ refreshed: number; failed: number }> {
	const groups = await env.ARCADIA_DB.prepare(
		`SELECT DISTINCT principal_aad_id FROM resource_acl WHERE principal_kind = 'group'`,
	).all<{ principal_aad_id: string }>();

	let refreshed = 0;
	let failed = 0;
	for (const row of groups.results) {
		try {
			await refreshGroupMembership(row.principal_aad_id, env);
			refreshed++;
		} catch (err) {
			log.warn("group_refresh_failed", { groupAadId: row.principal_aad_id }, err);
			failed++;
		}
	}
	log.info("group_refresh_completed", { refreshed, failed });
	return { refreshed, failed };
}

/** Look up the group AAD ids a user is a (transitive) member of, from D1. */
export async function getGroupsForUser(userAadId: string, env: Env): Promise<string[]> {
	const result = await env.ARCADIA_DB.prepare(
		`SELECT group_aad_id FROM group_membership WHERE user_aad_id = ?`,
	)
		.bind(userAadId)
		.all<Pick<GroupMembershipRow, "group_aad_id">>();
	return result.results.map((r) => r.group_aad_id);
}

// ─── 4. WHERE-clause builder for memory recall ───────────────────────────────

export type AclEnforcementMode = "off" | "permissive" | "strict";

export interface AclClause {
	/** SQL fragment to AND into the recall WHERE. Empty string when not enforcing. */
	sql: string;
	/** Bound parameters to append in order. */
	params: string[];
}

export function aclEnforcementMode(env: Env): AclEnforcementMode {
	const m = env.ACL_ENFORCEMENT;
	return m === "permissive" || m === "strict" ? m : "off";
}

/**
 * Build a SQL fragment that restricts memory rows to those the caller's
 * principal set is permitted to see.
 *
 * Mode:
 *   off        — returns an empty clause (no filtering).
 *   permissive — rows with NULL source_resource_id remain visible to
 *                everyone; rows with a source_resource_id require an ACL
 *                match against the caller's principals.
 *   strict     — every recalled row MUST have a matching ACL entry.
 *
 * `tableAlias` is the column qualifier (e.g. "m" → "m.source_resource_id").
 * Pass null/undefined when the SELECT does not alias the memories table.
 */
export function buildAclWhereClause(
	mode: AclEnforcementMode,
	principals: PrincipalSet,
	tableAlias: string | null = null,
): AclClause {
	if (mode === "off") return { sql: "", params: [] };

	const a = tableAlias ? `${tableAlias}.` : "";

	// Cap principal arity to keep within SQLite parameter limits. The trimmed
	// set still includes the user's own AAD id (we put it first in the array
	// in resolveUserPrincipalSet).
	const trimmed = principals.slice(0, MAX_PRINCIPALS_IN_QUERY);

	if (trimmed.length === 0) {
		// Caller has no identity. Strict denies all; permissive only shows
		// resource-less rows.
		return mode === "strict"
			? { sql: "0", params: [] }
			: { sql: `${a}source_resource_id IS NULL`, params: [] };
	}

	const placeholders = trimmed.map(() => "?").join(",");
	const aclMatch = `EXISTS (
		SELECT 1 FROM resource_acl
		WHERE resource_acl.resource_type = ${a}source_resource_type
		  AND resource_acl.resource_id   = ${a}source_resource_id
		  AND resource_acl.principal_aad_id IN (${placeholders})
	)`;

	if (mode === "strict") {
		return { sql: aclMatch, params: [...trimmed] };
	}

	// permissive
	return {
		sql: `(${a}source_resource_id IS NULL OR ${aclMatch})`,
		params: [...trimmed],
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isPrincipalKind(value: string): value is PrincipalKind {
	return value === "user" || value === "group";
}

// ─── 5. Graph membership helpers (delegated) ─────────────────────────────────

/**
 * Authenticated GET against Microsoft Graph using a user's delegated access
 * token. Mirrors webapp/context/teams.ts:userGraphGet but lives here so the
 * ACL module can be imported without dragging in webapp deps.
 */
async function delegatedGraphGet<T>(path: string, accessToken: string): Promise<T> {
	const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Graph GET ${path} failed (${res.status}): ${body}`);
	}
	return res.json() as Promise<T>;
}

interface AadConversationMember {
	"@odata.type"?: string;
	id?: string;
	userId?: string;        // AAD Object ID
	displayName?: string;
	roles?: string[];
}

function memberToPrincipal(m: AadConversationMember): AclPrincipal | null {
	if (!m.userId) return null;
	return { aadId: m.userId, kind: "user" };
}

/**
 * List the AAD principals authorised to see a Teams channel.
 *
 * Strategy:
 *   1. Query `/teams/{teamId}/channels/{channelId}/members`. Private and
 *      shared channels return concrete member records here.
 *   2. If the channel reports zero members (the typical case for standard
 *      channels — they inherit team-level membership), fall back to
 *      `/teams/{teamId}/members`.
 *
 * Always returns user-kind principals. Standard-channel inheritance via
 * the parent team's `unifiedGroup` is recorded as individual users for
 * recall simplicity; once a group_membership refresh job exists, callers
 * may switch to recording the group AAD id instead.
 */
export async function getTeamsChannelPrincipals(
	teamId: string,
	channelId: string,
	accessToken: string,
): Promise<AclPrincipal[]> {
	type Resp = { value: AadConversationMember[] };
	const channelMembers = await delegatedGraphGet<Resp>(
		`/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/members?$select=userId,displayName,roles&$top=200`,
		accessToken,
	).catch((err) => {
		log.warn("channel_members_fetch_failed", { teamId, channelId }, err);
		return { value: [] } satisfies Resp;
	});

	const direct = channelMembers.value.map(memberToPrincipal).filter((p): p is AclPrincipal => p !== null);
	if (direct.length > 0) return direct;

	// Standard channel — fall back to team-level membership.
	const teamMembers = await delegatedGraphGet<Resp>(
		`/teams/${encodeURIComponent(teamId)}/members?$select=userId,displayName,roles&$top=200`,
		accessToken,
	).catch((err) => {
		log.warn("team_members_fetch_failed", { teamId }, err);
		return { value: [] } satisfies Resp;
	});

	return teamMembers.value.map(memberToPrincipal).filter((p): p is AclPrincipal => p !== null);
}

/**
 * List the AAD principals authorised to see a Teams chat (1:1 or group chat).
 */
export async function getTeamsChatPrincipals(chatId: string, accessToken: string): Promise<AclPrincipal[]> {
	type Resp = { value: AadConversationMember[] };
	const resp = await delegatedGraphGet<Resp>(
		`/chats/${encodeURIComponent(chatId)}/members?$select=userId,displayName,roles&$top=200`,
		accessToken,
	).catch((err) => {
		log.warn("chat_members_fetch_failed", { chatId }, err);
		return { value: [] } satisfies Resp;
	});

	return resp.value.map(memberToPrincipal).filter((p): p is AclPrincipal => p !== null);
}

export const ACL_INTERNALS = {
	PRINCIPAL_SET_TTL_SECONDS,
	MAX_PRINCIPALS_IN_QUERY,
	principalSetKey,
	delegatedGraphGet,
};
