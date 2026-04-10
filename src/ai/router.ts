// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — AI Model Router
//
// Uses Cloudflare Workers AI (Gemma 4 26B) for all inference.
// ─────────────────────────────────────────────────────────────────────────────

import type { AIResponse, AIStreamOptions, Env } from "../types.js";

/** Default Cloudflare Workers AI model — Gemma 4 26B Instruction-tuned */
export const CF_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

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

  const r = result as { response?: string };
  if (!r.response) throw new Error("CF Workers AI returned empty response");
  return r.response;
}

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
    throw new Error("CF Workers AI did not return a ReadableStream when stream:true was requested");
  }
  return result;
}

export async function callAI(
  system: string,
  user: string,
  env: Env
): Promise<AIResponse> {
  const text = await callCFWorkersAI(system, user, env);
  return { text, model: "cf-workers-ai" };
}

export async function callAIStream(
  system: string,
  user: string,
  env: Env,
  options: AIStreamOptions = {}
): Promise<ReadableStream> {
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
