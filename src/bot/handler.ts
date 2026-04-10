// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Bot Activity Handler
//
// Routes incoming Bot Framework activities to the appropriate pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import { parseCommand, parseDraftCommand } from "./commands.js";
import { buildErrorMessage, buildWelcomeMessageV2, formatTaskList, sendReply, trimForTeams } from "./messages.js";
import { summarizeChannel, extractDecisions, extractNextSteps } from "../ai/summarize.js";
import { handleQA } from "../ai/qa.js";
import { registerChannel } from "../memory/d1.js";
import { loadCachedMessages } from "../memory/kv.js";
import { getChannelMessages, getChatMessages } from "../graph/messages.js";
import { getOpenTasksForChannel } from "../tasks/store.js";
import { parseAssignCommand, handleAssignCommand } from "../tasks/assign.js";
import { callAI } from "../ai/router.js";
import { buildDraftPrompt } from "../ai/prompts.js";
import type { ChannelMessage, Env, TeamsActivity } from "../types.js";

async function fetchMessages(teamId: string, channelId: string, env: Env, conversationType?: string): Promise<ChannelMessage[]> {
	try {
		if (conversationType === "personal") {
			return await loadCachedMessages(teamId, channelId, env);
		}
		if (conversationType === "groupChat") {
			return await getChatMessages(channelId, env);
		}
		return await getChannelMessages(teamId, channelId, env);
	} catch (err) {
		console.error("[Arcadia] fetchMessages error:", err);
		return [];
	}
}

/**
 * Fetch a Bot Framework bearer token for sending replies.
 * Uses the bot's own client credentials.
 */
async function getBotToken(env: Env): Promise<string> {
	const res = await fetch(`https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: env.TEAMS_APP_ID,
			client_secret: env.TEAMS_APP_PASSWORD,
			scope: "https://api.botframework.com/.default",
		}).toString(),
	});

	if (!res.ok) {
		throw new Error(`Bot token fetch failed: ${res.status}`);
	}

	const data = (await res.json()) as { access_token: string };
	return data.access_token;
}

/**
 * Extract team and channel IDs from an activity's channelData.
 * Falls back to conversation ID if channel data isn't available (DM context).
 */
function extractChannelIds(activity: TeamsActivity): {
	teamId: string;
	channelId: string;
	channelName: string;
} {
	const teamId =
		activity.channelData?.team?.aadGroupId ??
		activity.channelData?.teamsTeamId ??
		activity.channelData?.team?.id ??
		activity.conversation.tenantId ?? // fallback
		"unknown";

	const channelId = activity.channelData?.teamsChannelId ?? activity.channelData?.channel?.id ?? activity.conversation.id;

	const channelName = activity.channelData?.channel?.name ?? activity.conversation.name ?? "General";

	return { teamId, channelId, channelName };
}

/**
 * Handle a `message` activity — the core interaction flow.
 */
async function handleMessage(activity: TeamsActivity, env: Env): Promise<void> {
	const text = activity.text ?? "";
	console.log("[Arcadia] handleMessage text:", JSON.stringify(text));
	if (!text.trim()) return;

	const token = await getBotToken(env);
	const { teamId, channelId } = extractChannelIds(activity);
	const command = parseCommand(activity, env.TEAMS_APP_ID);
	const conversationType = activity.conversation.conversationType;

	// Only respond if directly @mentioned or in a DM/groupChat
	const isDM = conversationType === "personal" || conversationType === "groupChat";
	if (!command.mentionedBot && !isDM) return;

	try {
		let responseText: string;

		switch (command.intent) {
			case "summarize": {
				const result = await summarizeChannel(teamId, channelId, command.language, env, 50, conversationType);
				responseText = result.raw;
				break;
			}

			case "decisions": {
				let messages = await loadCachedMessages(teamId, channelId, env);
				if (messages.length === 0) {
					messages = await fetchMessages(teamId, channelId, env, conversationType);
				}
				responseText = await extractDecisions(messages, command.language, env);
				break;
			}

			case "next-steps": {
				let messages = await loadCachedMessages(teamId, channelId, env);
				if (messages.length === 0) {
					messages = await fetchMessages(teamId, channelId, env, conversationType);
				}
				responseText = await extractNextSteps(messages, command.language, env);
				break;
			}

			// ─── Phase 2 intents ──────────────────────────────────────────────────────

			case "assign": {
				const parsed = parseAssignCommand(command.rawText);
				if (parsed) {
					responseText = await handleAssignCommand(activity, parsed, env);
				} else {
					responseText = "I couldn't parse that assignment. Try: `@Arcadia assign [task] to [name]`";
				}
				break;
			}

			case "tasks": {
				const tasks = await getOpenTasksForChannel(teamId, channelId, env);
				responseText = formatTaskList(tasks, command.language);
				break;
			}

			case "draft": {
				const { type, targetName } = parseDraftCommand(command.rawText);
				let messages = await loadCachedMessages(teamId, channelId, env);
				if (messages.length === 0) {
					messages = await fetchMessages(teamId, channelId, env, conversationType);
				}
				const { system, user } = buildDraftPrompt(type, command.rawText, targetName, messages, command.language);
				const response = await callAI(system, user, env);
				// Cache draft in KV for potential "edit that" follow-up (30 min TTL)
				await env.ARCADIA_CACHE.put(`draft:${activity.conversation.id}:${activity.id}`, response.text, { expirationTtl: 1800 });
				responseText = response.text;
				break;
			}

			case "who-owns":
			case "status":
			case "general-qa":
			default: {
				responseText = await handleQA(teamId, channelId, command.rawText, command.intent, command.language, env, conversationType);
				break;
			}
		}

		await sendReply(activity, trimForTeams(responseText), token);
	} catch (err) {
		console.error("Error handling message:", err);
		await sendReply(activity, buildErrorMessage(err), token);
	}
}

/**
 * Handle a `conversationUpdate` activity — bot added to channel.
 */
async function handleConversationUpdate(activity: TeamsActivity, env: Env): Promise<void> {
	const membersAdded = activity.membersAdded ?? [];
	const botWasAdded = membersAdded.some((m) => m.id === env.TEAMS_APP_ID);
	if (!botWasAdded) return;

	const { teamId, channelId, channelName } = extractChannelIds(activity);

	// Register this channel for daily digests (store conversation ref for proactive messaging)
	await registerChannel(teamId, channelId, channelName, env, activity.serviceUrl, activity.conversation.id);

	const token = await getBotToken(env);
	await sendReply(activity, buildWelcomeMessageV2(channelName), token);
}

/**
 * Main activity router — dispatches to the correct handler.
 */
export async function handleActivity(activity: TeamsActivity, env: Env): Promise<Response> {
	try {
		switch (activity.type) {
			case "message":
				await handleMessage(activity, env);
				break;

			case "conversationUpdate":
				await handleConversationUpdate(activity, env);
				break;

			// Other activity types (typing, reactions, etc.) — acknowledge and ignore
			default:
				break;
		}

		return new Response(null, { status: 200 });
	} catch (err) {
		console.error("Unhandled activity error:", err);
		return new Response(null, { status: 500 });
	}
}
