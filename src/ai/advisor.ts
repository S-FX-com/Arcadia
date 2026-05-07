// ─────────────────────────────────────────────────────────────────────────────
// Arcadia — Advisor Pattern (Phase 10)
//
// Two-call advisor pattern for Workers AI. When the primary model's response
// shows uncertainty, a second pass with a meta-prompt refines the answer.
// This is the correct implementation for Workers AI — not the Anthropic SDK
// native advisor tool, which is unavailable here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, AIStreamOptions } from "../types.js";
import { getModel, type ModelPurpose } from "./model-registry.js";

const UNCERTAINTY_PATTERNS = [
  /i('m| am) not sure/i,
  /i don't (know|have)/i,
  /unclear/i,
  /cannot (determine|confirm)/i,
  /may (or may not)/i,
];

function hasUncertainty(text: string): boolean {
  return UNCERTAINTY_PATTERNS.some((p) => p.test(text));
}

type CFAIResult = {
  response?: string;
  text?: string;
  choices?: Array<{ message?: { content?: string } }>;
};

function extractText(result: unknown): string | undefined {
  const r = result as CFAIResult;
  return r.response ?? r.text ?? r.choices?.[0]?.message?.content ?? undefined;
}

async function cfRun(modelId: string, system: string, user: string, env: Env, opts: AIStreamOptions = {}): Promise<string> {
  const { runAI } = await import("./gateway.js");
  const result = await runAI(
    env,
    modelId as Parameters<typeof env.AI.run>[0],
    {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: opts.max_tokens ?? 2048,
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    } as Parameters<typeof env.AI.run>[1],
  );
  const text = extractText(result);
  if (!text) throw new Error(`Model ${modelId} returned empty response`);
  return text;
}

/**
 * Calls the model registered for `purpose`.
 * If the response shows uncertainty or `forceAdvisor=true`, a second review
 * pass with Gemma 4 refines it before returning.
 */
export async function callWithAdvisor(
  purpose: ModelPurpose,
  systemPrompt: string,
  userMessage: string,
  env: Env,
  options: { forceAdvisor?: boolean; aiOptions?: AIStreamOptions } = {},
): Promise<{ text: string; usedAdvisor: boolean }> {
  const config = getModel(purpose, env);
  const aiOpts = { ...options.aiOptions, max_tokens: options.aiOptions?.max_tokens ?? (config.maxTokens || 2048) };

  let primaryText: string;
  try {
    primaryText = await cfRun(config.modelId, systemPrompt, userMessage, env, aiOpts);
  } catch (err) {
    // Try fallback if available
    if (config.fallback) {
      console.warn(`[Arcadia Advisor] Primary model ${config.modelId} failed, trying fallback:`, err);
      primaryText = await cfRun(config.fallback, systemPrompt, userMessage, env, aiOpts);
    } else {
      throw err;
    }
  }

  const shouldAdvise = options.forceAdvisor || (config.useAdvisor && hasUncertainty(primaryText));

  if (!shouldAdvise) {
    return { text: primaryText, usedAdvisor: false };
  }

  // Advisor pass — always uses Gemma 4 as the review model
  const ADVISOR_MODEL = '@cf/google/gemma-4-27b-it';
  const advisorSystem = "You are a quality reviewer. Review the following AI response and provide a corrected, improved version with higher confidence and precision. Preserve all accurate information. Remove hedging language where the answer is actually deterministic. Be specific and direct.";
  const advisorUser = `Original question: ${userMessage}\n\nOriginal response:\n${primaryText}\n\nProvide an improved version:`;

  try {
    const advisorText = await cfRun(ADVISOR_MODEL, advisorSystem, advisorUser, env, { max_tokens: aiOpts.max_tokens });
    return { text: advisorText, usedAdvisor: true };
  } catch (err) {
    console.warn("[Arcadia Advisor] Advisor pass failed, returning primary response:", err);
    return { text: primaryText, usedAdvisor: false };
  }
}
