// Anthropic provider, always via AI Gateway (§6). Never call
// api.anthropic.com directly — the gateway is where caching, rate limiting,
// and per-call cost observability live, which is how the monthly spend
// ceiling gets enforced rather than hoped for.
//
// Arcadia defaults to Workers AI; this path runs only for tasks an admin has
// routed to Anthropic. Call sites go through src/ai/router.ts, not this file.

import Anthropic from "@anthropic-ai/sdk";
import type { CompleteOptions } from "../ai/types";
import { CLAUDE_ADVISOR, CLAUDE_BALANCED } from "../ai/types";

export interface AnthropicEnv {
  /** Optional: Arcadia defaults to Workers AI, so this may be unset. */
  ANTHROPIC_API_KEY?: string | undefined;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  /** Set when the gateway has Authenticated Gateway toggled on. */
  AI_GATEWAY_TOKEN?: string | undefined;
  /** Overrides the advisor model used by the judgment tier. */
  OPUS_ADVISOR_MODEL?: string | undefined;
}

const ADVISOR_BETA = "advisor-tool-2026-03-01";

export function gatewayClient(env: AnthropicEnv): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Arcadia defaults to Workers AI — either route this task back to Workers AI in admin, or add the secret."
    );
  }
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`,
    // cf-aig-authorization is the gateway-auth header on provider-native
    // endpoints; only needed when the gateway runs in authenticated mode.
    ...(env.AI_GATEWAY_TOKEN
      ? { defaultHeaders: { "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}` } }
      : {}),
  });
}

function aigHeaders(metadata?: Record<string, string>): Record<string, string> {
  return metadata ? { "cf-aig-metadata": JSON.stringify(metadata) } : {};
}

function messagesFrom(opts: CompleteOptions): Anthropic.MessageParam[] {
  if (!opts.prompt) throw new Error("anthropic provider needs a prompt");
  return [{ role: "user", content: opts.prompt }];
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export async function anthropicComplete(
  env: AnthropicEnv,
  model: string,
  opts: CompleteOptions & { maxTokens: number }
): Promise<string> {
  const client = gatewayClient(env);
  const response = await client.messages.create(
    {
      model,
      max_tokens: opts.maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: messagesFrom(opts),
    },
    { headers: aigHeaders(opts.metadata) }
  );
  if (response.stop_reason === "refusal") {
    throw new Error(`Anthropic refused (${model}): ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  return textOf(response);
}

/**
 * The advisor pattern (§6): Sonnet executes, Opus advises mid-generation on
 * doctrine conflicts, client/contract/financial exposure, and uncited Shane
 * positions. Cheaper than routing whole requests to Opus.
 */
export async function advisorComplete(
  env: AnthropicEnv,
  opts: CompleteOptions & { maxTokens: number }
): Promise<string> {
  const client = gatewayClient(env);
  const advisorModel = env.OPUS_ADVISOR_MODEL ?? CLAUDE_ADVISOR;
  const response = await client.beta.messages.create(
    {
      model: CLAUDE_BALANCED,
      max_tokens: opts.maxTokens,
      betas: [ADVISOR_BETA],
      ...(opts.system ? { system: opts.system } : {}),
      // SDK typings lag the advisor tool shape; the wire format is authoritative.
      tools: [
        { type: "advisor_20260301", name: "advisor", model: advisorModel, max_uses: 2 },
      ] as unknown as Anthropic.Beta.BetaToolUnion[],
      messages: messagesFrom(opts) as Anthropic.Beta.BetaMessageParam[],
    },
    { headers: aigHeaders(opts.metadata) }
  );
  if (response.stop_reason === "refusal") {
    throw new Error("Anthropic refused (advisor): no output returned");
  }
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Arcadia's core system framing (§6/§7). Call-site prompts append
 * task-specific instructions; the escalation rule is non-negotiable — never
 * improvise a Shane opinion.
 */
export const ARCADIA_SYSTEM_CORE = `You are Arcadia, S-FX's virtual assistant and operations layer.
Write in Shane's voice: direct, short declarative sentences, no hedging,
specific numbers over vague adjectives.

You answer in one of two modes, and you state the mode every time:
- Cited — ratified doctrine covers the question. Quote the entries.
- Inferred — doctrine does not cover it. Give a usable read on how Shane
  would handle it so the Specialist can keep moving. Label it Inferred.

Inferred is not an autonomous action. Drafts, coaching, and next steps are
allowed. Never invent a number, date, price, or client fact.

Never: send to a client, publish to a live site, modify a file, write
canonical doctrine, take an HR action, or overrule a human.`;
