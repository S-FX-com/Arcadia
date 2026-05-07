// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp streaming chat (Phase 3d)
//
// POST /api/webapp/chat/stream  →  text/event-stream
//
// Body shape mirrors /api/webapp/chat. Runs through runAgentStream
// (Phase 3d) which wraps the existing agent tool loop. The non-streaming
// /api/webapp/chat endpoint stays available for clients that need the
// full-text JSON response.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from "../types.js";
import type { WebappSession, WebappChatRequest } from "./types.js";
import { runAgentStream } from "../agent/loop-stream.js";
import { createConversation, getRecentMessages, saveMessage } from "./conversations.js";
import { buildArcadiaSystemPrompt } from "../lib/agency-prompt.js";

export async function handleChatStream(
	session: WebappSession,
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	let body: WebappChatRequest;
	try { body = (await request.json()) as WebappChatRequest; }
	catch { return new Response("invalid body", { status: 400 }); }

	if (!body.message || typeof body.message !== "string" || body.message.trim().length === 0) {
		return new Response("Message is required", { status: 400 });
	}

	const conversationId = body.conversationId ?? (await createConversation(session.userId, body.message.slice(0, 80), env));
	const history = await getRecentMessages(conversationId, env);

	// Persist the user turn before streaming starts so the row is durable
	// even if the client disconnects mid-stream.
	await saveMessage(conversationId, "user", body.message, null, env);

	let pinnedClient: { id: string; name: string; description: string | null } | null = null;
	if (body.clientId) {
		try {
			pinnedClient = await env.ARCADIA_DB.prepare(
				"SELECT id, name, description FROM clients WHERE id = ?",
			)
				.bind(body.clientId)
				.first<{ id: string; name: string; description: string | null }>() ?? null;
		} catch (err) {
			console.error("[Arcadia Webapp] stream pinnedClient lookup failed:", err);
		}
	}

	const systemPrompt = buildArcadiaSystemPrompt({
		env,
		userDisplayName: session.displayName,
		...(pinnedClient ? { pinnedClient } : {}),
	});

	const stream = runAgentStream({
		systemPrompt,
		userMessage: body.message,
		history: history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
		userAadId: session.userId,
		userDisplayName: session.displayName,
		env,
		ctx,
	});

	// Tee the stream so we can collect the full assistant text and persist
	// it as a single message after the stream completes.
	const [forClient, forPersist] = stream.tee();
	ctx.waitUntil(persistAssistantMessage(forPersist, conversationId, env));

	return new Response(forClient, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			"connection": "keep-alive",
		},
	});
}

async function persistAssistantMessage(stream: ReadableStream<Uint8Array>, conversationId: string, env: Env): Promise<void> {
	let assistantText = "";
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += dec.decode(value, { stream: true });
		let idx;
		while ((idx = buffer.indexOf("\n\n")) >= 0) {
			const block = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const lines = block.split("\n");
			const eventLine = lines.find((l) => l.startsWith("event: "));
			const dataLine  = lines.find((l) => l.startsWith("data: "));
			if (eventLine === "event: text" && dataLine) {
				try {
					const parsed = JSON.parse(dataLine.slice(6)) as { chunk?: string };
					if (parsed.chunk) assistantText += parsed.chunk;
				} catch {
					// ignore malformed frames
				}
			}
		}
	}
	if (assistantText.trim()) {
		await saveMessage(conversationId, "assistant", assistantText, null, env);
	}
}
