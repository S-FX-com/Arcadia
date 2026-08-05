// Workers AI provider. Calls go through the AI Gateway binding option so
// per-call cost and latency stay visible in gateway analytics — the same
// observability §6 requires of the Anthropic path, which is how the monthly
// spend ceiling gets enforced rather than hoped for.

import type { CompleteOptions } from "./types";
import { WA_EMBEDDING, WA_TRANSCRIPTION } from "./types";

interface WorkersAiChatInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens: number;
  response_format?: { type: "json_schema"; json_schema: Record<string, unknown> };
}

interface WorkersAiChatOutput {
  response?: string;
  usage?: Record<string, number>;
}

interface GatewayOptions {
  gateway?: { id: string; metadata?: Record<string, string> };
}

function gatewayFor(env: Env, metadata?: Record<string, string>): GatewayOptions {
  if (!env.AI_GATEWAY_ID) return {};
  return {
    gateway: {
      id: env.AI_GATEWAY_ID,
      ...(metadata ? { metadata } : {}),
    },
  };
}

export async function workersAiComplete(env: Env, model: string, opts: CompleteOptions & { maxTokens: number }): Promise<string> {
  const messages: WorkersAiChatInput["messages"] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (opts.prompt) messages.push({ role: "user", content: opts.prompt });
  if (messages.length === 0) throw new Error("workersAiComplete needs a system or user message");

  const input: WorkersAiChatInput = {
    messages,
    max_tokens: opts.maxTokens,
    ...(opts.jsonSchema ? { response_format: { type: "json_schema" as const, json_schema: opts.jsonSchema } } : {}),
  };

  let result: WorkersAiChatOutput;
  try {
    result = (await env.AI.run(
      model as Parameters<Ai["run"]>[0],
      input as never,
      gatewayFor(env, opts.metadata) as never
    )) as WorkersAiChatOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Structured-output rejection is recoverable: retry once as free prose and
    // let the caller's tolerant JSON parser do the work.
    if (opts.jsonSchema && /json/i.test(message)) {
      const { jsonSchema: _dropped, ...rest } = opts;
      return workersAiComplete(env, model, { ...rest, maxTokens: opts.maxTokens });
    }
    throw new Error(`Workers AI ${model} failed: ${message}`);
  }

  const text = result.response ?? "";
  if (!text.trim()) throw new Error(`Workers AI ${model} returned an empty response`);
  return text;
}

/** 768-dim embeddings for Vectorize. Batches are returned in input order. */
export async function workersAiEmbed(env: Env, texts: string[]): Promise<number[][]> {
  const resp = (await env.AI.run(
    WA_EMBEDDING as Parameters<Ai["run"]>[0],
    { text: texts.map((t) => t.slice(0, 4000)) } as never,
    gatewayFor(env, { job: "embedding" }) as never
  )) as { shape: number[]; data: number[][] };
  if (!resp.data || resp.data.length !== texts.length) {
    throw new Error(`embedding batch mismatch: asked ${texts.length}, got ${resp.data?.length ?? 0}`);
  }
  return resp.data;
}

/** Voice deposits for capture channel A (§5.5). Audio must be base64. */
export async function workersAiTranscribe(env: Env, base64Audio: string): Promise<string> {
  const resp = (await env.AI.run(
    WA_TRANSCRIPTION as Parameters<Ai["run"]>[0],
    { audio: base64Audio } as never,
    gatewayFor(env, { job: "transcription" }) as never
  )) as { text?: string };
  const text = resp.text ?? "";
  if (!text.trim()) throw new Error("transcription returned no text");
  return text;
}
