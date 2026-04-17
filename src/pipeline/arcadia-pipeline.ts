// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Unified Pipeline (Phase 2 / Tier 3)
//
// Single internal pipeline shared by the Teams bot (`/api/messages`) and the
// webapp (`/api/webapp/chat`). Both entry points assemble the same input shape
// and receive the same ArcadiaResponse — guaranteeing parity in context
// assembly, model call, and memory recording.
//
//   assembleContext → callAI → formatResponse → recordMemory → return
//
// Memory recording is fire-and-forget and respects env.MEMORY_ENABLED. If an
// ExecutionContext is provided, it is attached via ctx.waitUntil so the
// background work survives after the response is returned.
// ─────────────────────────────────────────────────────────────────────────────

import { AI } from "../constants.js";
import { extractCFAIText } from "../ai/router.js";
import { buildDMSystemPrompt } from "../ai/prompts.js";
import { buildWebappSystemPrompt } from "../webapp/prompts.js";
import { assembleContext } from "../intelligence/context-engine.js";
import { resolveUserProfile } from "../intelligence/profiles.js";
import { recallMemories, recordMemory } from "../memory/long-term.js";
import { recordMemoriesFromInteraction } from "../bot/memory-recording.js";
import { trimForTeams } from "../bot/messages.js";
import { detectImageIntent, generateAndStoreImage } from "../ai/image.js";
import { features } from "../features.js";
import type {
  AssembledContext,
  ConversationTurn,
  Env,
  Memory,
  AIResponse,
} from "../types.js";

export type PipelineMode = "teams-bot" | "webapp";
export type PipelineSurface = "dm" | "groupchat" | "channel" | "webapp";

export interface PipelineUser {
  id: string;
  displayName: string;
  isAdmin: boolean;
}

export interface PipelineConversation {
  /** Arcadia-side conversation identifier (Teams conversation.id or webapp conversationId). */
  id: string;
  surface: PipelineSurface;
  channelId: string | null;
  teamId: string | null;
  /** Human-readable channel/DM label used for memory recording. */
  channelName: string;
}

export interface ArcadiaPipelineInput {
  mode: PipelineMode;
  user: PipelineUser;
  /** The user's message, already stripped of @mention / commands. */
  text: string;
  conversation: PipelineConversation;
  history: ConversationTurn[];
  /** Extra pre-assembled context (M365 data, admin team-profile preamble, etc.). */
  extraContext?: string;
  /** Worker origin URL (e.g. https://arcadia.example.workers.dev) — required for image generation. */
  workerUrl?: string;
  /** Pre-fetched channel messages from delegated Graph API (webapp full-context path). */
  preloadedMessages?: import("../types.js").ChannelMessage[];
  env: Env;
  /** Passed for fire-and-forget memory writes when available (webapp). */
  ctx?: ExecutionContext;
}

export interface ArcadiaResponse {
  /** Raw model text. */
  rawText: string;
  /** Text formatted for the requesting surface (trimmed for Teams, raw for webapp). */
  text: string;
  context: AssembledContext;
  model: AIResponse["model"];
  /** Set when the pipeline handled an image generation request. */
  imageUrl?: string;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export async function runArcadiaPipeline(
  input: ArcadiaPipelineInput
): Promise<ArcadiaResponse> {
  const { mode, user, conversation, history, extraContext, env } = input;

  // 0. Image generation fast-path — skip context assembly for image requests.
  if (input.workerUrl && detectImageIntent(input.text)) {
    const imageResult = await generateAndStoreImage(input.text, env, input.workerUrl);
    if (imageResult) {
      const caption = "Here is the generated image:";
      const emptyContext: AssembledContext = {
        mode: "conversation",
        systemPrompt: "",
        memories: [],
        userProfile: null,
        channelMessages: [],
        activeTasks: [],
        tokenBudget: { total: 0, used: 0, remaining: 0 },
      };
      return { rawText: caption, text: caption, context: emptyContext, model: "cf-workers-ai", imageUrl: imageResult.url };
    }
    // If generation fails, fall through to normal text response
  }

  // 1. assembleContext — mode-specific base prompt, shared context engine.
  const basePrompt = await buildBasePrompt(input);
  const context = await assembleContext(
    input.text,
    user.id,
    conversation.channelId,
    conversation.teamId,
    "conversation",
    env,
    basePrompt,
    input.preloadedMessages,
  );

  // Compose final system prompt with optional extra context appended once.
  const systemPrompt = extraContext
    ? `${context.systemPrompt}\n\n${extraContext}`
    : context.systemPrompt;

  // 2. callAI — multi-turn with history.
  const userMessage = buildUserMessage(input);
  const aiResponse = await callModelWithHistory(systemPrompt, history, userMessage, env);

  // 3. formatResponse — trim AI text first, then always append context footer.
  const contextFooter = buildContextFooter(context, env.CF_AI_DEFAULT_MODEL, conversation.channelId === null, conversation.channelName);
  const trimmedText = mode === "teams-bot" ? trimForTeams(aiResponse.text) : aiResponse.text;
  const formatted = `${trimmedText}\n\n${contextFooter}`;

  // 4. recordMemory — fire-and-forget, respects MEMORY_ENABLED.
  scheduleMemoryRecording(input, userMessage, aiResponse.text);

  // 5. return ArcadiaResponse
  return {
    rawText: aiResponse.text,
    text: formatted,
    context,
    model: aiResponse.model,
  };
}

// ─── Base prompt selection ───────────────────────────────────────────────────

async function buildBasePrompt(input: ArcadiaPipelineInput): Promise<string> {
  const { mode, user, env } = input;

  if (mode === "webapp") {
    const profile = await resolveUserProfile(user.id, env).catch(() => null);
    const memories = await recallWebappMemories(user.id, input.text, env);
    return buildWebappSystemPrompt(
      user.displayName,
      user.isAdmin,
      profile,
      memories,
      "" // M365 context arrives via extraContext to avoid double-concat
    );
  }

  // teams-bot — DM/groupchat use the DM system prompt with profile insights.
  const profile = await resolveUserProfile(user.id, env).catch(() => null);
  return buildDMSystemPrompt(
    profile?.displayName ?? user.displayName ?? "there",
    user.isAdmin,
    profile?.insights ?? null
  );
}

async function recallWebappMemories(
  userId: string,
  query: string,
  env: Env
): Promise<Memory[]> {
  if (!features.memory(env)) return [];
  try {
    return await recallMemories(query, env, 5, { userId });
  } catch (err) {
    console.error("[Arcadia Pipeline] Webapp memory recall failed:", err);
    return [];
  }
}

// ─── User message shaping ────────────────────────────────────────────────────

function buildUserMessage(input: ArcadiaPipelineInput): string {
  // Group chats prefix speaker so the model can tell turns apart. DM/webapp
  // speak as themselves.
  if (input.mode === "teams-bot" && input.conversation.surface === "groupchat") {
    return `[${input.user.displayName}] ${input.text}`;
  }
  return input.text;
}

// ─── Model call ──────────────────────────────────────────────────────────────

async function callModelWithHistory(
  system: string,
  history: ConversationTurn[],
  userMessage: string,
  env: Env
): Promise<AIResponse> {
  type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
  const messages: ChatMsg[] = [
    { role: "system", content: system },
    ...history.slice(-AI.HISTORY_MAX_TURNS).map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    })),
    { role: "user", content: userMessage },
  ];

  const model = env.CF_AI_DEFAULT_MODEL;
  const result = await env.AI.run(model as Parameters<typeof env.AI.run>[0], {
    messages,
    max_tokens: AI.DEFAULT_MAX_TOKENS,
  } as Parameters<typeof env.AI.run>[1]);

  const text = extractCFAIText(result);
  if (!text) {
    console.error(
      `[Arcadia Pipeline] CF Workers AI returned empty response (${model}):`,
      JSON.stringify(result)
    );
    throw new Error(`CF Workers AI (${model}) returned empty response`);
  }
  return { text, model: "cf-workers-ai" };
}

// ─── Memory recording (fire-and-forget) ──────────────────────────────────────

function scheduleMemoryRecording(
  input: ArcadiaPipelineInput,
  userMessage: string,
  assistantText: string
): void {
  if (!features.memory(input.env)) return;

  const task =
    input.mode === "teams-bot"
      ? recordMemoriesFromInteraction(
          input.user.displayName,
          input.text,
          assistantText,
          input.conversation.channelName,
          input.user.id,
          input.conversation.channelId,
          input.env
        )
      : recordWebappInteractionMemory(input, userMessage, assistantText);

  const wrapped = task.catch((err) =>
    console.error("[Arcadia Pipeline] Memory recording failed:", err)
  );

  if (input.ctx) {
    input.ctx.waitUntil(wrapped);
  }
}

async function recordWebappInteractionMemory(
  input: ArcadiaPipelineInput,
  userMessage: string,
  assistantText: string
): Promise<void> {
  await recordMemory(
    "episodic",
    `[Webapp] ${input.user.displayName} asked: "${userMessage.slice(0, 200)}" — Arcadia responded with: "${assistantText.slice(0, 200)}"`,
    0.4,
    null,
    input.user.id,
    input.env
  );
}

// ─── Context debug footer ─────────────────────────────────────────────────────

/**
 * Build a compact footer injected at the end of every response so the user
 * can see exactly what context was fed to the model.
 *
 * @param context      The assembled context for this turn.
 * @param modelId      The CF Workers AI model string used.
 * @param isDMBroad    True when cross-channel context was loaded (DM mode).
 */
function buildContextFooter(context: AssembledContext, modelId: string, isDMBroad: boolean, channelName?: string): string {
  const { memories, channelMessages, userProfile, tokenBudget, mode } = context;

  const shortModel = modelId.split("/").pop() ?? modelId;
  const lines: string[] = [];

  lines.push(`🤖 **Model:** \`${shortModel}\`  |  **Mode:** \`${mode}\`  |  **Tokens:** ${tokenBudget.used.toLocaleString()} / ${tokenBudget.total.toLocaleString()} used`);

  lines.push("");
  lines.push("**🧠 Memories recalled:**");
  if (memories.length > 0) {
    for (const m of memories) {
      lines.push(`  • [${m.category}] ${m.content}`);
    }
  } else {
    lines.push("  • none");
  }

  lines.push("");
  const channelSource = isDMBroad ? "your active channels (cross-context DM)" : (channelName ?? "this channel");
  lines.push(`**💬 Context messages:** ${channelMessages.length > 0 ? `${channelMessages.length} messages from ${channelSource}` : "none"}`);
  if (channelMessages.length > 0) {
    for (const msg of channelMessages.slice(0, 10)) {
      const source = msg.channelName ?? channelName ?? "unknown";
      lines.push(`  • [${msg.timestamp.slice(0, 16)}] **#${source}** — ${msg.authorName}: ${msg.text.slice(0, 120)}`);
    }
    if (channelMessages.length > 10) {
      lines.push(`  • … and ${channelMessages.length - 10} more`);
    }
  }

  lines.push("");
  lines.push("**👤 User profile:**");
  if (userProfile) {
    lines.push(`  • Name: ${userProfile.displayName}`);
    const ins = userProfile.insights;
    if (ins?.communicationStyle?.summary) lines.push(`  • Style: ${ins.communicationStyle.summary}`);
    if (ins?.focusAreas?.primary?.length) lines.push(`  • Focus: ${ins.focusAreas.primary.join(", ")}`);
    if (ins?.workingPatterns?.responseStyle) lines.push(`  • Working pattern: ${ins.workingPatterns.responseStyle}`);
  } else {
    lines.push("  • no data");
  }

  return `---\n${lines.join("\n")}`;
}
