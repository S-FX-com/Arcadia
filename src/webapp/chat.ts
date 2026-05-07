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
import { getUserShifts, getOpenShifts, getTimesOff } from "./context/shifts.js";
import { getPendingUpdates } from "./context/updates.js";
import { getUserPresence } from "./context/presence.js";
import { getUpcomingEvents } from "./context/calendar.js";
import { getRecentDriveItems } from "./context/onedrive.js";
import { getRelevantPeople } from "./context/people.js";
import { callAI } from "../ai/router.js";
import { isAdmin } from "./middleware.js";
import { runArcadiaPipeline } from "../pipeline/arcadia-pipeline.js";
import { buildArcadiaSystemPrompt } from "../lib/agency-prompt.js";

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
	const agentLoopOn = env.AGENT_LOOP_ENABLED === "true";

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

	// 4. Gather M365 context — only for sources the user explicitly opted into via
	// the context chips. The agent loop reaches for these on demand via tools, so
	// we no longer prefetch the whole tenant on every "hello". The legacy pipeline
	// path still uses anything the user explicitly asked for.
	const accessToken = await getSessionAccessToken(session, env);
	const { contextText, contextRefs } = contextSources.length > 0
		? await gatherM365Context(accessToken, contextSources, session.userId)
		: { contextText: "", contextRefs: [] as ContextRef[] };

	// 5. Run the unified Arcadia pipeline (context assembly + AI + memory).
	const workerUrl = new URL(request.url).origin;

	// fetchUserFullContext is a multi-Graph crawl across every joined team and
	// chat. It belongs only on the legacy pipeline (which lacks tools); the
	// agent loop fetches what it needs via search-teams-messages / search-documents.
	const preloadedMessages = agentLoopOn
		? ([] as import("../types.js").ChannelMessage[])
		: await fetchUserFullContext(accessToken).catch((err) => {
				console.error("[Arcadia Webapp] fetchUserFullContext failed:", err);
				return [] as import("../types.js").ChannelMessage[];
			});

	// 4b. If the user pinned a client via the UI, fetch its identity for the
	// system prompt header. The grounded sources/memories are pulled by the
	// agent on demand via the get_client_context tool — we only need the name
	// here so the model knows it's already in CLIENT MODE.
	const pinnedClient = clientId ? await loadPinnedClient(clientId, env) : null;

	const m365Section = contextText ? `--- M365 Context ---\n${contextText}` : "";
	const extraContext = m365Section ? m365Section : undefined;

	let result: { text: string; imageUrl?: string; model?: string };
	if (agentLoopOn) {
		const { runAgent } = await import("../agent/loop.js");
		const systemPrompt = buildArcadiaSystemPrompt({
			env,
			userDisplayName: session.displayName,
			...(pinnedClient ? { pinnedClient } : {}),
			...(extraContext ? { extraContext } : {}),
		});
		const out = await runAgent({
			systemPrompt,
			userMessage,
			history: history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
			userAadId: session.userId,
			userDisplayName: session.displayName,
			env,
			ctx,
		});
		result = { text: out.text, model: out.model };
	} else {
		// Legacy pipeline path: no tools, so we still bake the client memory
		// blob (when pinned) into extraContext like the old behavior.
		const legacyClientBlob = clientId ? await loadClientContext(clientId, env) : null;
		const legacyExtra = [legacyClientBlob, m365Section].filter((s) => s && s.length > 0).join("\n\n");
		result = await runArcadiaPipeline({
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
			...(legacyExtra.length > 0 ? { extraContext: legacyExtra } : {}),
			env,
			ctx,
		});
	}

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

async function gatherM365Context(accessToken: string, sources: ContextSource[], userId?: string): Promise<{ contextText: string; contextRefs: ContextRef[] }> {
	// Empty sources means the user didn't toggle any context chips — return
	// nothing rather than fanning out across every Graph endpoint.
	if (sources.length === 0) {
		return { contextText: "", contextRefs: [] };
	}

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

	if (sources.includes("shifts") && userId) {
		promises.push(
			(async () => {
				try {
					const teams = await getUserTeams(accessToken);
					const teamIds = teams.map((t) => t.id);
					const shifts = await getUserShifts(accessToken, userId, teamIds);
					if (shifts.length > 0) {
						const shiftLines = shifts.slice(0, 10).map((s) => {
							const start = new Date(s.startDateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
							const end = new Date(s.endDateTime).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit" });
							const notes = s.notes ? ` — ${s.notes}` : "";
							return `- ${s.displayName}: ${start} – ${end}${notes}`;
						});
						sections.push(`Upcoming Shifts (next 14 days, ${shifts.length} total):\n${shiftLines.join("\n")}`);
						for (const s of shifts.slice(0, 5)) {
							refs.push({ type: "teams-shift", id: s.id, title: `${s.displayName} (${new Date(s.startDateTime).toLocaleDateString()})` });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Shifts context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("updates")) {
		promises.push(
			(async () => {
				try {
					const updates = await getPendingUpdates(accessToken);
					const pending = updates.filter((u) => u.status !== "completed");
					if (pending.length > 0) {
						const updateLines = pending.slice(0, 10).map((u) => {
							const when = new Date(u.createdDateTime).toLocaleDateString();
							return `- "${u.title}" requested by ${u.requestedBy} on ${when} [${u.status}]`;
						});
						sections.push(`Teams Updates — Pending Requests (${pending.length}):\n${updateLines.join("\n")}`);
						for (const u of pending.slice(0, 5)) {
							refs.push({ type: "teams-update", id: u.id, title: u.title });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Updates context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("presence")) {
		promises.push(
			(async () => {
				try {
					const presence = await getUserPresence(accessToken);
					sections.push(`Your current Teams presence: ${presence.availability} (${presence.activity})`);
				} catch (err) {
					console.error("[Arcadia Webapp] Presence context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("calendar")) {
		promises.push(
			(async () => {
				try {
					const events = await getUpcomingEvents(accessToken, 7);
					if (events.length > 0) {
						const lines = events.slice(0, 15).map((e) => {
							const start = new Date(e.startDateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
							const online = e.isOnlineMeeting ? " [online]" : "";
							const loc = !e.isOnlineMeeting && e.location ? ` @ ${e.location}` : "";
							return `- ${e.subject} — ${start}${online}${loc}`;
						});
						sections.push(`Upcoming Calendar Events (next 7 days, ${events.length} total):\n${lines.join("\n")}`);
						for (const e of events.slice(0, 5)) {
							refs.push({ type: "calendar-event", id: e.id, title: e.subject });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] Calendar context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("onedrive")) {
		promises.push(
			(async () => {
				try {
					const items = await getRecentDriveItems(accessToken, 20);
					if (items.length > 0) {
						const lines = items.slice(0, 10).map((f) => {
							const modified = new Date(f.lastModifiedDateTime).toLocaleDateString();
							return `- ${f.name} (modified ${modified})`;
						});
						sections.push(`Recent OneDrive Files (${items.length}):\n${lines.join("\n")}`);
						for (const f of items.slice(0, 5)) {
							refs.push({ type: "onedrive-item", id: f.id, title: f.name });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] OneDrive context failed:", err);
				}
			})(),
		);
	}

	if (sources.includes("people")) {
		promises.push(
			(async () => {
				try {
					const people = await getRelevantPeople(accessToken, 20);
					if (people.length > 0) {
						const lines = people.slice(0, 15).map((p) => {
							const detail = [p.jobTitle, p.officeLocation].filter(Boolean).join(", ");
							return `- ${p.displayName}${detail ? ` (${detail})` : ""}${p.mail ? ` <${p.mail}>` : ""}`;
						});
						sections.push(`Relevant People / Contacts (${people.length}):\n${lines.join("\n")}`);
						for (const p of people.slice(0, 5)) {
							refs.push({ type: "person", id: p.id, title: p.displayName });
						}
					}
				} catch (err) {
					console.error("[Arcadia Webapp] People context failed:", err);
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
interface PinnedClientRow { id: string; name: string; description: string | null }

async function loadPinnedClient(
	clientId: string,
	env: Env,
): Promise<{ id: string; name: string; description: string | null } | null> {
	try {
		const row = await env.ARCADIA_DB.prepare(
			"SELECT id, name, description FROM clients WHERE id = ?",
		)
			.bind(clientId)
			.first<PinnedClientRow>();
		return row ?? null;
	} catch (err) {
		console.error("[Arcadia Webapp] loadPinnedClient failed:", err);
		return null;
	}
}

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
