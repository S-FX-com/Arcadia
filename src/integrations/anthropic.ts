// Anthropic via AI Gateway (§6). Never call api.anthropic.com directly —
// the gateway is where caching, rate limiting, and per-call cost
// observability live, which is how the monthly spend ceiling gets enforced
// rather than hoped for.

import Anthropic from "@anthropic-ai/sdk";

export interface AnthropicEnv {
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  /** Set when the gateway has Authenticated Gateway toggled on. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * Advisor model override. The spec named claude-opus-4-6, but the advisor
   * tool only accepts advisors at least as capable as the executor from its
   * published pairing table, which does not include opus-4-6 — an
   * opus-4-6 advisor on a sonnet-4-6 executor is rejected with a 400.
   * claude-opus-4-7 is the nearest accepted model at the same price.
   */
  OPUS_ADVISOR_MODEL?: string;
}

// Model routing (§6): sweeps/extraction/verification → Haiku; drafting and
// synthesis → Sonnet; doctrine conflicts and novel judgment → Opus, reached
// through the advisor tool rather than by routing whole requests.
export const MODEL_FAST = "claude-haiku-4-5";
export const MODEL_BALANCED = "claude-sonnet-4-6";
export const DEFAULT_ADVISOR_MODEL = "claude-opus-4-7";

const ADVISOR_BETA = "advisor-tool-2026-03-01";

export function gatewayClient(env: AnthropicEnv): Anthropic {
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

export interface CompleteOpts {
  system?: string;
  prompt?: string;
  messages?: Anthropic.MessageParam[];
  maxTokens?: number;
  /** Attached as cf-aig-metadata for per-call cost attribution in gateway analytics. */
  metadata?: Record<string, string>;
}

function toMessages(opts: CompleteOpts): Anthropic.MessageParam[] {
  if (opts.messages) return opts.messages;
  if (opts.prompt) return [{ role: "user", content: opts.prompt }];
  throw new Error("complete() needs prompt or messages");
}

function aigHeaders(metadata?: Record<string, string>): Record<string, string> {
  return metadata ? { "cf-aig-metadata": JSON.stringify(metadata) } : {};
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function complete(env: AnthropicEnv, model: string, opts: CompleteOpts): Promise<string> {
  const client = gatewayClient(env);
  const response = await client.messages.create(
    {
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.system ? { system: opts.system } : {}),
      messages: toMessages(opts),
    },
    { headers: aigHeaders(opts.metadata) }
  );
  if (response.stop_reason === "refusal") {
    throw new Error(`Anthropic refused (${model}): ${response.stop_details?.explanation ?? "no explanation"}`);
  }
  return textOf(response);
}

/** Stall sweeps, extraction, classification, verification. */
export const haiku = (env: AnthropicEnv, opts: CompleteOpts) => complete(env, MODEL_FAST, opts);

/** Drafting, summaries, digests, synthesis, Hermes articles. */
export const sonnet = (env: AnthropicEnv, opts: CompleteOpts) => complete(env, MODEL_BALANCED, opts);

/**
 * The advisor pattern (§6): Sonnet executes, Opus advises mid-generation on
 * doctrine conflicts, client/contract/financial exposure, and uncited Shane
 * positions. Cheaper than routing whole requests to Opus.
 */
export async function sonnetWithAdvisor(env: AnthropicEnv, opts: CompleteOpts): Promise<string> {
  const client = gatewayClient(env);
  const advisorModel = env.OPUS_ADVISOR_MODEL ?? DEFAULT_ADVISOR_MODEL;
  const response = await client.beta.messages.create(
    {
      model: MODEL_BALANCED,
      max_tokens: opts.maxTokens ?? 4096,
      betas: [ADVISOR_BETA],
      ...(opts.system ? { system: opts.system } : {}),
      // SDK typings lag the advisor tool shape; the wire format is authoritative.
      tools: [
        {
          type: "advisor_20260301",
          name: "advisor",
          model: advisorModel,
          max_uses: 2,
        },
      ] as unknown as Anthropic.Beta.BetaToolUnion[],
      messages: toMessages(opts) as Anthropic.Beta.BetaMessageParam[],
    },
    { headers: aigHeaders(opts.metadata) }
  );
  if (response.stop_reason === "refusal") {
    throw new Error(`Anthropic refused (advisor): no advisor output returned`);
  }
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Arcadia's core system framing (§6). Call-site prompts append task-specific
 * instructions; the escalation rule is non-negotiable — never improvise a
 * Shane opinion.
 */
export const ARCADIA_SYSTEM_CORE = `You are Arcadia, the S-FX operations layer.
Answer from doctrine memory in Shane's voice: direct, short declarative
sentences, no hedging, specific numbers over vague adjectives.

Call the advisor when:
- Doctrine conflicts or doesn't cover the situation
- The decision has client, contract, or financial exposure
- You are about to state a Shane position you cannot cite doctrine for

Never improvise a Shane opinion. If you can't cite it and the advisor
can't resolve it, escalate to Shane and log the gap.`;
