// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — AI Model Router
//
// Uses Cloudflare Workers AI for all inference.
// Phase 10: routes through model registry for purpose-based model selection.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentMode, AIResponse, AIStreamOptions, AssembledContext, ConversationTurn, Env } from "../types.js";
import { AI } from "../constants.js";
import { getModel, type ModelPurpose } from "./model-registry.js";

type CFAIResult = {
	response?: string;
	text?: string;
	choices?: Array<{ message?: { content?: string } }>;
};

export function extractCFAIText(result: unknown): string | undefined {
	const r = result as CFAIResult;
	return r.response ?? r.text ?? r.choices?.[0]?.message?.content ?? undefined;
}

async function callCFWorkersAI(system: string, user: string, env: Env, options: AIStreamOptions = {}, modelOverride?: string): Promise<string> {
	const model = modelOverride ?? getModel('quick-chat', env).modelId;
	const result = await env.AI.run(
		model as Parameters<typeof env.AI.run>[0],
		{
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			max_tokens: options.max_tokens ?? AI.DEFAULT_MAX_TOKENS,
			...(options.temperature !== undefined && { temperature: options.temperature }),
		} as Parameters<typeof env.AI.run>[1],
	);

	const responseText = extractCFAIText(result);

	if (!responseText) {
		console.error(`[Arcadia AI] CF Workers AI returned unexpected result for ${model}:`, JSON.stringify(result));
		throw new Error(`CF Workers AI (${model}) returned empty response`);
	}
	return responseText;
}

export async function callCFWorkersAIStream(system: string, user: string, env: Env, options: AIStreamOptions = {}, modelOverride?: string): Promise<ReadableStream> {
	const model = modelOverride ?? getModel('quick-chat', env).modelId;
	const result = await env.AI.run(
		model as Parameters<typeof env.AI.run>[0],
		{
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			stream: true,
			max_tokens: options.max_tokens ?? AI.DEFAULT_MAX_TOKENS,
			...(options.temperature !== undefined && { temperature: options.temperature }),
		} as Parameters<typeof env.AI.run>[1],
	);

	if (!(result instanceof ReadableStream)) {
		throw new Error("CF Workers AI did not return a ReadableStream when stream:true was requested");
	}
	return result;
}

export async function callAI(system: string, user: string, env: Env): Promise<AIResponse> {
	const text = await callCFWorkersAI(system, user, env);
	return { text, model: "cf-workers-ai" };
}

/**
 * Purpose-routed AI call. Uses the model registered for `purpose` in the
 * model registry, with optional advisor pass for supported purposes.
 */
export async function callAIForPurpose(
	purpose: ModelPurpose,
	system: string,
	user: string,
	env: Env,
	options: AIStreamOptions = {},
): Promise<AIResponse> {
	const config = getModel(purpose, env);
	const text = await callCFWorkersAI(system, user, env, { ...options, max_tokens: options.max_tokens ?? config.maxTokens || AI.DEFAULT_MAX_TOKENS }, config.modelId);
	return { text, model: "cf-workers-ai" };
}

/**
 * Multi-turn conversation call.
 * Replays the conversation history (capped at last 16 turns) so the model
 * has context for the current user message.
 */
export async function callAIWithHistory(
	system: string,
	history: ConversationTurn[],
	userMessage: string,
	env: Env,
	options: AIStreamOptions = {},
): Promise<AIResponse> {
	type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

	const messages: ChatMsg[] = [
		{ role: "system", content: system },
		// Keep last 16 turns (8 exchanges) to stay within context limits
		...history.slice(-AI.HISTORY_MAX_TURNS).map((t) => ({ role: t.role as "user" | "assistant", content: t.content })),
		{ role: "user", content: userMessage },
	];

	const model = getModel('quick-chat', env).modelId;
	const result = await env.AI.run(
		model as Parameters<typeof env.AI.run>[0],
		{
			messages,
			max_tokens: options.max_tokens ?? AI.DEFAULT_MAX_TOKENS,
			...(options.temperature !== undefined && { temperature: options.temperature }),
		} as Parameters<typeof env.AI.run>[1],
	);

	const responseText = extractCFAIText(result);

	if (!responseText) {
		console.error(`[Arcadia AI] CF Workers AI returned unexpected result for multi-turn call (${model}):`, JSON.stringify(result));
		throw new Error(`CF Workers AI (${model}) returned empty response for multi-turn call`);
	}
	return { text: responseText, model: "cf-workers-ai" };
}

// ─── Context-enriched AI calls (Phase 4) ─────────────────────────────────────

/**
 * Context-enriched single-turn AI call.
 * Assembles memories, profile, and channel context before calling the model.
 * This is the primary entry point for all memory-aware interactions.
 */
export async function callAIWithContext(
	query: string,
	userId: string | null,
	channelId: string | null,
	teamId: string | null,
	mode: AgentMode,
	env: Env,
	options: AIStreamOptions = {},
): Promise<{ response: AIResponse; context: AssembledContext }> {
	const { assembleContext } = await import("../intelligence/context-engine.js");
	const context = await assembleContext(query, userId, channelId, teamId, mode, env);
	const text = await callCFWorkersAI(context.systemPrompt, query, env, options);
	return { response: { text, model: "cf-workers-ai" }, context };
}

/**
 * Context-enriched multi-turn call for DMs.
 * Assembles rich context (memories + profile), then runs the full conversation history.
 */
export async function callAIWithContextAndHistory(
	history: ConversationTurn[],
	userMessage: string,
	userId: string,
	channelId: string | null,
	teamId: string | null,
	isAdmin: boolean,
	env: Env,
	options: AIStreamOptions = {},
): Promise<{ response: AIResponse; context: AssembledContext }> {
	const { assembleContext } = await import("../intelligence/context-engine.js");
	const { buildDMSystemPrompt } = await import("./prompts.js");

	// Load profile first so we can pass it to buildDMSystemPrompt
	const { resolveUserProfile } = await import("../intelligence/profiles.js");
	const profile = await resolveUserProfile(userId, env);

	// Build the DM-specific base prompt (includes profile + access level)
	const basePrompt = buildDMSystemPrompt(profile?.displayName ?? "there", isAdmin, profile?.insights ?? null);

	// Assemble context using the DM base prompt
	const context = await assembleContext(userMessage, userId, channelId, teamId, "conversation", env, basePrompt);

	// Override assembled context's profile with what we already loaded
	context.userProfile = profile;

	type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
	const messages: ChatMsg[] = [
		{ role: "system", content: context.systemPrompt },
		...history.slice(-AI.HISTORY_MAX_TURNS).map((t) => ({ role: t.role as "user" | "assistant", content: t.content })),
		{ role: "user", content: userMessage },
	];

	const model = getModel('quick-chat', env).modelId;
	const result = await env.AI.run(
		model as Parameters<typeof env.AI.run>[0],
		{
			messages,
			max_tokens: options.max_tokens ?? AI.DEFAULT_MAX_TOKENS,
			...(options.temperature !== undefined && { temperature: options.temperature }),
		} as Parameters<typeof env.AI.run>[1],
	);

	const responseText = extractCFAIText(result);

	if (!responseText) {
		console.error(`[Arcadia AI] CF Workers AI returned unexpected result for context+history call (${model}):`, JSON.stringify(result));
		throw new Error(`CF Workers AI (${model}) returned empty response for context+history call`);
	}

	return { response: { text: responseText, model: "cf-workers-ai" }, context };
}

export async function callAIStream(system: string, user: string, env: Env, options: AIStreamOptions = {}): Promise<ReadableStream> {
	try {
		return await callCFWorkersAIStream(system, user, env, options);
	} catch (err) {
		console.warn("CF Workers AI stream failed, falling back to non-streaming:", err);
		const response = await callAI(system, user, env);
		const enc = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				const chunk = JSON.stringify({ response: response.text });
				controller.enqueue(enc.encode(`data: ${chunk}\n\n`));
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
	}
}
