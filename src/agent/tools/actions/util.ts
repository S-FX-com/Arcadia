// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Shared helpers for action tools (Phase 4)
//
// Action tools mutate M365 state (send mail, post channel, create task,
// create event). Every action runs as the asking user via the delegated
// access token cached in webapp_sessions. Tools that can't find a valid
// token return a "needs_auth" content message so the agent can ask the
// user to re-authenticate rather than throwing.
// ─────────────────────────────────────────────────────────────────────────────

import { GRAPH } from "../../../constants.js";
import type { Env } from "../../../types.js";

export async function getDelegatedAccessToken(userAadId: string, env: Env): Promise<string | null> {
	const row = await env.ARCADIA_DB.prepare(
		`SELECT access_token, token_expiry FROM webapp_sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 1`,
	)
		.bind(userAadId)
		.first<{ access_token: string; token_expiry: number }>();
	if (!row) return null;
	const now = Math.floor(Date.now() / 1000);
	if (row.token_expiry < now) return null;
	const { decryptToken } = await import("../../../webapp/crypto.js");
	try {
		return await decryptToken(row.access_token, env.WEBAPP_SESSION_SECRET);
	} catch {
		return null;
	}
}

export async function graphPostAs(path: string, body: unknown, accessToken: string): Promise<{ ok: true; json: unknown } | { ok: false; status: number; error: string }> {
	const res = await fetch(`${GRAPH.BASE_URL}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		return { ok: false, status: res.status, error: await res.text() };
	}
	const text = await res.text();
	return { ok: true, json: text ? JSON.parse(text) : null };
}
