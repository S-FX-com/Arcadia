// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Context Engine
//
// Assembles rich context before every AI call:
//   1. Recall relevant memories (keyword + importance + recency scoring)
//   2. Load user profile insights
//   3. Load recent channel messages
//   4. Load active tasks
//   5. Build a contextual system prompt that injects all of the above
//
// Token budget (@cf/google/gemma-4-26b-a4b-it — 256K context window):
//   - System prompt base:   ~2,000 tokens
//   - Memory context:      ~12,000 tokens
//   - User profile:         ~2,000 tokens
//   - Channel context:     ~30,000 tokens
//   - Active tasks:         ~2,000 tokens
//   - User message:         ~2,000 tokens
//   - Response headroom:    ~8,000 tokens
//   Total context budget: ~50,000 (well within 256K, leaves headroom for history)
// ─────────────────────────────────────────────────────────────────────────────

import { recallMemories, promoteMemory } from "../memory/long-term.js";
import { loadCachedMessages } from "../memory/kv.js";
import { loadUserCrossContext } from "./cross-context.js";
import { resolveUserProfile } from "./profiles.js";
import { ARCADIA_SYSTEM_PROMPT, buildDMSystemPrompt } from "../ai/prompts.js";
import { assembleLayeredContext, formatLayeredContextForPrompt } from "../memory/layers.js";
import { features } from "../features.js";
import type { AgentMode, AssembledContext, ChannelMessage, Env, Memory, MemoryCategory, ProfileInsights, TaskRow, UserProfile } from "../types.js";
import { createLogger } from "../lib/logger.js";
import { swallow } from "../lib/swallow.js";

const log = createLogger({ component: "context-engine" });

// ─── Token budget ─────────────────────────────────────────────────────────────

const TOKEN_BUDGET_TOTAL = 50000; // 256K model — use ~50K for assembled context, rest for history + response

const MODE_BUDGETS: Record<AgentMode, { memories: number; profile: number; channel: number; tasks: number }> = {
	conversation: { memories: 12000, profile: 2000, channel: 30000, tasks: 2000 },
	analysis:     { memories:  6000, profile: 1000, channel: 35000, tasks: 4000 },
	task:         { memories:  3000, profile:    0, channel: 10000, tasks: 8000 },
	background:   { memories: 20000, profile:    0, channel:     0, tasks:    0 },
};

const MEMORY_RECALL_LIMITS: Record<AgentMode, number> = {
	conversation: 30,
	analysis: 15,
	task: 8,
	background: 50,
};

const MEMORY_CATEGORIES_BY_MODE: Record<AgentMode, MemoryCategory[] | null> = {
	conversation: null, // all categories
	analysis: ["semantic", "procedural"],
	task: ["procedural"],
	background: null, // all categories
};

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough token count: 1 token ≈ 4 characters for English text. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatCurrentDateForPrompt(): string {
	const now = new Date();
	const iso = now.toISOString().slice(0, 10);
	const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
	return `**Current date (UTC):** ${weekday}, ${iso}`;
}

// ─── Context formatters ──────────────────────────────────────────────────────

function formatMemoriesForPrompt(memories: Memory[], maxTokens: number): string {
	if (memories.length === 0) return "";

	const lines: string[] = [];
	let used = 0;

	for (const mem of memories) {
		const line = `[${mem.category}] ${mem.content}`;
		const cost = estimateTokens(line) + 2;
		if (used + cost > maxTokens) break;
		lines.push(line);
		used += cost;
	}

	if (lines.length === 0) return "";
	return `**What I remember (relevant context):**\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

function formatProfileForPrompt(profile: UserProfile | null, maxTokens: number): string {
	if (!profile?.insights) return "";

	const insights: ProfileInsights = profile.insights;
	const parts: string[] = [];

	if (insights.communicationStyle?.summary) {
		parts.push(`Style: ${insights.communicationStyle.summary}`);
	}
	if (insights.focusAreas?.primary?.length) {
		parts.push(`Focus: ${insights.focusAreas.primary.join(", ")}`);
	}
	if (insights.workingPatterns?.responseStyle) {
		parts.push(`Working style: ${insights.workingPatterns.responseStyle}`);
	}

	if (parts.length === 0) return "";

	const text = `**Profile — ${profile.displayName}:**\n${parts.map((p) => `- ${p}`).join("\n")}`;
	if (estimateTokens(text) > maxTokens) {
		return parts.length > 0 ? `**${profile.displayName}:** ${parts[0]}` : "";
	}
	return text;
}

function formatChannelContextForPrompt(messages: ChannelMessage[], maxTokens: number, label = "Recent channel context"): string {
	if (messages.length === 0) return "";

	// Most recent first, trim oldest if over budget
	const sorted = messages.slice().sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));

	const lines: string[] = [];
	let used = 0;

	for (const msg of sorted) {
		const channel = msg.channelName ? `#${msg.channelName} ` : "";
		const line = `[${msg.timestamp.slice(0, 16)}] ${channel}${msg.authorName}: ${msg.text.slice(0, 300)}`;
		const cost = estimateTokens(line) + 2;
		if (used + cost > maxTokens) break;
		lines.push(line);
		used += cost;
	}

	if (lines.length === 0) return "";
	return `**${label}:**\n${lines.reverse().join("\n")}`;
}

function formatTasksForPrompt(tasks: TaskRow[], maxTokens: number): string {
	if (tasks.length === 0) return "";

	const lines: string[] = [];
	let used = 0;

	for (const task of tasks.slice(0, 10)) {
		const owner = task.owner_name ? ` → ${task.owner_name}` : " → unowned";
		const deadline = task.deadline ? ` (due ${new Date(task.deadline * 1000).toISOString().slice(0, 10)})` : "";
		const line = `[${task.status}${task.priority === "high" ? " !HIGH" : ""}] ${task.description}${owner}${deadline}`;
		const cost = estimateTokens(line) + 2;
		if (used + cost > maxTokens) break;
		lines.push(line);
		used += cost;
	}

	if (lines.length === 0) return "";
	return `**Active tasks:**\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ─── Context assembly ─────────────────────────────────────────────────────────

/**
 * Build a context-enriched system prompt from all assembled pieces.
 */
export function buildContextualSystemPrompt(
	mode: AgentMode,
	basePrompt: string,
	memories: Memory[],
	profile: UserProfile | null,
	channelMessages: ChannelMessage[],
	tasks: TaskRow[],
	channelLabel?: string,
): string {
	const budgets = MODE_BUDGETS[mode];
	const sections: string[] = [basePrompt, formatCurrentDateForPrompt()];

	const memSection = formatMemoriesForPrompt(memories, budgets.memories);
	const profileSection = formatProfileForPrompt(profile, budgets.profile);
	const channelSection = formatChannelContextForPrompt(channelMessages, budgets.channel, channelLabel);
	const taskSection = formatTasksForPrompt(tasks, budgets.tasks);

	if (memSection) sections.push(memSection);
	if (profileSection) sections.push(profileSection);
	if (channelSection) sections.push(channelSection);
	if (taskSection) sections.push(taskSection);

	return sections.join("\n\n");
}

// ─── Main assembly function ───────────────────────────────────────────────────

/**
 * Assemble rich context for an AI call.
 * Runs memory recall, profile load, and channel load in parallel.
 * Promotes recalled memories (fire-and-forget).
 */
export async function assembleContext(
	query: string,
	userId: string | null,
	channelId: string | null,
	teamId: string | null,
	mode: AgentMode,
	env: Env,
	/** Optional pre-built base system prompt (e.g. buildDMSystemPrompt result). */
	baseSystemPrompt?: string,
	/** Pre-fetched messages (e.g. from delegated Graph API in webapp). Skips the KV/cross-context fetch when provided. */
	preloadedMessages?: ChannelMessage[],
): Promise<AssembledContext> {
	const recallLimit = MEMORY_RECALL_LIMITS[mode];
	const categoryFilter = MEMORY_CATEGORIES_BY_MODE[mode];
	const budgets = MODE_BUDGETS[mode];

	// Build recall filters — only include defined properties (exactOptionalPropertyTypes)
	const recallFilters: { category?: MemoryCategory; channelId?: string; userId?: string; aclUserAadId?: string } = {};
	if (categoryFilter !== null && categoryFilter.length === 1) {
		recallFilters.category = categoryFilter[0] as MemoryCategory;
	}
	if (channelId) recallFilters.channelId = channelId;
	if (userId) recallFilters.userId = userId;
	// Phase 13: when an asking user is identified, recallMemories applies the
	// per-user ACL filter (gated by ACL_ENFORCEMENT). Background callers pass
	// userId=null and recall remains unfiltered.
	if (userId) recallFilters.aclUserAadId = userId;

	// Parallel data fetches — Phase 6 layered context when VECTORIZE_ENABLED
	const useLayeredContext = features.vectorize(env);

	const [memories, profile, channelMessages, layeredCtx] = await Promise.all([
		// Memory recall — scoped by category and context (L2: always needed)
		recallMemories(query, env, recallLimit, recallFilters),
		// User profile — only for modes that use it
		budgets.profile > 0 && userId ? resolveUserProfile(userId, env) : Promise.resolve(null),
		// Channel messages — preloaded (webapp delegated) > specific channel > cross-context (DM KV scan)
		preloadedMessages
			? Promise.resolve(preloadedMessages)
			: budgets.channel > 0 && channelId && teamId
				? loadCachedMessages(teamId, channelId, env)
				: budgets.channel > 0 && !channelId && userId
					? loadUserCrossContext(userId, env)
					: Promise.resolve([] as ChannelMessage[]),
		// Phase 6: Layered context (L0+L1+L2+L3) when vector search enabled
		useLayeredContext
			? (() => {
					const layeredFilters: { category?: MemoryCategory; channelId?: string; userId?: string; aclUserAadId?: string } = {};
					if (categoryFilter !== null && categoryFilter.length === 1) layeredFilters.category = categoryFilter[0] as MemoryCategory;
					if (channelId) layeredFilters.channelId = channelId;
					if (userId) layeredFilters.userId = userId;
					if (userId) layeredFilters.aclUserAadId = userId;
					return assembleLayeredContext(query, env, mode, layeredFilters);
				})()
			: Promise.resolve(null),
	]);

	// Promote recalled memories (non-blocking — errors logged at warn but ignored)
	for (const mem of memories) {
		promoteMemory(mem.id, env).catch(swallow(log, "memory_promote_failed", undefined, { memoryId: mem.id }));
	}

	// Build system prompt
	const base =
		baseSystemPrompt ??
		(mode === "conversation" && userId
			? buildDMSystemPrompt(
					profile?.displayName ?? "there",
					false, // admin flag handled upstream
					profile?.insights ?? null,
				)
			: ARCADIA_SYSTEM_PROMPT);

	// DM mode: channel messages come from cross-context scan across all channels
	const isDMBroadContext = !channelId && !teamId && !!userId;
	const channelLabel = isDMBroadContext ? "Your recent activity across channels" : undefined;

	// Phase 6: Use layered context formatting when available
	let systemPrompt: string;
	if (layeredCtx) {
		// Layered assembly: L0+L1 always loaded, L2+L3 fill remaining budget
		const sections: string[] = [base, formatCurrentDateForPrompt()];
		const layeredSection = formatLayeredContextForPrompt(layeredCtx, budgets.memories);
		if (layeredSection) sections.push(layeredSection);

		const profileSection = formatProfileForPrompt(profile, budgets.profile);
		const channelSection = formatChannelContextForPrompt(channelMessages, budgets.channel, channelLabel);
		if (profileSection) sections.push(profileSection);
		if (channelSection) sections.push(channelSection);
		systemPrompt = sections.join("\n\n");
	} else {
		// Fallback: standard flat assembly (VECTORIZE_ENABLED=false)
		systemPrompt = buildContextualSystemPrompt(mode, base, memories, profile, channelMessages, [], channelLabel);
	}

	// Token budget tracking
	const used = estimateTokens(systemPrompt);
	const remaining = TOKEN_BUDGET_TOTAL - used;

	// Merge all recalled memories (L2 + L3 deduplicated)
	const allMemories = layeredCtx
		? [...layeredCtx.l2KeywordMemories, ...layeredCtx.l3SemanticMemories.filter((m) => !layeredCtx.l2KeywordMemories.some((l2) => l2.id === m.id))]
		: memories;

	return {
		mode,
		systemPrompt,
		memories: allMemories,
		userProfile: profile,
		channelMessages,
		activeTasks: [],
		tokenBudget: {
			total: TOKEN_BUDGET_TOTAL,
			used,
			remaining,
		},
	};
}

/**
 * Determine the appropriate agent mode from routing context.
 * This is the single authoritative mapping — not user-configurable.
 */
export function resolveAgentMode(isDM: boolean, intent: string): AgentMode {
	if (isDM) return "conversation";
	switch (intent) {
		case "summarize":
		case "decisions":
		case "next-steps":
		case "exec-summary":
		case "status":
		case "who-owns":
		case "knowledge": // Phase 6: KG query intent
			return "analysis";
		case "assign":
		case "tasks":
			return "task";
		default:
			return "conversation";
	}
}
