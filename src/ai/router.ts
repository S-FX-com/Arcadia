// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — AI Model Router
//
// Selects the appropriate model tier based on estimated token count:
//   < 4,000 tokens  → Cloudflare Workers AI (fast, no external cost)
//   < 16,000 tokens → Claude Haiku (cost-efficient)
//   16,000+ tokens  → Claude Sonnet (complex reasoning, highest quality)
//
// Falls back to the next tier if a model call fails.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import type { AIResponse, Env, ModelTier } from "../types.js";

const CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const CLAUDE_HAIKU = "claude-haiku-4-5-20251001";
const CLAUDE_SONNET = "claude-sonnet-4-6";

/**
 * Rough token estimator — approximately 4 chars per token for English.
 * Conservative estimate to avoid tier misrouting.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function selectTier(systemPrompt: string, userPrompt: string): ModelTier {
  const totalTokens = estimateTokens(systemPrompt + userPrompt);
  if (totalTokens < 4000) return "cf-workers-ai";
  if (totalTokens < 16000) return "claude-haiku";
  return "claude-sonnet";
}

// ─── Cloudflare Workers AI ────────────────────────────────────────────────────

async function callCFWorkersAI(
  system: string,
  user: string,
  env: Env
): Promise<string> {
  const result = await env.AI.run(CF_AI_MODEL as Parameters<typeof env.AI.run>[0], {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 1024,
  } as Parameters<typeof env.AI.run>[1]);

  // Workers AI returns { response: string } for text generation
  const r = result as { response?: string };
  if (!r.response) throw new Error("CF Workers AI returned empty response");
  return r.response;
}

// ─── Anthropic Claude ─────────────────────────────────────────────────────────

async function callClaude(
  system: string,
  user: string,
  model: "claude-haiku" | "claude-sonnet",
  env: Env
): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const modelId = model === "claude-haiku" ? CLAUDE_HAIKU : CLAUDE_SONNET;

  const message = await client.messages.create({
    model: modelId,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });

  const block = message.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return block.text;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Route an AI call to the appropriate model tier.
 * Automatically falls back up the tier chain on failure.
 */
export async function callAI(
  system: string,
  user: string,
  env: Env
): Promise<AIResponse> {
  const tier = selectTier(system, user);
  const inputTokens = estimateTokens(system + user);

  // CF Workers AI
  if (tier === "cf-workers-ai") {
    try {
      const text = await callCFWorkersAI(system, user, env);
      return { text, model: "cf-workers-ai", inputTokens };
    } catch (err) {
      console.warn("CF Workers AI failed, falling back to Claude Haiku:", err);
      // fall through to Haiku
    }
  }

  // Claude Haiku
  if (tier === "cf-workers-ai" || tier === "claude-haiku") {
    try {
      const text = await callClaude(system, user, "claude-haiku", env);
      return { text, model: "claude-haiku", inputTokens };
    } catch (err) {
      console.warn("Claude Haiku failed, falling back to Claude Sonnet:", err);
      // fall through to Sonnet
    }
  }

  // Claude Sonnet (final tier — let errors propagate)
  const text = await callClaude(system, user, "claude-sonnet", env);
  return { text, model: "claude-sonnet", inputTokens };
}
