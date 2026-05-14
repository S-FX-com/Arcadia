// Tiered AI router.
//
// The router exposes a single `complete()` entry point and picks the
// cheapest tier that can handle the request, cascading to the next tier
// on provider error. Tiers map to providers as follows:
//
//   fast      Cloudflare Workers AI (Gemma 4 26B). Free.
//   balanced  Anthropic Claude Haiku 4.5. Low cost.
//   deep      Anthropic Claude Sonnet 4.6. Higher quality.
//
// Auto-tier selection looks at total prompt characters when the caller
// doesn't specify a tier — small requests start on fast, mid-sized on
// balanced, large prompts go straight to deep.

import type { Env } from "../env";
import { AnthropicProvider } from "./providers/anthropic";
import { CloudflareProvider } from "./providers/cloudflare";
import type {
  CompleteRequest,
  CompleteResponse,
  Provider,
  Tier,
} from "./types";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SONNET_MODEL = "claude-sonnet-4-6";

const FAST_MAX_CHARS = 800;
const BALANCED_MAX_CHARS = 4000;

export class Router {
  private readonly fast: Provider;
  private readonly balanced: Provider;
  private readonly deep: Provider;

  constructor(env: Env) {
    this.fast = new CloudflareProvider(env);
    this.balanced = new AnthropicProvider(env, HAIKU_MODEL);
    this.deep = new AnthropicProvider(env, SONNET_MODEL);
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const start: Tier = req.tier ?? autoTier(req);
    const order = cascadeFrom(start);

    let lastError: unknown;
    for (const t of order) {
      try {
        return await this.providerFor(t).complete({ ...req, tier: t });
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`router_failed: ${String(lastError)}`);
  }

  private providerFor(tier: Tier): Provider {
    switch (tier) {
      case "fast":
        return this.fast;
      case "balanced":
        return this.balanced;
      case "deep":
        return this.deep;
    }
  }
}

function autoTier(req: CompleteRequest): Tier {
  const total =
    (req.system?.length ?? 0) +
    req.messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= FAST_MAX_CHARS) return "fast";
  if (total <= BALANCED_MAX_CHARS) return "balanced";
  return "deep";
}

function cascadeFrom(tier: Tier): Tier[] {
  switch (tier) {
    case "fast":
      return ["fast", "balanced", "deep"];
    case "balanced":
      return ["balanced", "deep"];
    case "deep":
      return ["deep"];
  }
}
