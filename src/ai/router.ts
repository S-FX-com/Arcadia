// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — AI Model Router
//
// Selects the appropriate model tier based on estimated token count:
//   < 4,000 tokens  → Cloudflare Workers AI / Gemma 4 26B (fast, no external cost)
//   < 16,000 tokens → Claude Haiku (cost-efficient)
//   16,000+ tokens  → Claude Sonnet (complex reasoning, highest quality)
//
// Falls back to the next tier if a model call fails.
// Streaming is supported for the CF Workers AI tier via callAIStream().
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import type { AIResponse, AIStreamOptions, Env, ModelTier } from "../types.js";

/** Default Cloudflare Workers AI model — Gemma 4 26B Instruction-tuned */
export const CF_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

const CLAUDE_HAIKU = "claude-haiku-4-5-20251001";
const CLAUDE_SONNET = "claude-sonnet-4-6";

/**
 * Rough token estimator — approximately 3.5 chars per token for English.
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

// ─── Cloudflare Workers AI — Gemma 4 ─────────────────────────────────────────

async function callCFWorkersAI(
  system: string,
  user: string,
  env: Env,
  options: AIStreamOptions = {}
): Promise<string> {
  const result = await env.AI.run(CF_AI_MODEL as Parameters<typeof env.AI.run>[0], {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: options.max_tokens ?? 1024,
    ...(options.temperature !== undefined && { temperature: options.temperature }),
  } as Parameters<typeof env.AI.run>[1]);

  // Workers AI returns { response: string } for text generation models
  const r = result as { response?: string };
  if (!r.response) throw new Error("CF Workers AI returned empty response");
  return r.response;
}

/**
 * Stream a response from Cloudflare Workers AI (Gemma 4 26B).
 *
 * Returns a ReadableStream of SSE chunks. Pass it directly as the Response body:
 *
 *   const stream = await callCFWorkersAIStream(system, user, env);
 *   return new Response(stream, {
 *     headers: { "content-type": "text/event-stream" },
 *   });
 *
 * Each SSE chunk has the shape: `data: {"response":"…"}\n\n`
 * The stream ends with:          `data: [DONE]\n\n`
 */
export async function callCFWorkersAIStream(
  system: string,
  user: string,
  env: Env,
  options: AIStreamOptions = {}
): Promise<ReadableStream> {
  const result = await env.AI.run(CF_AI_MODEL as Parameters<typeof env.AI.run>[0], {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    max_tokens: options.max_tokens ?? 1024,
    ...(options.temperature !== undefined && { temperature: options.temperature }),
  } as Parameters<typeof env.AI.run>[1]);

  if (!(result instanceof ReadableStream)) {
    throw new Error(
      "CF Workers AI did not return a ReadableStream when stream:true was requested"
    );
  }
  return result;
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
 * CF Workers AI tier uses Gemma 4 26B by default.
 * Automatically falls back up the tier chain on failure.
 */
export async function callAI(
  system: string,
  user: string,
  env: Env
): Promise<AIResponse> {
  const tier = selectTier(system, user);
  const inputTokens = estimateTokens(system + user);

  // CF Workers AI (Gemma 4 26B)
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

/**
 * Stream an AI response via Cloudflare Workers AI (Gemma 4 26B).
 *
 * Returns a ReadableStream of SSE chunks for direct use as a Response body.
 * On failure, falls back to a non-streaming callAI call and wraps the result
 * in a synthetic SSE stream so callers always receive a ReadableStream.
 *
 * Usage:
 *   const stream = await callAIStream(system, user, env);
 *   return new Response(stream, {
 *     headers: { "content-type": "text/event-stream" },
 *   });
 */
export async function callAIStream(
  system: string,
  user: string,
  env: Env,
  options: AIStreamOptions = {}
): Promise<ReadableStream> {
  try {
    return await callCFWorkersAIStream(system, user, env, options);
  } catch (err) {
    console.warn(
      "CF Workers AI stream failed, falling back to non-streaming response:",
      err
    );
    const response = await callAI(system, user, env);
    // Wrap the plain-text result in a minimal SSE envelope so the return type
    // is consistent and callers can always do `new Response(stream, ...)`.
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
