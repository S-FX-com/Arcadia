// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Chat Handler (Phase 7)
//
// Core chat interaction: receives user messages, gathers M365 context,
// recalls memories, calls Workers AI (Gemma 4 26B), persists conversation.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ConversationTurn } from "../types.js";
import type { WebappSession, WebappChatRequest, WebappChatResponse, ContextRef, ContextSource } from "./types.js";
import { getSessionAccessToken } from "./auth.js";
import { createConversation, saveMessage, getRecentMessages, updateConversationTitle } from "./conversations.js";
import { buildTitleGenerationPrompt } from "./prompts.js";
import { getUserTeams, getUserChats, fetchUserFullContext } from "./context/teams.js";
import { getFollowedSites } from "./context/sharepoint.js";
import { getUserTasks } from "./context/planner.js";
import { callAI } from "../ai/router.js";
import { isAdmin } from "./middleware.js";
import { runArcadiaPipeline } from "../pipeline/arcadia-pipeline.js";

/**
 * Handles a chat message from the webapp.
 * This is the core interaction loop: context gathering → AI call → persistence.
 */
export async function handleChat(session: WebappSession, request: Request, env: Env, ctx: ExecutionContext): Promise<WebappChatResponse> {
	let body: WebappChatRequest;
	try {
		body = (await request.json()) as WebappChatRequest;
	} catch {
		throw new Error("Invalid request body");
	}

	if (!body.message || typeof body.message !== "string" || body.message.trim().length === 0) {
		throw new Error("Message is required");
	}

	const userMessage = body.message.trim();
	const contextSources = body.contextSources ?? [];

	// 1. Get or create conversation
	let conversationId = body.conversationId;
	const isNewConversation = !conversationId;
	if (!conversationId) {
		conversationId = await createConversation(session.userId, "New conversation", env);
	}

	// 2. Save user message immediately
	await saveMessage(conversationId, "user", userMessage, null, env);

	// 3. Load conversation history for AI context
	const recentMessages = await getRecentMessages(conversationId, env, 20);
	const history: ConversationTurn[] = recentMessages
		.slice(0, -1) // Exclude the message we just saved (it goes as the user message)
		.map((m) => ({
			role: m.role as "user" | "assistant",
			content: m.content,
			timestamp: m.createdAt,
		}));

	// 4. Gather M365 context based on selected sources
	const accessToken = await getSessionAccessToken(session, env);
	const { contextText, contextRefs } = await gatherM365Context(accessToken, contextSources);

	// 5. Run the unified Arcadia pipeline (context assembly + AI + memory).
	const workerUrl = new URL(request.url).origin;

	// Fetch the user's full Teams + chat message history via delegated token.
	// This gives the model complete coverage: all teams, channels, and chats
	// the user belongs to — not just where the bot is installed.
	const preloadedMessages = await fetchUserFullContext(accessToken).catch((err) => {
		console.error("[Arcadia Webapp] fetchUserFullContext failed:", err);
		return [] as import("../types.js").ChannelMessage[];
	});

	const extraContext = contextText ? `--- M365 Context ---\n${contextText}` : undefined;
	const result = await runArcadiaPipeline({
		mode: "webapp",
		user: {
			id: session.userId,
			displayName: session.displayName,
			isAdmin: isAdmin(session.userId, env),
		},
		text: userMessage,
		conversation: {
			id: conversationId,
			surface: "webapp",
			channelId: null,
			teamId: null,
			channelName: "Webapp",
		},
		history,
		workerUrl,
		preloadedMessages,
		...(extraContext !== undefined ? { extraContext } : {}),
		env,
		ctx,
	});

	// 6. Save assistant response
	await saveMessage(conversationId, "assistant", result.text, contextRefs.length > 0 ? contextRefs : null, env);

	// 7. Fire-and-forget: auto-title for new conversations (memory is handled by pipeline)
	if (isNewConversation) {
		ctx.waitUntil(autoTitleConversation(conversationId, userMessage, env));
	}

	return {
		conversationId,
		message: result.text,
		contextUsed: contextRefs,
		...(result.imageUrl !== undefined ? { imageUrl: result.imageUrl } : {}),
	};
}

// ─── M365 Context Gathering ──────────────────────────────────────────────────

async function gatherM365Context(accessToken: string, sources: ContextSource[]): Promise<{ contextText: string; contextRefs: ContextRef[] }> {
	const ALL_SOURCES: ContextSource[] = ["teams", "chats", "sharepoint", "planner"];
	if (sources.length === 0) sources = ALL_SOURCES;

	const sections: string[] = [];
	const refs: ContextRef[] = [];

	// Gather context from each requested source in parallel
	const promises: Promise<void>[] = [];

	if (sources.includes("teams")) {
		promises.push(
			(async () => {
				try {
					const teams = await getUserTeams(accessToken);
					if (teams.length > 0) {
						sections.push(`Teams (${teams.length}): ${teams.map((t) => t.displayName).join(", ")}`);
						for (const t of teams.slice(0, 5)) {
							refs.push({ type: "team", id: t.id, title: t.displayName });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Teams context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("chats")) {
		promises.push(
			(async () => {
				try {
					const chats = await getUserChats(accessToken);
					if (chats.length > 0) {
						const chatSummaries = chats.slice(0, 10).map((c) => (c.topic ? `"${c.topic}" (${c.chatType})` : `${c.chatType} chat`));
						sections.push(`Recent Chats (${chats.length}): ${chatSummaries.join(", ")}`);
						for (const c of chats.slice(0, 5)) {
							refs.push({ type: "chat", id: c.id, title: c.topic ?? c.chatType });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Chats context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("sharepoint")) {
		promises.push(
			(async () => {
				try {
					const sites = await getFollowedSites(accessToken);
					if (sites.length > 0) {
						sections.push(`SharePoint Sites (${sites.length}): ${sites.map((s) => s.displayName).join(", ")}`);
						for (const s of sites.slice(0, 5)) {
							refs.push({ type: "sharepoint-site", id: s.id, title: s.displayName });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] SharePoint context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("planner")) {
		promises.push(
			(async () => {
				try {
					const tasks = await getUserTasks(accessToken);
					if (tasks.length > 0) {
						const incomplete = tasks.filter((t) => t.percentComplete < 100);
						const taskSummaries = incomplete.slice(0, 15).map((t) => {
							const due = t.dueDateTime ? ` (due ${t.dueDateTime.slice(0, 10)})` : "";
							const progress = t.percentComplete > 0 ? ` [${t.percentComplete}%]` : "";
							return `- ${t.title}${progress}${due}`;
						});
						sections.push(`Planner Tasks (${incomplete.length} incomplete):\n${taskSummaries.join("\n")}`);
						for (const t of incomplete.slice(0, 5)) {
							refs.push({ type: "planner-task", id: t.id, title: t.title });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Planner context failed:", err);
				}
			})(),
		);
	}

	await Promise.all(promises);

	return {
		contextText: sections.join("\n\n"),
		contextRefs: refs,
	};
}

// ─── Auto-Title (fire-and-forget) ────────────────────────────────────────────

async function autoTitleConversation(conversationId: string, userMessage: string, env: Env): Promise<void> {
	try {
		const { system, user } = buildTitleGenerationPrompt(userMessage);
		const titleResponse = await callAI(system, user, env);
		const title = titleResponse.text.trim().slice(0, 80);
		if (title) {
			await updateConversationTitle(conversationId, title, env);
		}
	} catch (err) {
		console.error("[Arcadia Webapp] Title generation failed:", err);
	}
}
