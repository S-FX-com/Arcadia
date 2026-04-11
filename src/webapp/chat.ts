// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Webapp Chat Handler (Phase 7)
//
// Core chat interaction: receives user messages, gathers M365 context,
// recalls memories, calls Workers AI (Gemma 4), persists conversation.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, ConversationTurn, Memory } from "../types.js";
import type { WebappSession, WebappChatRequest, WebappChatResponse, ContextRef, ContextSource } from "./types.js";
import { getSessionAccessToken } from "./auth.js";
import { createConversation, saveMessage, getRecentMessages, updateConversationTitle } from "./conversations.js";
import { buildWebappSystemPrompt, buildTitleGenerationPrompt } from "./prompts.js";
import { getUserTeams, getUserChats, getChannelMessages, getChatMessages } from "./context/teams.js";
import { getFollowedSites } from "./context/sharepoint.js";
import { getUserTasks } from "./context/planner.js";
import { callAIWithHistory, callAI } from "../ai/router.js";
import { isAdmin } from "./middleware.js";

/**
 * Handles a chat message from the webapp.
 * This is the core interaction loop: context gathering → AI call → persistence.
 */
export async function handleChat(
  session: WebappSession,
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<WebappChatResponse> {
  let body: WebappChatRequest;
  try {
    body = await request.json() as WebappChatRequest;
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

  // 5. Recall memories for this user
  const memories = await recallUserMemories(session.userId, userMessage, env);

  // 6. Load user profile
  let profile = null;
  try {
    const { resolveUserProfile } = await import("../intelligence/profiles.js");
    profile = await resolveUserProfile(session.userId, env);
  } catch {
    // Profile system may not have data for this user yet
  }

  // 7. Build system prompt
  const systemPrompt = buildWebappSystemPrompt(
    session.displayName,
    isAdmin(session.userId, env),
    profile,
    memories,
    contextText
  );

  // 8. Call Workers AI (Gemma 4) with conversation history
  const aiResponse = await callAIWithHistory(systemPrompt, history, userMessage, env, {
    max_tokens: 2048,
    temperature: 0.7,
  });

  // 9. Save assistant response
  await saveMessage(conversationId, "assistant", aiResponse.text, contextRefs.length > 0 ? contextRefs : null, env);

  // 10. Fire-and-forget: record memory + auto-title for new conversations
  ctx.waitUntil(postChatTasks(session, conversationId, userMessage, aiResponse.text, isNewConversation, env));

  return {
    conversationId,
    message: aiResponse.text,
    contextUsed: contextRefs,
  };
}

// ─── M365 Context Gathering ──────────────────────────────────────────────────

async function gatherM365Context(
  accessToken: string,
  sources: ContextSource[]
): Promise<{ contextText: string; contextRefs: ContextRef[] }> {
  if (sources.length === 0) return { contextText: "", contextRefs: [] };

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
      })()
    );
  }

  if (sources.includes("chats")) {
    promises.push(
      (async () => {
        try {
          const chats = await getUserChats(accessToken);
          if (chats.length > 0) {
            const chatSummaries = chats.slice(0, 10).map((c) =>
              c.topic ? `"${c.topic}" (${c.chatType})` : `${c.chatType} chat`
            );
            sections.push(`Recent Chats (${chats.length}): ${chatSummaries.join(", ")}`);
            for (const c of chats.slice(0, 5)) {
              refs.push({ type: "chat", id: c.id, title: c.topic ?? c.chatType });
            }
          }
        } catch (err) {
          console.error("[Arcadia Webapp] Chats context failed:", err);
        }
      })()
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
      })()
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
      })()
    );
  }

  await Promise.all(promises);

  return {
    contextText: sections.join("\n\n"),
    contextRefs: refs,
  };
}

// ─── Memory Recall ───────────────────────────────────────────────────────────

async function recallUserMemories(
  userId: string,
  query: string,
  env: Env
): Promise<Memory[]> {
  if (env.MEMORY_ENABLED !== "true") return [];

  try {
    const { recallMemories } = await import("../memory/long-term.js");
    return await recallMemories(query, env, 5, { userId });
  } catch (err) {
    console.error("[Arcadia Webapp] Memory recall failed:", err);
    return [];
  }
}

// ─── Post-Chat Tasks (fire-and-forget) ───────────────────────────────────────

async function postChatTasks(
  session: WebappSession,
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  isNewConversation: boolean,
  env: Env
): Promise<void> {
  // Auto-title new conversations
  if (isNewConversation) {
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

  // Record memory from this interaction
  if (env.MEMORY_ENABLED === "true") {
    try {
      const { recordMemory } = await import("../memory/long-term.js");
      // Record an episodic memory of the interaction
      await recordMemory(
        "episodic",
        `[Webapp] ${session.displayName} asked: "${userMessage.slice(0, 200)}" — Arcadia responded with: "${assistantResponse.slice(0, 200)}"`,
        0.4,
        null,
        session.userId,
        env
      );
    } catch (err) {
      console.error("[Arcadia Webapp] Memory recording failed:", err);
    }
  }
}
