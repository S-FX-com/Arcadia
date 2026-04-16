// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Memory recording
//
// Fire-and-forget extraction of 0–3 long-term memories from a user↔Arcadia
// interaction. Gated by env.MEMORY_ENABLED. Called after every responded-to
// message from the bot handler.
// ─────────────────────────────────────────────────────────────────────────────

import { buildMemoryExtractionPrompt } from "../ai/prompts.js";
import { callAI } from "../ai/router.js";
import { recordMemory } from "../memory/long-term.js";
import { features } from "../features.js";
import type { Env, MemoryCategory } from "../types.js";

export async function recordMemoriesFromInteraction(
  userName: string,
  userMessage: string,
  arcadiaResponse: string,
  channelContext: string,
  userId: string | null,
  channelId: string | null,
  env: Env
): Promise<void> {
  if (!features.memory(env)) return;

  const { system, user } = buildMemoryExtractionPrompt(
    userName,
    userMessage,
    arcadiaResponse,
    channelContext
  );

  const response = await callAI(system, user, env);
  const raw = response.text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

  let extracted: Array<{ category: string; content: string; importance: number }> = [];
  try {
    extracted = JSON.parse(raw);
  } catch {
    return;
  }

  if (!Array.isArray(extracted)) return;

  const validCategories: MemoryCategory[] = ["episodic", "semantic", "procedural", "observation"];
  for (const mem of extracted.slice(0, 3)) {
    if (!mem.category || !mem.content) continue;
    if (!validCategories.includes(mem.category as MemoryCategory)) continue;

    await recordMemory(
      mem.category as MemoryCategory,
      mem.content,
      typeof mem.importance === "number" ? mem.importance : 0.5,
      channelId,
      userId,
      env
    );
  }
}
