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
// Token budget (8K context window, Gemma 3 12B):
//   - System prompt base:  ~800 tokens
//   - Memory context:     ~2000 tokens
//   - User profile:        ~500 tokens
//   - Channel context:    ~2000 tokens
//   - Active tasks:        ~500 tokens
//   - User message:       ~1000 tokens
//   - Response headroom:  ~1200 tokens
//   Total: ~8000 (leave margin)
// ─────────────────────────────────────────────────────────────────────────────

import { recallMemories, promoteMemory } from "../memory/long-term.js";
import { loadCachedMessages } from "../memory/kv.js";
import { resolveUserProfile } from "./profiles.js";
import { ARCADIA_SYSTEM_PROMPT, buildDMSystemPrompt } from "../ai/prompts.js";
import { assembleLayeredContext, formatLayeredContextForPrompt } from "../memory/layers.js";
import type {
  AgentMode,
  AssembledContext,
  ChannelMessage,
  Env,
  Memory,
  MemoryCategory,
  ProfileInsights,
  TaskRow,
  UserProfile,
} from "../types.js";

// ─── Token budget ─────────────────────────────────────────────────────────────

const TOKEN_BUDGET_TOTAL = 7200; // Conservative cap leaving headroom for response

const MODE_BUDGETS: Record<AgentMode, { memories: number; profile: number; channel: number; tasks: number }> = {
  conversation: { memories: 1800, profile: 500,  channel: 1500, tasks: 400  },
  analysis:     { memories: 1000, profile: 200,  channel: 2000, tasks: 600  },
  task:         { memories: 600,  profile: 0,    channel: 800,  tasks: 800  },
  background:   { memories: 2000, profile: 0,    channel: 0,    tasks: 0    },
};

const MEMORY_RECALL_LIMITS: Record<AgentMode, number> = {
  conversation: 5,
  analysis:     3,
  task:         2,
  background:   10,
};

const MEMORY_CATEGORIES_BY_MODE: Record<AgentMode, MemoryCategory[] | null> = {
  conversation: null,        // all categories
  analysis:     ["semantic", "procedural"],
  task:         ["procedural"],
  background:   null,        // all categories
};

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough token count: 1 token ≈ 4 characters for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

function formatChannelContextForPrompt(messages: ChannelMessage[], maxTokens: number): string {
  if (messages.length === 0) return "";

  // Most recent first, trim oldest if over budget
  const sorted = messages
    .slice()
    .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));

  const lines: string[] = [];
  let used = 0;

  for (const msg of sorted) {
    const line = `[${msg.timestamp.slice(0, 16)}] ${msg.authorName}: ${msg.text.slice(0, 300)}`;
    const cost = estimateTokens(line) + 2;
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return "";
  return `**Recent channel context:**\n${lines.reverse().join("\n")}`;
}

function formatTasksForPrompt(tasks: TaskRow[], maxTokens: number): string {
  if (tasks.length === 0) return "";

  const lines: string[] = [];
  let used = 0;

  for (const task of tasks.slice(0, 10)) {
    const owner = task.owner_name ? ` → ${task.owner_name}` : " → unowned";
    const deadline = task.deadline
      ? ` (due ${new Date(task.deadline * 1000).toISOString().slice(0, 10)})`
      : "";
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
  tasks: TaskRow[]
): string {
  const budgets = MODE_BUDGETS[mode];
  const sections: string[] = [basePrompt];

  const memSection = formatMemoriesForPrompt(memories, budgets.memories);
  const profileSection = formatProfileForPrompt(profile, budgets.profile);
  const channelSection = formatChannelContextForPrompt(channelMessages, budgets.channel);
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
  baseSystemPrompt?: string
): Promise<AssembledContext> {
  const recallLimit = MEMORY_RECALL_LIMITS[mode];
  const categoryFilter = MEMORY_CATEGORIES_BY_MODE[mode];
  const budgets = MODE_BUDGETS[mode];

  // Build recall filters — only include defined properties (exactOptionalPropertyTypes)
  const recallFilters: { category?: MemoryCategory; channelId?: string; userId?: string } = {};
  if (categoryFilter !== null && categoryFilter.length === 1) {
    recallFilters.category = categoryFilter[0] as MemoryCategory;
  }
  if (channelId) recallFilters.channelId = channelId;
  if (userId) recallFilters.userId = userId;

  // Parallel data fetches — Phase 6 layered context when VECTORIZE_ENABLED
  const useLayeredContext = env.VECTORIZE_ENABLED === "true";

  const [memories, profile, channelMessages, layeredCtx] = await Promise.all([
    // Memory recall — scoped by category and context (L2: always needed)
    recallMemories(query, env, recallLimit, recallFilters),
    // User profile — only for modes that use it
    budgets.profile > 0 && userId
      ? resolveUserProfile(userId, env)
      : Promise.resolve(null),
    // Channel messages — only for modes that use channel context
    budgets.channel > 0 && channelId && teamId
      ? loadCachedMessages(teamId, channelId, env)
      : Promise.resolve([] as ChannelMessage[]),
    // Phase 6: Layered context (L0+L1+L2+L3) when vector search enabled
    useLayeredContext
      ? (() => {
          const layeredFilters: { category?: MemoryCategory; channelId?: string; userId?: string } = {};
          if (categoryFilter !== null && categoryFilter.length === 1) layeredFilters.category = categoryFilter[0] as MemoryCategory;
          if (channelId) layeredFilters.channelId = channelId;
          if (userId) layeredFilters.userId = userId;
          return assembleLayeredContext(query, env, mode, layeredFilters);
        })()
      : Promise.resolve(null),
  ]);

  // Promote recalled memories (non-blocking — errors swallowed)
  for (const mem of memories) {
    promoteMemory(mem.id, env).catch(() => {});
  }

  // Build system prompt
  const base =
    baseSystemPrompt ??
    (mode === "conversation" && userId
      ? buildDMSystemPrompt(
          profile?.displayName ?? "there",
          false, // admin flag handled upstream
          profile?.insights ?? null
        )
      : ARCADIA_SYSTEM_PROMPT);

  // Phase 6: Use layered context formatting when available
  let systemPrompt: string;
  if (layeredCtx) {
    // Layered assembly: L0+L1 always loaded, L2+L3 fill remaining budget
    const sections: string[] = [base];
    const layeredSection = formatLayeredContextForPrompt(layeredCtx, budgets.memories);
    if (layeredSection) sections.push(layeredSection);

    const profileSection = formatProfileForPrompt(profile, budgets.profile);
    const channelSection = formatChannelContextForPrompt(channelMessages.slice(-20), budgets.channel);
    if (profileSection) sections.push(profileSection);
    if (channelSection) sections.push(channelSection);
    systemPrompt = sections.join("\n\n");
  } else {
    // Fallback: standard flat assembly (VECTORIZE_ENABLED=false)
    systemPrompt = buildContextualSystemPrompt(
      mode,
      base,
      memories,
      profile,
      channelMessages.slice(-20),
      []
    );
  }

  // Token budget tracking
  const used = estimateTokens(systemPrompt);
  const remaining = TOKEN_BUDGET_TOTAL - used;

  // Merge all recalled memories (L2 + L3 deduplicated)
  const allMemories = layeredCtx
    ? [
        ...layeredCtx.l2KeywordMemories,
        ...layeredCtx.l3SemanticMemories.filter(
          (m) => !layeredCtx.l2KeywordMemories.some((l2) => l2.id === m.id)
        ),
      ]
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
export function resolveAgentMode(
  isDM: boolean,
  intent: string
): AgentMode {
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
