// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — D1 Database Queries
//
// Manages thread tracking, registered channels, and digest log.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelRow, DigestLogRow, Env, ThreadRow } from "../types.js";

// ─── Thread tracking ──────────────────────────────────────────────────────────

/**
 * Upsert a thread's last-activity timestamp and optional owner.
 */
export async function upsertThread(id: string, teamId: string, channelId: string, lastActivity: number, owner: string | null, env: Env): Promise<void> {
	await env.ARCADIA_DB.prepare(
		`INSERT INTO threads (id, team_id, channel_id, last_activity, owner, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON CONFLICT(id) DO UPDATE SET
       last_activity = excluded.last_activity,
       owner = COALESCE(excluded.owner, owner),
       status = CASE WHEN excluded.last_activity > last_activity THEN 'active' ELSE status END`,
	)
		.bind(id, teamId, channelId, lastActivity, owner)
		.run();
}

/**
 * Return threads that have had no activity for more than staleHours.
 */
export async function getStaleThreads(teamId: string, channelId: string, staleHours: number, env: Env): Promise<ThreadRow[]> {
	const cutoff = Math.floor(Date.now() / 1000) - staleHours * 3600;
	const result = await env.ARCADIA_DB.prepare(
		`SELECT * FROM threads
     WHERE team_id = ? AND channel_id = ? AND status = 'active' AND last_activity < ?`,
	)
		.bind(teamId, channelId, cutoff)
		.all<ThreadRow>();
	return result.results;
}

/**
 * Mark a thread as stale.
 */
export async function markThreadStale(id: string, env: Env): Promise<void> {
	await env.ARCADIA_DB.prepare(`UPDATE threads SET status = 'stale' WHERE id = ?`).bind(id).run();
}

// ─── Channel registry ─────────────────────────────────────────────────────────

/**
 * Register a channel to receive daily digests.
 * Stores serviceUrl and conversationId for proactive messaging.
 * Idempotent — safe to call on every bot install.
 */
export async function registerChannel(
	teamId: string,
	channelId: string,
	channelName: string,
	env: Env,
	serviceUrl?: string,
	conversationId?: string,
): Promise<void> {
	const id = `${teamId}:${channelId}`;
	await env.ARCADIA_DB.prepare(
		`INSERT INTO channels (id, team_id, channel_id, channel_name, registered_at, service_url, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       channel_name = excluded.channel_name,
       service_url = COALESCE(excluded.service_url, service_url),
       conversation_id = COALESCE(excluded.conversation_id, conversation_id)`,
	)
		.bind(id, teamId, channelId, channelName, Math.floor(Date.now() / 1000), serviceUrl ?? null, conversationId ?? null)
		.run();
}

/**
 * Return all registered channels for digest and stale-check scheduling.
 */
export async function getAllChannels(env: Env): Promise<ChannelRow[]> {
	const result = await env.ARCADIA_DB.prepare(`SELECT * FROM channels ORDER BY registered_at ASC`).all<ChannelRow>();
	return result.results;
}

/**
 * Unregister a channel (clear service_url and conversation_id) or remove it.
 * Called when proactive posting fails because the bot was removed from the channel.
 */
export async function unregisterChannel(teamId: string, channelId: string, env: Env): Promise<void> {
	const id = `${teamId}:${channelId}`;
	await env.ARCADIA_DB.prepare(`UPDATE channels SET service_url = NULL, conversation_id = NULL WHERE id = ?`).bind(id).run();
}

// ─── Digest log ───────────────────────────────────────────────────────────────

/**
 * Record a posted digest to the log.
 */
export async function logDigest(teamId: string, channelId: string, content: string, env: Env): Promise<void> {
	await env.ARCADIA_DB.prepare(
		`INSERT INTO digest_log (team_id, channel_id, posted_at, content)
     VALUES (?, ?, ?, ?)`,
	)
		.bind(teamId, channelId, Math.floor(Date.now() / 1000), content)
		.run();
}

/**
 * Return the most recent digest for a channel.
 */
export async function getLastDigest(teamId: string, channelId: string, env: Env): Promise<DigestLogRow | null> {
	const result = await env.ARCADIA_DB.prepare(
		`SELECT * FROM digest_log
     WHERE team_id = ? AND channel_id = ?
     ORDER BY posted_at DESC LIMIT 1`,
	)
		.bind(teamId, channelId)
		.first<DigestLogRow>();
	return result ?? null;
}
