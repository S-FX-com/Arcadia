// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp routines API (Phase 4)
//
//   GET    /api/webapp/routines              — list the caller's routines
//   POST   /api/webapp/routines              — create
//   GET    /api/webapp/routines/{id}         — fetch one (owner-only)
//   PUT    /api/webapp/routines/{id}         — update (owner-only)
//   DELETE /api/webapp/routines/{id}         — delete (owner-only)
//   POST   /api/webapp/routines/{id}/run     — trigger once (owner-only)
//   GET    /api/webapp/routines/{id}/runs    — recent run history
//
// Owner-only by design: routines execute with the OWNER's principals,
// so only the owner may read or trigger them. Cross-user sharing belongs
// in a future commit and needs a separate permissions model.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../../types.js";
import type { WebappSession } from "../types.js";
import { parseJsonBody, validationErrorResponse, ValidationError } from "../../lib/validate.js";
import { RoutineDefinitionSchema, type RoutineRow, type RoutineRunRow } from "../../routines/types.js";
import { executeRoutine } from "../../routines/executor.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function rowToPublic(row: RoutineRow): Record<string, unknown> {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		trigger: JSON.parse(row.trigger_json),
		steps: JSON.parse(row.steps_json),
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastRunAt: row.last_run_at,
	};
}

export async function handleRoutinesApi(session: WebappSession, request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	const path = url.pathname;
	const method = request.method;

	// /api/webapp/routines
	if (path === "/api/webapp/routines") {
		if (method === "GET") return await listRoutines(session, env);
		if (method === "POST") return await createRoutine(session, request, env);
		return new Response("method not allowed", { status: 405 });
	}

	// /api/webapp/routines/{id}[/run|/runs]
	const m = path.match(/^\/api\/webapp\/routines\/([^/]+)(?:\/(run|runs))?$/);
	if (!m) return new Response("not found", { status: 404 });
	const id = m[1]!;
	const sub = m[2];

	if (sub === "run" && method === "POST") return await runRoutineNow(session, id, env, ctx);
	if (sub === "runs" && method === "GET") return await listRoutineRuns(session, id, env);
	if (!sub && method === "GET") return await getRoutine(session, id, env);
	if (!sub && method === "PUT") return await updateRoutine(session, id, request, env);
	if (!sub && method === "DELETE") return await deleteRoutine(session, id, env);
	return new Response("method not allowed", { status: 405 });
}

async function fetchOwned(id: string, ownerAadId: string, env: Env): Promise<RoutineRow | null> {
	return await env.ARCADIA_DB.prepare(`SELECT * FROM routines WHERE id = ? AND owner_aad_id = ?`)
		.bind(id, ownerAadId)
		.first<RoutineRow>();
}

async function listRoutines(session: WebappSession, env: Env): Promise<Response> {
	const rows = await env.ARCADIA_DB.prepare(`SELECT * FROM routines WHERE owner_aad_id = ? ORDER BY updated_at DESC`)
		.bind(session.userId)
		.all<RoutineRow>();
	return jsonResponse(rows.results.map(rowToPublic));
}

async function getRoutine(session: WebappSession, id: string, env: Env): Promise<Response> {
	const row = await fetchOwned(id, session.userId, env);
	if (!row) return new Response("not found", { status: 404 });
	return jsonResponse(rowToPublic(row));
}

async function createRoutine(session: WebappSession, request: Request, env: Env): Promise<Response> {
	let def;
	try { def = await parseJsonBody(request, RoutineDefinitionSchema); }
	catch (err) { if (err instanceof ValidationError) return validationErrorResponse(err); throw err; }
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`INSERT INTO routines (id, owner_aad_id, name, description, trigger_json, steps_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, session.userId, def.name, def.description ?? null, JSON.stringify(def.trigger), JSON.stringify(def.steps), def.enabled === false ? 0 : 1, now, now)
		.run();
	return jsonResponse({ id }, 201);
}

async function updateRoutine(session: WebappSession, id: string, request: Request, env: Env): Promise<Response> {
	const existing = await fetchOwned(id, session.userId, env);
	if (!existing) return new Response("not found", { status: 404 });
	let def;
	try { def = await parseJsonBody(request, RoutineDefinitionSchema); }
	catch (err) { if (err instanceof ValidationError) return validationErrorResponse(err); throw err; }
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`UPDATE routines SET name = ?, description = ?, trigger_json = ?, steps_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
	)
		.bind(def.name, def.description ?? null, JSON.stringify(def.trigger), JSON.stringify(def.steps), def.enabled === false ? 0 : 1, now, id)
		.run();
	return jsonResponse({ id });
}

async function deleteRoutine(session: WebappSession, id: string, env: Env): Promise<Response> {
	const existing = await fetchOwned(id, session.userId, env);
	if (!existing) return new Response("not found", { status: 404 });
	await env.ARCADIA_DB.prepare(`DELETE FROM routines WHERE id = ?`).bind(id).run();
	return new Response(null, { status: 204 });
}

async function runRoutineNow(session: WebappSession, id: string, env: Env, ctx: ExecutionContext): Promise<Response> {
	const row = await fetchOwned(id, session.userId, env);
	if (!row) return new Response("not found", { status: 404 });
	const result = await executeRoutine(row, env, ctx);
	return jsonResponse(result);
}

async function listRoutineRuns(session: WebappSession, id: string, env: Env): Promise<Response> {
	const owned = await fetchOwned(id, session.userId, env);
	if (!owned) return new Response("not found", { status: 404 });
	const runs = await env.ARCADIA_DB.prepare(
		`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY started_at DESC LIMIT 20`,
	)
		.bind(id)
		.all<RoutineRunRow>();
	return jsonResponse(runs.results.map((r) => ({
		id: r.id,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		status: r.status,
		stepsCompleted: r.steps_completed,
		log: r.log_json ? JSON.parse(r.log_json) : null,
	})));
}
