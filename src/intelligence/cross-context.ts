// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Cross-Context Loader (DM Broad Context)
//
// In 1:1 DM mode the bot has no single channel to read. Instead, this module
// aggregates messages from ALL D1-registered channels where the user has
// participated, giving the bot a full picture of the user's activity across
// the workspace.
//
// The result is cached in KV for 30 minutes to avoid repeated D1+KV reads
// on every DM turn.
// ─────────────────────────────────────────────────────────────────────────────

import { getAllChannels } from "../memory/d1.js";
import { loadCachedMessages } from "../memory/kv.js";
import type { ChannelMessage, Env } from "../types.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "cross-context" });
import { KV_KEYS } from "../constants.js";

const CROSS_CTX_TTL = 1800;           // 30 minutes
const CROSS_CTX_CHANNEL_LIMIT = 20;   // scan at most 20 registered channels
const CROSS_CTX_MSG_LIMIT = 80;       // cap total messages returned

/**
 * Return recent messages from all channels where userId has participated.
 * Reads from KV cache when available; rebuilds and re-caches on miss.
 */
export async function loadUserCrossContext(userId: string, env: Env): Promise<ChannelMessage[]> {
	const cached = await env.ARCADIA_CACHE.get(KV_KEYS.CROSS_CONTEXT(userId));
	if (cached) {
		try {
			return JSON.parse(cached) as ChannelMessage[];
		} catch {
			// corrupted entry — fall through to rebuild
		}
	}
	return buildAndCacheUserCrossContext(userId, env);
}

async function buildAndCacheUserCrossContext(userId: string, env: Env): Promise<ChannelMessage[]> {
	const channels = await getAllChannels(env).catch(swallow(log, "channels_load_failed", [], { stage: "build_user_cross_context" }));
	if (channels.length === 0) return [];

	const batch = channels.slice(0, CROSS_CTX_CHANNEL_LIMIT);

	// Load KV-cached messages for each channel in parallel (no Graph API calls)
	const allByChannel = await Promise.all(
		batch.map((ch) => loadCachedMessages(ch.team_id, ch.channel_id, env).catch(swallow(log, "cache_load_failed", [] as ChannelMessage[], { teamId: ch.team_id, channelId: ch.channel_id })))
	);

	// Keep only channels where the user has participated; tag each message with its source
	const combined: ChannelMessage[] = [];
	for (let i = 0; i < batch.length; i++) {
		const ch = batch[i];
		const msgs = allByChannel[i];
		if (!ch || !msgs || !msgs.some((m) => m.authorId === userId)) continue;
		for (const msg of msgs) {
			combined.push(ch.channel_name ? { ...msg, channelName: ch.channel_name } : msg);
		}
	}

	if (combined.length === 0) return [];
	const sorted = combined
		.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
		.slice(0, CROSS_CTX_MSG_LIMIT);

	// Cache so subsequent DM turns are instant
	await env.ARCADIA_CACHE.put(KV_KEYS.CROSS_CONTEXT(userId), JSON.stringify(sorted), {
		expirationTtl: CROSS_CTX_TTL,
	}).catch(swallow(log, "cross_context_cache_write_failed", undefined, { userId }));

	return sorted;
}
