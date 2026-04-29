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
	const clientId = body.clientId ?? null;

	// 1. Get or create conversation
	let conversationId = body.conversationId;
	const isNewConversation = !conversationId;
	if (!conversationId) {
		conversationId = await createConversation(session.userId, "New conversation", env, clientId);
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

	// 4b. Load client memory context if a clientId is provided
	const clientContext = clientId ? await loadClientContext(clientId, env) : null;

	let combinedContext = contextText;
	if (clientContext) {
		combinedContext = clientContext + (contextText ? `\n\n--- M365 Context ---\n${contextText}` : '');
	}

	const extraContext = combinedContext ? (clientContext ? combinedContext : `--- M365 Context ---\n${combinedContext}`) : undefined;
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

	// 6. Save assistant response; capture message ID for Phase 11 feedback
	const assistantMessageId = await saveMessage(conversationId, "assistant", result.text, contextRefs.length > 0 ? contextRefs : null, env);

	// 7. Fire-and-forget: auto-title for new conversations (memory is handled by pipeline)
	if (isNewConversation) {
		ctx.waitUntil(autoTitleConversation(conversationId, userMessage, env));
	}

	return {
		conversationId,
		messageId: assistantMessageId,
		message: result.text,
		contextUsed: contextRefs,
		...(result.imageUrl !== undefined ? { imageUrl: result.imageUrl } : {}),
		...(result.model !== undefined ? { model: result.model } : {}),
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

// ─── Client context loader ────────────────────────────────────────────────────

interface ClientRow { name: string; memory_summary: string | null }
interface ClientMemRow { content: string; category: string }

async function loadClientContext(clientId: string, env: Env): Promise<string | null> {
	try {
		const client = await env.ARCADIA_DB.prepare("SELECT name, memory_summary FROM clients WHERE id = ?")
			.bind(clientId).first<ClientRow>();
		if (!client) return null;

		const memories = await env.ARCADIA_DB.prepare(
			"SELECT content, category FROM client_memories WHERE client_id = ? ORDER BY importance DESC LIMIT 20"
		).bind(clientId).all<ClientMemRow>();

		const lines: string[] = [`--- Client Context: ${client.name} ---`];
		if (client.memory_summary) {
			lines.push(client.memory_summary);
		}
		if (memories.results?.length) {
			lines.push('\nKey facts:');
			for (const m of memories.results) {
				lines.push(`- [${m.category}] ${m.content}`);
			}
		}
		return lines.join('\n');
	} catch (err) {
		console.error("[Arcadia Webapp] Client context load failed:", err);
		return null;
	}
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
