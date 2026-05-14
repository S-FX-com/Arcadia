// Tiered AI router.
//
// Picks the cheapest tier that can handle the request, cascading upward
// on error. If the caller doesn't set a tier, we estimate by total
// prompt length:
//   < 4k tokens  → fast
//   < 16k tokens → balanced
//   ≥ 16k tokens → deep

import type { Env } from "../env";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
  StreamChunk,
  Tier,
} from "./types";
import { AnthropicProvider } from "./providers/anthropic";
import { CloudflareProvider } from "./providers/cloudflare";

const CHARS_PER_TOKEN = 4;

function estimateTokens(req: CompleteRequest): number {
  const text = [req.system ?? "", ...req.messages.map((m) => m.content)].join(
    "",
  );
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function pickTier(req: CompleteRequest): Tier {
  if (req.tier) return req.tier;
  const t = estimateTokens(req);
  if (t < 4_000) return "fast";
  if (t < 16_000) return "balanced";
  return "deep";
}

function cascade(start: Tier): Tier[] {
  switch (start) {
    case "fast":
      return ["fast", "balanced", "deep"];
    case "balanced":
      return ["balanced", "deep"];
    case "deep":
      return ["deep"];
  }
}

export class Router {
  private readonly providers: Record<Tier, Provider>;

  constructor(env: Env) {
    this.providers = {
      fast: new CloudflareProvider(env),
      balanced: new AnthropicProvider(env, "claude-haiku-4-5-20251001"),
      deep: new AnthropicProvider(env, "claude-sonnet-4-6"),
    };
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const order = cascade(pickTier(req));
    let lastErr: unknown;
    for (const tier of order) {
      try {
        return await this.providers[tier].complete({ ...req, tier });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("router_all_tiers_failed");
  }

  stream(req: CompleteRequest): AsyncIterable<StreamChunk> {
    const tier = pickTier(req);
    const provider = this.providers[tier];
    if (!provider.stream) {
      throw new Error(`stream_not_supported: ${tier}`);
    }
    return provider.stream({ ...req, tier });
  }
}
