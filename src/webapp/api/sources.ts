// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Sources API (Phase 3 follow-up)
//
//   GET /api/webapp/sources               — list documents the asking user
//                                           is permitted to see
//   DELETE /api/webapp/sources/{id}       — soft-delete a document (only
//                                           items the asking user owns or
//                                           has an ACL grant on)
//
// "Permitted to see" reuses the Phase 1 ACL machinery: under permissive
// enforcement we return rows whose source_resource_id is null OR whose
// resource_acl matches the user's principal set; under strict we require
// an ACL match. Off-mode returns everything.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types.js";
import type { WebappSession } from "../types.js";
import { aclEnforcementMode, buildAclWhereClause, resolveUserPrincipalSet } from "../../graph/acl.js";

interface DocumentRow {
	id: string;
	source_resource_type: string;
	source_resource_id: string;
	title: string | null;
	uri: string | null;
	mime_type: string | null;
	size_bytes: number | null;
	sensitivity_label: string | null;
	created_at: number;
	updated_at: number;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleSourcesApi(
	session: WebappSession,
	request: Request,
	url: URL,
	env: Env,
): Promise<Response | null> {
	const path = url.pathname;
	const method = request.method;

	if (path === "/api/webapp/sources" && method === "GET") {
		return await listSources(session, url, env);
	}
	const m = path.match(/^\/api\/webapp\/sources\/([^/]+)$/);
	if (m?.[1] && method === "DELETE") {
		return await deleteSource(session, m[1], env);
	}
	return null;
}

async function listSources(session: WebappSession, url: URL, env: Env): Promise<Response> {
	const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
	const offset = parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;

	const enforcement = aclEnforcementMode(env);
	let aclSql = "";
	const aclParams: string[] = [];
	if (enforcement !== "off") {
		const principals = await resolveUserPrincipalSet(session.userId, env);
		const clause = buildAclWhereClause(enforcement, principals);
		if (clause.sql) {
			aclSql = ` AND (${clause.sql})`;
			aclParams.push(...clause.params);
		}
	}

	const sql = `
		SELECT id, source_resource_type, source_resource_id, title, uri, mime_type, size_bytes,
		       sensitivity_label, created_at, updated_at
		  FROM documents
		 WHERE deleted_at IS NULL${aclSql}
		 ORDER BY updated_at DESC
		 LIMIT ? OFFSET ?
	`;

	const result = await env.ARCADIA_DB.prepare(sql)
		.bind(...aclParams, limit, offset)
		.all<DocumentRow>();

	return jsonResponse({
		sources: result.results.map((r) => ({
			id: r.id,
			resourceType: r.source_resource_type,
			resourceId: r.source_resource_id,
			title: r.title,
			uri: r.uri,
			mimeType: r.mime_type,
			sizeBytes: r.size_bytes,
			sensitivityLabel: r.sensitivity_label,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})),
		limit,
		offset,
	});
}

async function deleteSource(session: WebappSession, id: string, env: Env): Promise<Response> {
	// Look up the document to verify the asking user is permitted to forget it.
	const row = await env.ARCADIA_DB.prepare(
		`SELECT id, source_resource_type, source_resource_id FROM documents WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(id)
		.first<{ id: string; source_resource_type: string; source_resource_id: string }>();
	if (!row) return new Response("not found", { status: 404 });

	const enforcement = aclEnforcementMode(env);
	if (enforcement !== "off") {
		const { assertCanAccessResource } = await import("../../graph/acl.js");
		const ok = await assertCanAccessResource(
			session.userId,
			row.source_resource_type as Parameters<typeof assertCanAccessResource>[1],
			row.source_resource_id,
			env,
		);
		if (!ok) return new Response("forbidden", { status: 403 });
	}

	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`UPDATE documents SET deleted_at = ? WHERE id = ?`,
	)
		.bind(now, id)
		.run();

	// Best-effort cascade into Vectorize so search stops surfacing the
	// chunks immediately. Failures are non-fatal — the next ingest pass
	// will reconcile.
	if (env.ARCADIA_VECTORS) {
		const chunks = await env.ARCADIA_DB.prepare(
			`SELECT id FROM document_chunks WHERE document_id = ?`,
		)
			.bind(id)
			.all<{ id: string }>();
		const ids = chunks.results.map((r) => r.id);
		if (ids.length > 0) {
			await env.ARCADIA_VECTORS.deleteByIds(ids).catch(() => undefined);
		}
	}

	return new Response(null, { status: 204 });
}
