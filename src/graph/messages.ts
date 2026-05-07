// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Graph API: Channel Messages
//
// Fetches and normalizes messages from Microsoft Teams channels and threads.
// ─────────────────────────────────────────────────────────────────────────────

import { graphGet } from "./client.js";
import { resolveUser } from "./users.js";
import type { ChannelMessage, GraphMessage, Env } from "../types.js";

interface GraphListResponse<T> {
	value: T[];
	"@odata.nextLink"?: string;
}

/**
 * Strip HTML tags from Graph message body and decode common entities.
 */
function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Normalize a raw Graph message into Arcadia's ChannelMessage format.
 */
async function normalizeMessage(raw: GraphMessage, env: Env): Promise<ChannelMessage | null> {
	// Skip deleted messages
	if (raw.deletedDateTime) return null;

	const isBot = raw.from?.application != null;
	const authorId = raw.from?.user?.id ?? raw.from?.application?.id ?? "unknown";
	const rawName = raw.from?.user?.displayName ?? raw.from?.application?.displayName;

	// Resolve display name from Graph only if we have a real user ID
	let authorName: string;
	if (rawName) {
		authorName = rawName;
	} else if (authorId !== "unknown") {
		authorName = (await resolveUser(authorId, env)) ?? authorId;
	} else {
		authorName = "Unknown";
	}

	const rawBody = raw.body?.content ?? "";
	const text = raw.body?.contentType === "html" ? stripHtml(rawBody) : rawBody.trim();

	if (!text) return null;

	const msg: ChannelMessage = {
		id: raw.id,
		timestamp: raw.createdDateTime,
		authorId,
		authorName,
		text,
		isBot,
		// Conditionally include replyToId to satisfy `exactOptionalPropertyTypes`.
		...(raw.replyToId !== undefined && { replyToId: raw.replyToId }),
	};

	return msg;
}

/**
 * Fetch the most recent messages from a Teams channel.
 * Returns normalized ChannelMessage[], newest first.
 */
export async function getChannelMessages(teamId: string, channelId: string, env: Env, limit = 50, since?: string): Promise<ChannelMessage[]> {
	// Microsoft Graph enforces a maximum $top of 50 for this endpoint.
	const safeLimit = Math.min(limit, 50);
	let path = `/teams/${teamId}/channels/${channelId}/messages?$top=${safeLimit}`;
	// Note: do not send $filter to Graph here; filtering is done client-side below.

	const resp = await graphGet<GraphListResponse<GraphMessage>>(path, env);
	const messages = await Promise.all(resp.value.map((m) => normalizeMessage(m, env)));

	// Do not use $filter on /messages — Graph does not support filtering by createdDateTime
	// for this endpoint in many tenants. Instead fetch the page and filter client-side.
	let results = messages.filter((m): m is ChannelMessage => m !== null);
	if (since) {
		const sinceDate = new Date(since).getTime();
		results = results.filter((m) => new Date(m.timestamp).getTime() > sinceDate);
	}

	return results;
}

/**
 * Fetch the most recent messages from a Teams chat (1:1 or group chat).
 * Uses /chats/{chatId}/messages endpoint — requires Chat.Read.All permission.
 */
export async function getChatMessages(chatId: string, env: Env, limit = 50): Promise<ChannelMessage[]> {
	const safeLimit = Math.min(limit, 50);
	const path = `/chats/${chatId}/messages?$top=${safeLimit}`;

	const resp = await graphGet<GraphListResponse<GraphMessage>>(path, env);
	const messages = await Promise.all(resp.value.map((m) => normalizeMessage(m, env)));

	return messages.filter((m): m is ChannelMessage => m !== null);
}

/**
 * Fetch all replies in a specific thread (message + its reply chain).
 * Returns normalized ChannelMessage[], oldest first.
 */
export async function getThreadReplies(teamId: string, channelId: string, messageId: string, env: Env): Promise<ChannelMessage[]> {
	const path = `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies?$top=50`;
	const resp = await graphGet<GraphListResponse<GraphMessage>>(path, env);

	const normalized = await Promise.all(resp.value.map((m) => normalizeMessage(m, env)));

	return normalized.filter((m): m is ChannelMessage => m !== null).reverse(); // oldest first
}
