// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — D1 Database Queries
//
// Manages thread tracking, registered channels, and digest log.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChannelRow, CustomerProfile, CustomerProfileRow, DigestLogRow, Env, ProfileInsights, ThreadRow, UserProfile, UserProfileRow } from "../types.js";

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

// ─── Phase 3: User profiles ───────────────────────────────────────────────────

/**
 * Upsert a user's basic profile metrics (non-blocking hot path).
 * Increments message_count and updates last_seen on every call.
 */
export async function upsertUserProfile(profile: UserProfile, env: Env): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`INSERT INTO user_profiles
       (user_id, display_name, team_id, message_count, first_seen, last_seen, insights, insight_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       display_name    = excluded.display_name,
       team_id         = COALESCE(excluded.team_id, team_id),
       message_count   = message_count + 1,
       last_seen       = excluded.last_seen,
       insights        = COALESCE(excluded.insights, insights),
       insight_version = CASE WHEN excluded.insights IS NOT NULL
                           THEN excluded.insight_version
                           ELSE insight_version END,
       updated_at      = excluded.updated_at`,
	)
		.bind(
			profile.userId,
			profile.displayName,
			profile.teamId ?? null,
			profile.messageCount,
			Math.floor(new Date(profile.firstSeen).getTime() / 1000),
			Math.floor(new Date(profile.lastSeen).getTime() / 1000),
			profile.insights ? JSON.stringify(profile.insights) : null,
			profile.insightVersion,
			now,
		)
		.run();
}

/**
 * Load a user's profile from D1.
 * Returns null if no profile exists.
 */
export async function getUserProfile(userId: string, env: Env): Promise<UserProfile | null> {
	const row = await env.ARCADIA_DB.prepare(
		`SELECT * FROM user_profiles WHERE user_id = ?`,
	)
		.bind(userId)
		.first<UserProfileRow>();

	if (!row) return null;

	return {
		userId: row.user_id,
		displayName: row.display_name,
		teamId: row.team_id ?? undefined,
		messageCount: row.message_count,
		firstSeen: new Date(row.first_seen * 1000).toISOString(),
		lastSeen: new Date(row.last_seen * 1000).toISOString(),
		insights: row.insights ? (JSON.parse(row.insights) as ProfileInsights) : undefined,
		insightVersion: row.insight_version,
	};
}

/**
 * Write AI-generated insights back to a user's D1 profile.
 */
export async function saveUserInsights(userId: string, insights: ProfileInsights, env: Env): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`UPDATE user_profiles
     SET insights = ?, insight_version = insight_version + 1, updated_at = ?
     WHERE user_id = ?`,
	)
		.bind(JSON.stringify(insights), now, userId)
		.run();
}

/**
 * Return all known user profiles for a team (used by admin cross-user queries).
 */
export async function getAllUserProfiles(teamId: string, env: Env): Promise<UserProfile[]> {
	const result = await env.ARCADIA_DB.prepare(
		`SELECT * FROM user_profiles WHERE team_id = ? ORDER BY last_seen DESC LIMIT 50`,
	)
		.bind(teamId)
		.all<UserProfileRow>();

	return result.results.map((row) => ({
		userId: row.user_id,
		displayName: row.display_name,
		teamId: row.team_id ?? undefined,
		messageCount: row.message_count,
		firstSeen: new Date(row.first_seen * 1000).toISOString(),
		lastSeen: new Date(row.last_seen * 1000).toISOString(),
		insights: row.insights ? (JSON.parse(row.insights) as ProfileInsights) : undefined,
		insightVersion: row.insight_version,
	}));
}

// ─── Phase 8: Linked users (Teams ↔ Webapp auth gating) ─────────────────────

/**
 * Returns true if a user has authenticated the Arcadia webapp at least once.
 * Used by the bot to gate 1:1 DMs: an unlinked user cannot interact privately
 * with Arcadia until they sign in via the webapp and grant permissions.
 */
export async function isUserLinked(aadObjectId: string, env: Env): Promise<boolean> {
	const row = await env.ARCADIA_DB.prepare(
		`SELECT 1 AS present FROM linked_users WHERE aad_object_id = ? LIMIT 1`,
	)
		.bind(aadObjectId)
		.first<{ present: number }>();
	return !!row;
}

/**
 * Record a successful webapp sign-in as a persistent link. Called from the
 * webapp token-exchange flow so the bot can recognise the user on their next
 * DM. Idempotent — updates last_auth_at / display name on each call.
 */
export async function upsertLinkedUser(
	aadObjectId: string,
	displayName: string,
	email: string | null,
	env: Env,
): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await env.ARCADIA_DB.prepare(
		`INSERT INTO linked_users (aad_object_id, display_name, email, linked_at, last_auth_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(aad_object_id) DO UPDATE SET
       display_name = excluded.display_name,
       email        = COALESCE(excluded.email, email),
       last_auth_at = excluded.last_auth_at`,
	)
		.bind(aadObjectId, displayName, email, now, now)
		.run();
}

// ─── Phase 3: Customer profiles ──────────────────────────────────────────────

/**
 * Upsert a customer profile, incrementing mention count.
 */
export async function upsertCustomerProfile(profile: CustomerProfile, env: Env): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	const context = JSON.stringify({
		contacts: profile.contacts,
		topics: profile.topics,
		sentiment: profile.sentiment,
		recentContext: profile.recentContext,
	});
	await env.ARCADIA_DB.prepare(
		`INSERT INTO customer_profiles (id, name, mention_count, first_seen, last_seen, context, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name          = excluded.name,
       mention_count = mention_count + 1,
       last_seen     = excluded.last_seen,
       context       = excluded.context,
       updated_at    = excluded.updated_at`,
	)
		.bind(profile.id, profile.name, now, now, context, now)
		.run();
}

/**
 * Load a customer profile by slug ID.
 */
export async function getCustomerProfile(id: string, env: Env): Promise<CustomerProfile | null> {
	const row = await env.ARCADIA_DB.prepare(
		`SELECT * FROM customer_profiles WHERE id = ?`,
	)
		.bind(id)
		.first<CustomerProfileRow>();

	if (!row) return null;
	const ctx = row.context ? (JSON.parse(row.context) as Record<string, unknown>) : {};
	return {
		id: row.id,
		name: row.name,
		mentionCount: row.mention_count,
		contacts: (ctx.contacts as string[]) ?? [],
		topics: (ctx.topics as string[]) ?? [],
		sentiment: ctx.sentiment as CustomerProfile["sentiment"],
		recentContext: ctx.recentContext as string | undefined,
		lastMentioned: new Date(row.last_seen * 1000).toISOString(),
	};
}

/**
 * Return the top customer profiles by mention count.
 */
export async function getTopCustomerProfiles(env: Env, limit = 20): Promise<CustomerProfile[]> {
	const result = await env.ARCADIA_DB.prepare(
		`SELECT * FROM customer_profiles ORDER BY mention_count DESC LIMIT ?`,
	)
		.bind(limit)
		.all<CustomerProfileRow>();

	return result.results.map((row) => {
		const ctx = row.context ? (JSON.parse(row.context) as Record<string, unknown>) : {};
		return {
			id: row.id,
			name: row.name,
			mentionCount: row.mention_count,
			contacts: (ctx.contacts as string[]) ?? [],
			topics: (ctx.topics as string[]) ?? [],
			sentiment: ctx.sentiment as CustomerProfile["sentiment"],
			recentContext: ctx.recentContext as string | undefined,
			lastMentioned: new Date(row.last_seen * 1000).toISOString(),
		};
	});
}
